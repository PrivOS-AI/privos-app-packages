/**
 * Drives one persistent ACP adapter subprocess over stdio. Phase 4 baseline:
 * a single adapter process serves every `sessionKey` (AI + human chat parity — "one
 * agent subprocess drains channels FIFO"); turn-runner.ts enforces the FIFO
 * ordering and only ever has one turn in flight against this class at a time.
 * Phase 8 replaces this with a per-room pool; the seam is `AcpSession` itself
 * — turn-runner.ts talks to it through `runTurn`/`cancelTurn`/`dispose` only,
 * so a pool of these can be substituted without changing callers.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable } from 'node:stream';
import {
	client,
	ndJsonStream,
	PROTOCOL_VERSION,
	type AgentCapabilities,
	type ClientContext,
	type ContentBlock,
	type InitializeResponse,
	type NewSessionRequest,
	type PermissionOption,
	type SessionUpdate,
	type Stream,
	type StopReason,
	type ToolKind,
} from '@agentclientprotocol/sdk';
import type { AdapterSpec } from './adapter-table.js';
import { decidePermission, type PermissionPolicy } from './permission-policy.js';
import { buildStandingPreamble, buildTurnFrame } from '../prompt-frame.js';
import { BRIDGE_VERSION } from '../version.js';
import type { AgentHarnessIsolationLevel } from '../hub-relay-client.js';

const CANCEL_GRACE_MS = 30_000;

export interface RunTurnInput {
	turnId: string;
	sessionKey: string;
	roomId: string;
	threadId?: string;
	senderName: string;
	prompt: string;
	promptFull: string;
	resume: boolean;
	savedSessionId: string | undefined;
	policy: PermissionPolicy;
	idleTimeoutMs: number;
	/** Absolute epoch ms — the turn is cancelled once `Date.now()` passes this. */
	deadlineMs: number;
	onChunk: (chunk: string, index: number) => void;
	onToolUse: (params: { toolId: string; toolName: string; input: unknown; status: string }) => void;
	onActivity: (params: { kind: string; status: string; message: string }) => void;
}

export interface RunTurnResult {
	status: 'completed' | 'failed' | 'cancelled';
	text: string;
	errorMessage?: string;
	sessionFresh: boolean;
	acpSessionId: string;
}

/**
 * Phase-04 mid-turn steer ack. `notRunning`/`unsupported` are decided
 * SYNCHRONOUSLY (no in-flight turn, or the adapter never advertised
 * `_meta.steering.supported` at `initialize` — never probed, the platform
 * `acp.rs:1423`); `accepted` carries a promise for the eventual
 * `injected`/`dropped` outcome once the `_session/steering` round trip (or a
 * `turn.cancel` that preempts it) settles.
 */
export type SteerAck = { outcome: 'notRunning' | 'unsupported' } | { outcome: 'accepted'; result: Promise<'injected' | 'dropped'> };

interface ActiveTurnState {
	sessionId: string;
	policy: PermissionPolicy;
	accumulatedText: string;
	chunkIndex: number;
	lastChunkSentAt: number;
	cancelRequested: boolean;
	onChunk: RunTurnInput['onChunk'];
	onToolUse: RunTurnInput['onToolUse'];
	onActivity: RunTurnInput['onActivity'];
	resetIdle: () => void;
}

const CHUNK_THROTTLE_MS = 150;
const ACTIVITY_MESSAGE_MAX_LEN = 200;

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function textOf(block: ContentBlock): string {
	return block.type === 'text' ? block.text : '';
}

export class AcpSession {
	private readonly spec: AdapterSpec;
	private readonly cwd: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly verbose: boolean;
	private readonly isolation: AgentHarnessIsolationLevel;
	private readonly cancelGraceMs: number;

	private child: ChildProcessWithoutNullStreams | undefined;
	private ctx: ClientContext | undefined;
	private connectionClosed: Promise<void> | undefined;
	private agentCapabilities: AgentCapabilities | undefined;
	/** Captured ONCE from `InitializeResponse._meta.steering.supported` — the ONLY gate for `steer()` (never re-checked per call, never probed). */
	private steeringSupported = false;
	/** The one turn this process can have in flight at a time (turn-runner.ts's global FIFO never overlaps two `runTurn` calls on the same process). `steerAbort` lets `cancelTurn` resolve a pending `steer()` as `dropped` without waiting for the ACP round trip (phase-04 "cancel with a pending steer → dropped"). `replaceDeadline` lets `steer()` apply the hub's renewed `deadlineMs` to the turn's own hard-deadline timer. */
	private currentTurn: { turnId: string; sessionId: string; steerAbort?: () => void; replaceDeadline: (deadlineMs: number) => void } | undefined;

