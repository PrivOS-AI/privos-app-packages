/**
 * Orchestrates hub turns against one session runner: per-sessionKey FIFO
 * bookkeeping (5-pending cap -> `harness_busy`), deadline-before-start
 * handling, `turn.cancel` routing, and mapping ACP streaming events to the
 * `turn.chunk`/`turn.tool_use`/`turn.activity`/`turn.done` notifications.
 *
 * Phase 4 baseline: one global FIFO drained by a single `AcpSession` (the AI + human chat platform
 * parity — "one agent subprocess drains channels FIFO"). Phase 8 replaces
 * that with a per-room pool (`AdapterPool`) — this class never rewired: it
 * only ever calls `runTurn`/`cancelTurn` on whatever `SessionRunner` it was
 * given (the seam), and `AdapterPool` satisfies the same shape by routing
 * internally on `input.roomId`. Rooms run concurrently ONLY across processes —
 * each room is its own adapter process with its own `TurnRunner`. Within a
 * single `TurnRunner` execution stays strictly serial (`runLoop` awaits each
 * `executeTurn`), so `currentTurnId` holds the one running turn; `onTurnSteer`
 * relies on that invariant. If a future change ever lets two turns run inside
 * one `TurnRunner`, replace the `currentTurnId` gate with the authoritative
 * `turnId→room` pool map (already used by `cancelTurn`).
 */
import type { RunTurnInput, RunTurnResult, SteerAck } from './acp/acp-session.js';
import type { PermissionPolicy } from './acp/permission-policy.js';
import {
	HarnessBusyError,
	type AgentHarnessSteerAckOutcome,
	type AgentHarnessTurnStartParams,
	type AgentHarnessTurnSteerParams,
	type HubRelayClient,
	SOCKET_LOSS_CANCEL_MS,
} from './hub-relay-client.js';
import { getSession, resetAllSessions, setSession } from './session-store.js';
import { extractSystemIdentity } from './prompt-frame.js';
import { writeIdentityFile } from './skills-installer.js';

const MAX_PENDING_PER_SESSION_KEY = 5;

interface QueuedTurn {
	params: AgentHarnessTurnStartParams;
}

/** The shape `TurnRunner` needs — satisfied by both `AcpSession` (Phase 4) and `AdapterPool` (Phase 8). */
export interface SessionRunner {
	runTurn(input: RunTurnInput): Promise<RunTurnResult>;
	cancelTurn(turnId: string): void;
	/** Phase-04 mid-turn steer — synchronous ack (`notRunning`/`unsupported` decided immediately; `accepted` carries a promise for the later `injected`/`dropped` outcome). `notRunning` covers BOTH an unknown turnId and a still-queued one (never steered). */
	steer(turnId: string, text: string, deadlineMs: number): SteerAck;
}

export interface TurnRunnerOptions {
	agentId: string;
	session: SessionRunner;
	policy: PermissionPolicy;
	idleTimeoutMs: number;
	verbose?: boolean;
	/** Recorded alongside each session-store entry for `status`/`doctor` diagnostics only. */
	adapterId?: string;
	/** Static cwd, recorded verbatim when `roomDir` is not supplied (Phase 4 single-workspace behaviour). */
	cwd?: string;
	/** Phase 8: computes the actual per-room cwd for the session-store record from `params.roomId`. Takes precedence over the static `cwd` above when supplied. */
	roomDir?: (roomId: string) => string;
	/** Phase 8: when set, a turn whose prompt carries a `<system_identity>` block refreshes `<workspaceDir>/IDENTITY.md` from it (D1). Omitted in Phase 4 tests and callers -> no-op. */
	workspaceDir?: string;
}

export class TurnRunner {
	private readonly opts: TurnRunnerOptions;
	private relay: HubRelayClient | undefined;
	private readonly queue: QueuedTurn[] = [];
	private readonly pendingCounts = new Map<string, number>();
	private loopRunning = false;
	private currentTurnId: string | undefined;
	private socketLossTimer: NodeJS.Timeout | undefined;

	constructor(opts: TurnRunnerOptions) {
		this.opts = opts;
	}

	/** Wires the relay this runner notifies; called once the relay client exists. */
	attachRelay(relay: HubRelayClient): void {
		this.relay = relay;
	}

	onConnectionChange(connected: boolean): void {
		if (connected) {
			if (this.socketLossTimer) clearTimeout(this.socketLossTimer);
			this.socketLossTimer = undefined;
			return;
		}
		if (!this.currentTurnId || this.socketLossTimer) return;
		this.socketLossTimer = setTimeout(() => {
			// The hub has been unreachable long enough that it will have given up
			// on this turn independently; cancel locally so the adapter is not
			// left running for a turn nobody is waiting on.
			if (this.currentTurnId) this.opts.session.cancelTurn(this.currentTurnId);
		}, SOCKET_LOSS_CANCEL_MS);
		this.socketLossTimer.unref?.();
	}

	async onTurnStart(params: AgentHarnessTurnStartParams): Promise<{ accepted: true; queued: number }> {
		const pendingForKey = this.pendingCounts.get(params.sessionKey) ?? 0;
		if (pendingForKey >= MAX_PENDING_PER_SESSION_KEY) throw new HarnessBusyError();
		this.pendingCounts.set(params.sessionKey, pendingForKey + 1);
		this.queue.push({ params });
		this.pump();
		return { accepted: true, queued: pendingForKey };
	}