	private readonly activeTurns = new Map<string, ActiveTurnState>();
	private readonly loadingSessions = new Set<string>();
	/** Per-ACP-session: true once the standing preamble has been sent as a prefix block. */
	private readonly prefixSent = new Set<string>();
	/** Per-ACP-session: true once we know `_meta`/top-level system prompt was rejected. */
	private readonly transportFallback = new Set<string>();

	constructor(
		spec: AdapterSpec,
		opts: { cwd: string; env: NodeJS.ProcessEnv; verbose: boolean; isolation: AgentHarnessIsolationLevel; cancelGraceMs?: number },
	) {
		this.spec = spec;
		this.cwd = opts.cwd;
		this.env = opts.env;
		this.verbose = opts.verbose;
		this.isolation = opts.isolation;
		this.cancelGraceMs = opts.cancelGraceMs ?? CANCEL_GRACE_MS;
	}

	get capabilities(): AgentCapabilities | undefined {
		return this.agentCapabilities;
	}

	private isAlive(): boolean {
		return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
	}

	private async ensureStarted(): Promise<void> {
		if (this.isAlive() && this.ctx) return;
		await this.spawnAndInitialize();
	}

	private async spawnAndInitialize(): Promise<void> {
		const child = spawn(this.spec.command, this.spec.args, {
			cwd: this.cwd,
			env: this.env,
			stdio: ['pipe', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
		});
		this.child = child;
		if (this.verbose) {
			child.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[${this.spec.id} stderr] ${chunk}`));
		} else {
			child.stderr.resume();
		}
		let spawnError: Error | undefined;
		child.on('error', (err) => {
			spawnError = err;
			process.stderr.write(`[agent-harness] adapter process error: ${err.message}\n`);
		});
		// Resolved on `exit` OR `error`: a failed spawn (ENOENT) emits `error` and
		// may never emit `exit`, and `dispose()` waits on this.
		this.connectionClosed = new Promise((resolve) => {
			child.once('exit', () => resolve());
			child.once('error', () => resolve());
		});

		// Hand-rolled stdin adapter instead of `Writable.toWeb(child.stdin)`: on
		// Node 22.16 that adapter turns a premature pipe close (adapter binary
		// missing / died before initialize) into an unobserved AbortError
		// rejection that crashes the whole bridge. Here the only promise is the
		// write callback, which the ACP SDK awaits.
		const stdin = new WritableStream<Uint8Array>({
			write: (chunk) =>
				new Promise<void>((resolve, reject) => {
					child.stdin.write(chunk, (err) => (err ? reject(err) : resolve()));
				}),
			close: () => new Promise<void>((resolve) => child.stdin.end(resolve)),
		});
		const stream: Stream = ndJsonStream(stdin, Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>);

		const app = client({ name: 'privos-agent-harness' });
		app.onRequest('session/request_permission', async ({ params }) => {
			const state = this.activeTurns.get(params.sessionId);
			if (!state || state.cancelRequested) {
				return { outcome: { outcome: 'cancelled' as const } };
			}
			const kind: ToolKind | undefined = params.toolCall.kind ?? undefined;
			const decision = decidePermission(state.policy, kind, params.options as PermissionOption[]);
			logPermissionDecision(params.toolCall.title ?? params.toolCall.toolCallId, kind, decision?.optionKind);
			if (!decision) return { outcome: { outcome: 'cancelled' as const } };
			return { outcome: { outcome: 'selected' as const, optionId: decision.optionId } };
		});
		app.onNotification('session/update', ({ params }) => {
			this.handleSessionUpdate(params.sessionId, params.update);
		});

		const connectionPromise = new Promise<ClientContext>((resolve) => {
			app.onConnect((connection) => {
				resolve(connection.agent);
			});
			app.connect(stream);
		});
		this.ctx = await connectionPromise;

		let initResult: InitializeResponse;
		try {
			initResult = await this.ctx.request<InitializeResponse>('initialize', {
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {
					fs: { readTextFile: false, writeTextFile: false },
					terminal: false,
				},
				clientInfo: { name: 'privos-agent-harness', version: BRIDGE_VERSION },
			});
		} catch (error) {
			// A dead pipe surfaces as EPIPE / "connection closed"; name the real cause.
			if (spawnError) throw new Error(`adapter "${this.spec.command}" failed to start: ${spawnError.message}`);
			throw error;
		}
		this.agentCapabilities = initResult.agentCapabilities;
		const steeringMeta = (initResult._meta as { steering?: { supported?: unknown } } | null | undefined)?.steering;
		this.steeringSupported = steeringMeta?.supported === true;
	}

	private handleSessionUpdate(sessionId: string, update: SessionUpdate): void {
		if (this.loadingSessions.has(sessionId)) return; // session/load replay — never reaches the accumulator (F6)
		const state = this.activeTurns.get(sessionId);
		if (!state) return;
		state.resetIdle();
		switch (update.sessionUpdate) {
			case 'agent_message_chunk': {
				state.accumulatedText += textOf(update.content);
				this.maybeEmitChunk(state);
				break;
			}
			case 'agent_thought_chunk': {
				state.onActivity({ kind: 'thinking', status: 'in_progress', message: truncate(textOf(update.content), ACTIVITY_MESSAGE_MAX_LEN) });
				break;
			}
			case 'tool_call': {
				state.onToolUse({
					toolId: update.toolCallId,
					toolName: update.title,
					input: update.rawInput ?? {},
					status: update.status ?? 'pending',
				});
				break;
			}
			case 'tool_call_update': {
				state.onActivity({ kind: 'tool', status: update.status ?? 'in_progress', message: update.title ?? '' });
				break;
			}
			case 'plan': {
				const summary = update.entries.map((entry) => entry.content).join('; ');
				state.onActivity({ kind: 'plan', status: 'in_progress', message: truncate(summary, ACTIVITY_MESSAGE_MAX_LEN) });
				break;
			}
			default:
				break; // every other sessionUpdate kind is ignored generically, by design
		}
	}

	private maybeEmitChunk(state: ActiveTurnState): void {
		const now = Date.now();
		if (now - state.lastChunkSentAt < CHUNK_THROTTLE_MS) return;
		state.lastChunkSentAt = now;
		state.onChunk(state.accumulatedText, state.chunkIndex++);
	}

	private async createOrLoadSession(input: RunTurnInput): Promise<{ sessionId: string; sessionFresh: boolean }> {
		const ctx = this.ctx!;
		if (input.savedSessionId && this.agentCapabilities?.loadSession) {
			this.loadingSessions.add(input.savedSessionId);
			try {
				await ctx.request('session/load', { mcpServers: [], cwd: this.cwd, sessionId: input.savedSessionId });
				return { sessionId: input.savedSessionId, sessionFresh: false };
			} catch {
				// Fall through to a fresh session below.
			} finally {
				this.loadingSessions.delete(input.savedSessionId);
			}
		}
		const preamble = buildStandingPreamble({ adapter: this.spec.id, isolation: this.isolation });
		if (this.spec.systemPromptTransport === 'meta') {
			try {
				const res = await ctx.request('session/new', {
					cwd: this.cwd,
					mcpServers: [],
					_meta: { systemPrompt: { append: preamble } },
				});
				return { sessionId: res.sessionId, sessionFresh: true };
			} catch {
				const res = await ctx.request('session/new', { cwd: this.cwd, mcpServers: [] });
				this.transportFallback.add(res.sessionId);
				return { sessionId: res.sessionId, sessionFresh: true };
			}
		}
		if (this.spec.systemPromptTransport === 'top-level') {
			try {
				const params: NewSessionRequest & { systemPrompt?: string } = { cwd: this.cwd, mcpServers: [], systemPrompt: preamble };
				const res = await ctx.request('session/new', params);
				return { sessionId: res.sessionId, sessionFresh: true };
			} catch {
				const res = await ctx.request('session/new', { cwd: this.cwd, mcpServers: [] });
				this.transportFallback.add(res.sessionId);
				return { sessionId: res.sessionId, sessionFresh: true };
			}
		}
		const res = await ctx.request('session/new', { cwd: this.cwd, mcpServers: [] });
		this.transportFallback.add(res.sessionId);
		return { sessionId: res.sessionId, sessionFresh: true };
	}

	async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
		await this.ensureStarted();
		const ctx = this.ctx!;
		const { sessionId, sessionFresh } = await this.createOrLoadSession(input);

		const baseText = input.resume && sessionFresh ? input.promptFull : input.prompt;
		const framed = buildTurnFrame({ roomId: input.roomId, threadId: input.threadId, senderName: input.senderName, text: baseText });
		const usesPrefix = this.spec.systemPromptTransport === 'prefix' || this.transportFallback.has(sessionId);
		const needsPrefixNow = usesPrefix && !this.prefixSent.has(sessionId);
		if (needsPrefixNow) this.prefixSent.add(sessionId);
		const blocks: ContentBlock[] = needsPrefixNow
			? [
					{ type: 'text', text: buildStandingPreamble({ adapter: this.spec.id, isolation: this.isolation }) },
					{ type: 'text', text: framed },
				]
			: [{ type: 'text', text: framed }];

		let idleTimer: NodeJS.Timeout;
		let deadlineTimer: NodeJS.Timeout | undefined;
		const state: ActiveTurnState = {
			sessionId,
			policy: input.policy,
			accumulatedText: '',
			chunkIndex: 0,
			lastChunkSentAt: 0,
			cancelRequested: false,
			onChunk: input.onChunk,
			onToolUse: input.onToolUse,
			onActivity: (params) => input.onActivity(params),
			resetIdle: () => {
				clearTimeout(idleTimer);
				idleTimer = setTimeout(() => triggerCancel(), input.idleTimeoutMs);
				idleTimer.unref?.();
			},
		};
		this.activeTurns.set(sessionId, state);

		let cancelTriggered = false;
		let killTimer: NodeJS.Timeout | undefined;
		let killedForUnresponsiveness = false;
		let resolveKillGate: (() => void) | undefined;
		const killGate = new Promise<void>((resolve) => {
			resolveKillGate = resolve;
		});
		const triggerCancel = (): void => {
			if (cancelTriggered) return;
			cancelTriggered = true;
			state.cancelRequested = true;
			void ctx.notify('session/cancel', { sessionId }).catch(() => undefined);
			// Give the adapter `cancelGraceMs` to settle `session/prompt` on its own
			// before we SIGKILL it — required by the timeout/cancel contract.
			killTimer = setTimeout(() => {
				killedForUnresponsiveness = true;
				this.killProcessGroup();
				resolveKillGate?.();
			}, this.cancelGraceMs);
			killTimer.unref?.();
		};
		state.resetIdle();
		const deadlineDelay = Math.max(0, input.deadlineMs - Date.now());
		deadlineTimer = setTimeout(triggerCancel, deadlineDelay);
		deadlineTimer.unref?.();

		// Phase-04: lets `steer()` replace this exact timer with a renewed
		// deadline sent by the hub (`turn.steer`'s `deadlineMs`).
		const replaceDeadline = (newDeadlineMs: number): void => {
			clearTimeout(deadlineTimer);
			deadlineTimer = setTimeout(triggerCancel, Math.max(0, newDeadlineMs - Date.now()));
			deadlineTimer.unref?.();
		};

		// Exposed so turn-runner can cancel this exact turn on `turn.cancel`.
		this.cancelHandlers.set(input.turnId, triggerCancel);
		// Phase-04: exposes this turn to `steer()`/`cancelTurn`'s steer-abort path.
		this.currentTurn = { turnId: input.turnId, sessionId, replaceDeadline };

		let stopReason: StopReason | undefined;
		let promptError: unknown;
		const promptSettled = ctx
			.request('session/prompt', { sessionId, prompt: blocks })
			.then((response) => {
				stopReason = response.stopReason;
			})
			.catch((error: unknown) => {
				promptError = error;
			});
		await Promise.race([promptSettled, killGate]);

		clearTimeout(idleTimer!);
		clearTimeout(deadlineTimer);
		if (killTimer) clearTimeout(killTimer);
		this.cancelHandlers.delete(input.turnId);
		this.activeTurns.delete(sessionId);
		if (this.currentTurn?.turnId === input.turnId) this.currentTurn = undefined;

		if (killedForUnresponsiveness) {
			return {
				status: 'failed',
				text: state.accumulatedText,
				errorMessage: 'adapter did not respond to cancellation; process was killed',
				sessionFresh,
				acpSessionId: sessionId,
			};
		}
		if (promptError && cancelTriggered) {
			// The adapter surfaced cancellation as a request error rather than a
			// `cancelled` stopReason — still a clean cancel; the process stays up.
			return { status: 'cancelled', text: state.accumulatedText, sessionFresh, acpSessionId: sessionId };
		}
		if (promptError) {
			const message = promptError instanceof Error ? promptError.message : String(promptError);
			return { status: 'failed', text: state.accumulatedText, errorMessage: message, sessionFresh, acpSessionId: sessionId };
		}
		if (stopReason === 'cancelled') {
			return { status: 'cancelled', text: state.accumulatedText, sessionFresh, acpSessionId: sessionId };
		}
		if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests' || stopReason === 'refusal') {
			return {
				status: 'completed',
				text: state.accumulatedText,
				errorMessage: `Turn stopped early: ${stopReason}`,
				sessionFresh,
				acpSessionId: sessionId,
			};
		}
		return { status: 'completed', text: state.accumulatedText, sessionFresh, acpSessionId: sessionId };
	}

	private readonly cancelHandlers = new Map<string, () => void>();

	/** Requests cancellation of a turn in flight; a no-op if the turn already finished. Also resolves a PENDING `steer()` on the same turn as `dropped` (phase-04 "cancel with a pending steer → dropped") instead of leaving it to race the (now-irrelevant) `_session/steering` response. */
	cancelTurn(turnId: string): void {
		this.cancelHandlers.get(turnId)?.();
		if (this.currentTurn?.turnId === turnId) this.currentTurn.steerAbort?.();
	}

	/**
	 * Phase-04 mid-turn steer (plan.md Design §4). `turnId` must match the
	 * CURRENTLY RUNNING turn — turn-runner.ts already guarantees this (it only
	 * calls `steer` when `turnId === this.currentTurnId`), but this session
	 * re-checks it anyway since it is the one holding `sessionId`. Deadline
	 * replacement happens regardless of `steeringSupported` — the hub renews
	 * expecting delivery to succeed, and a slightly longer deadline on an
	 * eventual `dropped` is harmless (the turn just runs to its own natural
	 * end). Never probes `_session/steering` on an adapter that didn't
	 * advertise it at `initialize` — codex-acp answers an unknown method with
	 * a bare `{}`, a JSON-RPC SUCCESS, which would be misread as delivered.
	 */
	steer(turnId: string, text: string, deadlineMs: number): SteerAck {
		const current = this.currentTurn;
		if (!current || current.turnId !== turnId) return { outcome: 'notRunning' };
		current.replaceDeadline(deadlineMs);
		if (!this.steeringSupported) return { outcome: 'unsupported' };

		const result = new Promise<'injected' | 'dropped'>((resolve) => {
			let settled = false;
			const finish = (outcome: 'injected' | 'dropped'): void => {
				if (settled) return;
				settled = true;
				if (current.steerAbort === abort) current.steerAbort = undefined;
				resolve(outcome);
			};
			// `turn.cancel` while THIS steer is pending resolves it `dropped`
			// without waiting for (or trusting) whatever the in-flight
			// `_session/steering` response eventually says (phase-04 "cancel with
			// a pending steer → dropped").
			const abort = (): void => finish('dropped');
			current.steerAbort = abort;

			this.ctx!.request<{ outcome?: string }>('_session/steering', {
				sessionId: current.sessionId,
				prompt: [{ type: 'text', text }],
				_meta: { steering: { idleBehavior: 'promptRequired' } },
			})
				.then((response) => {
					if (settled) return;
					const outcome = response?.outcome;
					if (outcome === 'injected') {
						finish('injected');
						return;
					}
					if (outcome === 'startedNewTurn') {
						// An older adapter ignored the `promptRequired` opt-in and already
						// launched a DETACHED turn on its own — cancel it so it dies
						// rather than answering the room a second time (red-team F11).
						void this.ctx!.notify('session/cancel', { sessionId: current.sessionId }).catch(() => undefined);
						finish('dropped');
						return;
					}
					// `promptRequired` (the turn ended in the gap), `failed`, `{}`,
					// or a missing/unrecognised outcome — all `dropped`.
					finish('dropped');
				})
				.catch(() => finish('dropped')); // -32601 (method not found despite advertising support), or a transport error.
		});

		return { outcome: 'accepted', result };
	}

	private killProcessGroup(): void {
		const child = this.child;
		if (!child || child.pid === undefined) return;
		try {
			if (process.platform === 'win32') child.kill('SIGKILL');
			else process.kill(-child.pid, 'SIGKILL');
		} catch {
			/* process already gone */
		}
	}

	async dispose(): Promise<void> {
		const child = this.child;
		if (!child) return;
		try {
			if (process.platform === 'win32') child.kill();
			else if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
		} catch {
			/* already exited */
		}
		await Promise.race([this.connectionClosed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
		if (this.isAlive()) this.killProcessGroup();
	}
}

function logPermissionDecision(title: string, kind: ToolKind | undefined, optionKind: 'allow_once' | 'reject_once' | undefined): void {
	process.stderr.write(`[agent-harness] permission: "${title}" (${kind ?? 'unknown'}) -> ${optionKind ?? 'cancelled (no matching option)'}\n`);
}