	/**
	 * Routes a `turn.steer` to the room's in-flight prompt. Only the
	 * CURRENTLY RUNNING turn can ever be steered — a queued (not yet started)
	 * turn answers `notRunning` here, never reaching `session.steer` at all
	 * (phase-04 "a queued turn is never steered"). The final `injected`/
	 * `dropped` outcome is reported asynchronously via `turn.steer-result`
	 * once `session.steer`'s own promise settles.
	 */
	async onTurnSteer(params: AgentHarnessTurnSteerParams): Promise<{ outcome: AgentHarnessSteerAckOutcome }> {
		if (this.currentTurnId !== params.turnId) return { outcome: 'notRunning' };

		const ack: SteerAck = this.opts.session.steer(params.turnId, params.text, params.deadlineMs);
		if (ack.outcome !== 'accepted') return { outcome: ack.outcome };

		void ack.result
			.then((outcome) => this.relay?.notify('turn.steer-result', { turnId: params.turnId, steerId: params.steerId, outcome }))
			.catch(() => this.relay?.notify('turn.steer-result', { turnId: params.turnId, steerId: params.steerId, outcome: 'dropped' }));
		return { outcome: 'accepted' };
	}

	onTurnCancel({ turnId }: { turnId: string }): void {
		if (this.currentTurnId === turnId) {
			this.opts.session.cancelTurn(turnId);
			return;
		}
		const index = this.queue.findIndex((item) => item.params.turnId === turnId);
		if (index === -1) return;
		const [removed] = this.queue.splice(index, 1);
		if (!removed) return;
		this.decrementPending(removed.params.sessionKey);
		this.relay?.notify('turn.done', { turnId, status: 'cancelled', text: '', sessionFresh: false });
	}

	onResetSessions(): void {
		resetAllSessions(this.opts.agentId);
	}

	private decrementPending(sessionKey: string): void {
		const current = this.pendingCounts.get(sessionKey) ?? 0;
		if (current <= 1) this.pendingCounts.delete(sessionKey);
		else this.pendingCounts.set(sessionKey, current - 1);
	}

	private pump(): void {
		if (this.loopRunning) return;
		this.loopRunning = true;
		void this.runLoop().finally(() => {
			this.loopRunning = false;
		});
	}

	private async runLoop(): Promise<void> {
		for (;;) {
			const item = this.queue.shift();
			if (!item) return;
			const { params } = item;

			if (Date.now() >= params.deadlineMs) {
				this.decrementPending(params.sessionKey);
				this.relay?.notify('turn.done', {
					turnId: params.turnId,
					status: 'failed',
					text: '',
					errorMessage: 'queued past deadline',
					sessionFresh: false,
				});
				continue;
			}

			this.currentTurnId = params.turnId;
			await this.executeTurn(params);
			this.currentTurnId = undefined;
			this.decrementPending(params.sessionKey);
		}
	}

	private async executeTurn(params: AgentHarnessTurnStartParams): Promise<void> {
		const saved = getSession(this.opts.agentId, params.sessionKey);
		const senderName = params.sender.name || params.sender.username || params.sender._id;

		if (this.opts.workspaceDir) {
			const identity = extractSystemIdentity(params.promptFull) ?? extractSystemIdentity(params.prompt);
			if (identity !== undefined) writeIdentityFile(this.opts.workspaceDir, identity);
		}

		let result: RunTurnResult;
		try {
			result = await this.opts.session.runTurn({
			turnId: params.turnId,
			sessionKey: params.sessionKey,
			roomId: params.roomId,
			threadId: params.threadId,
			senderName,
			prompt: params.prompt,
			promptFull: params.promptFull,
			resume: params.resume,
			savedSessionId: saved?.acpSessionId,
			policy: this.opts.policy,
			idleTimeoutMs: this.opts.idleTimeoutMs,
			deadlineMs: params.deadlineMs,
			onChunk: (chunk, index) => {
				this.relay?.notify('turn.chunk', { turnId: params.turnId, chunk, index, isComplete: false });
			},
			onToolUse: (toolUse) => {
				this.relay?.notify('turn.tool_use', { turnId: params.turnId, ...toolUse });
			},
			onActivity: (activity) => {
				this.relay?.notify('turn.activity', { turnId: params.turnId, ...activity, timestamp: new Date().toISOString() });
			},
			});
		} catch (error) {
			// Adapter failed to start (binary missing, sandbox wrapper refused,
			// ...) — report it as a failed turn so the hub does not wait out the
			// deadline, and keep the queue loop alive (an uncaught rejection here
			// would take the whole bridge down).
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[agent-harness] turn ${params.turnId} failed before the adapter answered: ${message}\n`);
			this.relay?.notify('turn.done', { turnId: params.turnId, status: 'failed', text: '', errorMessage: message, sessionFresh: false });
			return;
		}

		const cwd = this.opts.roomDir ? this.opts.roomDir(params.roomId) : this.opts.cwd;
		setSession(this.opts.agentId, params.sessionKey, result.acpSessionId, { adapter: this.opts.adapterId, cwd });
		this.relay?.notify('turn.done', {
			turnId: params.turnId,
			status: result.status,
			text: result.text,
			...(result.errorMessage !== undefined && { errorMessage: result.errorMessage }),
			sessionFresh: result.sessionFresh,
		});
	}
}
