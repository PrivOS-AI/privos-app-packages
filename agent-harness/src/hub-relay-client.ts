/**
 * Outbound WSS connection to the hub's `agents.harness.relay` endpoint.
 * Frozen wire contract (re-declared here — see
 * `plans/260910-1648-pair-agent-with-existing-harness-via-acp-bridge/plan.md`
 * "Hub->bridge JSON-RPC" table; the hub's own copy lives at
 * `agent-harness-protocol.ts` in privos-hub, a different repo — no cross-repo
 * import). Every frame received here is untrusted network input, even though
 * the socket itself is authenticated: malformed frames are logged and dropped,
 * never thrown.
 *
 * Uses the `ws` package rather than Node's global WebSocket because the
 * global one hides ping/pong control frames and the upgrade's HTTP status.
 * Liveness: the hub pings every 30s and terminates a socket that misses a
 * pong, but a stalled path leaves THIS side holding a half-open socket it
 * believes is connected. So every inbound frame (message, hub ping, pong to
 * our own ping) refreshes `lastInboundAt`; the watchdog pings the hub and
 * terminates + reconnects once nothing has arrived for `idleTimeoutMs`.
 */
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { AgentHarnessRespondTo } from './config-store.js';

export type AgentHarnessIsolationLevel = 'wrap' | 'wrap-shared-state' | 'container' | 'prompt' | 'none';

export interface AgentHarnessTurnSender {
	_id: string;
	username?: string;
	name?: string;
}

export interface AgentHarnessTurnStartParams {
	turnId: string;
	sessionKey: string;
	roomId: string;
	threadId?: string;
	prompt: string;
	promptFull: string;
	displayPrompt: string;
	sender: AgentHarnessTurnSender;
	resume: boolean;
	deadlineMs: number;
	/** Room-message files carried inline (base64). The bridge writes them into
	 * the room workdir and turns them into ACP prompt content blocks. */
	attachments?: AgentHarnessTurnAttachment[];
}

/** A single inline attachment on `turn.start`. */
export interface AgentHarnessTurnAttachment {
	name: string;
	mimeType: string;
	/** base64-encoded file bytes. */
	data: string;
}

export const AGENT_HARNESS_BUSY_ERROR_CODE = 'harness_busy' as const;

export class HarnessBusyError extends Error {
	constructor() {
		super('harness_busy');
	}
}

export interface HarnessHelloParams {
	adapter: string;
	adapterVersion?: string;
	bridgeVersion: string;
	hostname: string;
	cwd: string;
	permissions: string;
	isolation: AgentHarnessIsolationLevel;
	skillsManifest?: { sandboxVersion: string };
	capabilities: { loadSession: boolean };
	/** Phase-04: whether THIS adapter advertises native mid-turn steer (`adapter-table.ts`'s `steering` column) -- informational for the hub's settings panel, never the runtime gate (that's `_meta.steering.supported` captured per-process at `initialize`). */
	steering: boolean;
}

export interface HarnessHelloResult {
	agentRoomId: string;
	connectUrl?: string;
	respondTo: AgentHarnessRespondTo;
}

export interface TurnChunkParams {
	turnId: string;
	chunk: string;
	index: number;
	isComplete: false;
}

export interface TurnToolUseParams {
	turnId: string;
	toolId: string;
	toolName: string;
	input: unknown;
	status: string;
}

export interface TurnActivityParams {
	turnId: string;
	kind: string;
	status: string;
	message: string;
	timestamp: string;
}

export interface TurnDoneParams {
	turnId: string;
	status: 'completed' | 'failed' | 'cancelled';
	text: string;
	errorMessage?: string;
	sessionFresh: boolean;
}

/** Phase-04 mid-turn steer -- hub->bridge RPC (has `id`); the ack ONLY says the request was accepted for processing, not that the message was delivered (see `TurnSteerResultParams`). */
export interface AgentHarnessTurnSteerParams {
	turnId: string;
	roomId: string;
	steerId: string;
	/** Already framed by the hub's `formatNativeSteer` -- passed through untouched. */
	text: string;
	/** Absolute epoch ms -- replaces the running turn's hard deadline. */
	deadlineMs: number;
}

export type AgentHarnessSteerAckOutcome = 'accepted' | 'notRunning' | 'unsupported';

/** Phase-04 mid-turn steer -- bridge->hub notification with the FINAL outcome, sent after the ack once the ACP round trip (or lack of one) settles. */
export interface TurnSteerResultParams {
	turnId: string;
	steerId: string;
	outcome: 'injected' | 'dropped';
}

export interface HubRelayHandlers {
	/** Throws `HarnessBusyError` when more than 5 turns are already pending for the session. */
	onTurnStart(params: AgentHarnessTurnStartParams): Promise<{ accepted: true; queued: number }>;
	onTurnCancel(params: { turnId: string }): void;
	/** Synchronous ack only -- the eventual `injected`/`dropped` outcome is reported later via `notify('turn.steer-result', ...)`. */
	onTurnSteer(params: AgentHarnessTurnSteerParams): Promise<{ outcome: AgentHarnessSteerAckOutcome }>;
	onResetSessions(): void;
	onConnectionChange?(connected: boolean): void;
}

export interface HubRelayOptions {
	hubUrl: string;
	botToken: string;
	hello: HarnessHelloParams;
	handlers: HubRelayHandlers;
	insecure?: boolean;
	verbose?: boolean;
	/** Reconnect when no frame (message, ping or pong) arrives for this long. Default 75s (2.5 hub ping intervals). */
	idleTimeoutMs?: number;
}

/** Reason strings the plan requires printed verbatim for each terminal close/rejection. */
export type TerminalReason =
	| { kind: 'replaced'; hostname?: string }
	| { kind: 'revoked' }
	| { kind: 'not_a_harness_agent' }
	| { kind: 'unauthorized' };

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000] as const;
const SOCKET_LOSS_CANCEL_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 75_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

function log(message: string): void {
	process.stderr.write(`[agent-harness] ${new Date().toISOString()} ${message}\n`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Performs a raw HTTP upgrade probe for `doctor`, which reports the hub's
 * verdict without opening a relay session. The relay connection itself reads
 * the status from `ws`'s `unexpected-response` instead, so a reconnect costs
 * one hit against the hub's per-token connect rate limit, not two. Returns
 * the HTTP status when the server rejected the upgrade without switching
 * protocols, or `null` when the upgrade would succeed (or the probe itself
 * failed for an unrelated reason).
 */
export function probeUpgradeStatus(wsUrl: string, headers: Record<string, string>): Promise<number | null> {
	return new Promise((resolve) => {
		let url: URL;
		try {
			url = new URL(wsUrl);
		} catch {
			resolve(null);
			return;
		}
		const mod = url.protocol === 'wss:' ? https : http;
		const req = mod.request({
			hostname: url.hostname,
			port: url.port || (url.protocol === 'wss:' ? 443 : 80),
			path: `${url.pathname}${url.search}`,
			method: 'GET',
			headers: {
				...headers,
				Connection: 'Upgrade',
				Upgrade: 'websocket',
				'Sec-WebSocket-Version': '13',
				'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
			},
			timeout: 15_000,
		});
		req.on('upgrade', (_res, socket) => {
			socket.destroy();
			resolve(null);
		});
		req.on('response', (res) => {
			res.resume();
			resolve(res.statusCode ?? null);
		});
		req.on('timeout', () => req.destroy());
		req.on('error', () => resolve(null));
		req.end();
	});
}

export class HubRelayClient {
	private readonly opts: HubRelayOptions;
	private readonly idleTimeoutMs: number;
	private ws: WebSocket | undefined;
	private lastInboundAt = 0;
	private stopped = false;
	private backoffIndex = 0;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private idCounter = 0;
	private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
	private helloResult: HarnessHelloResult | undefined;
	private disconnectedSince: number | undefined;
	private terminal: TerminalReason | undefined;
	private terminalResolve: ((reason: TerminalReason) => void) | undefined;
	readonly whenTerminal: Promise<TerminalReason>;

	constructor(opts: HubRelayOptions) {
		this.opts = opts;
		this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.whenTerminal = new Promise((resolve) => {
			this.terminalResolve = resolve;
		});
	}

	get hello(): HarnessHelloResult | undefined {
		return this.helloResult;
	}

	isConnected(): boolean {
		return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN;
	}

	/** Milliseconds since the socket last dropped, or `undefined` while connected. */
	disconnectedForMs(): number | undefined {
		return this.disconnectedSince === undefined ? undefined : Date.now() - this.disconnectedSince;
	}

	start(): void {
		void this.connectOnce();
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.ws?.close(1000, 'client stopping');
	}

	private nextId(): string {
		return `${process.pid}-${this.idCounter++}`;
	}

	/** Returns the backoff delay, or `undefined` when no reconnect will happen. */
	private scheduleReconnect(): number | undefined {
		if (this.stopped || this.terminal) return undefined;
		const delay = BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)] ?? 60_000;
		this.backoffIndex = Math.min(this.backoffIndex + 1, BACKOFF_MS.length - 1);
		// Stays ref'd: an idle bridge has no other live handle once the socket
		// drops, so an unref'd timer would let Node exit before reconnecting.
		// stop() clears it, so a deliberate shutdown still exits.
		this.reconnectTimer = setTimeout(() => void this.connectOnce(), delay);
		return delay;
	}

	private setTerminal(reason: TerminalReason): void {
		if (this.terminal) return;
		this.terminal = reason;
		this.stopped = true;
		this.terminalResolve?.(reason);
	}

	private async connectOnce(): Promise<void> {
		if (this.stopped) return;
		const wsUrl = `${this.opts.hubUrl.replace(/^http/, 'ws')}/api/v1/agents.harness.relay`;
		if (!this.opts.insecure && wsUrl.startsWith('ws://') && !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(wsUrl)) {
			this.setTerminal({ kind: 'unauthorized' });
			process.stderr.write('[agent-harness] refusing a plain ws:// connection to a non-localhost hub without --insecure.\n');
			return;
		}
		const headers = { Authorization: `Bearer ${this.opts.botToken}` };

		const ws = new WebSocket(wsUrl, { headers, handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
		this.ws = ws;
		let lastError = '';
		let watchdog: NodeJS.Timeout | undefined;

		ws.on('unexpected-response', (_req, res) => {
			res.resume();
			if (res.statusCode === 401) this.setTerminal({ kind: 'revoked' });
			else if (res.statusCode === 403) this.setTerminal({ kind: 'not_a_harness_agent' });
			lastError = `upgrade rejected with HTTP ${res.statusCode}`;
			ws.terminate();
		});
		ws.on('open', () => {
			this.backoffIndex = 0;
			const offlineMs = this.disconnectedForMs();
			log(`relay connected${offlineMs === undefined ? '' : ` after ${Math.round(offlineMs / 1000)}s offline`}`);
			this.disconnectedSince = undefined;
			this.lastInboundAt = Date.now();
			watchdog = setInterval(() => this.checkIdle(ws), this.idleTimeoutMs / 5);
			// The socket keeps the process alive; this timer must not.
			watchdog.unref();
			this.opts.handlers.onConnectionChange?.(true);
			void this.sendHello();
		});
		const onInbound = (): void => {
			this.lastInboundAt = Date.now();
		};
		ws.on('ping', onInbound);
		ws.on('pong', onInbound);
		ws.on('message', (data: WebSocket.RawData) => {
			onInbound();
			void this.handleMessage(data);
		});
		// `ws` always follows `error` with `close`, including failed connects.
		// Keep the first cause: terminate() after a rejected upgrade adds a generic abort error.
		ws.on('error', (error: Error) => {
			lastError ||= error.message;
		});
		ws.on('close', (code: number, reasonBuffer: Buffer) => {
			const reason = reasonBuffer.toString('utf8');
			clearInterval(watchdog);
			if (this.ws === ws) this.ws = undefined;
			if (this.disconnectedSince === undefined) this.disconnectedSince = Date.now();
			this.opts.handlers.onConnectionChange?.(false);
			this.helloResult = undefined;
			this.rejectAllPending(new Error(`connection closed: ${code}`));
			if (code === 4409) {
				// The hub's reason is `replaced by <hostname>`; keep only the hostname.
				this.setTerminal({ kind: 'replaced', hostname: reason.replace(/^replaced by /, '') || undefined });
			} else if (code === 4401) {
				this.setTerminal({ kind: 'revoked' });
			}
			const delay = this.scheduleReconnect();
			const detail = `code ${code}, reason "${reason}"${lastError ? `, error "${lastError}"` : ''}`;
			log(`relay disconnected: ${detail}; ${delay === undefined ? 'not reconnecting' : `reconnecting in ${delay}ms`}`);
		});
	}

	/** Watchdog tick: terminate a socket that has gone silent, otherwise ping so a healthy idle hub answers with a pong. */
	private checkIdle(ws: WebSocket): void {
		const silentMs = Date.now() - this.lastInboundAt;
		if (silentMs >= this.idleTimeoutMs) {
			log(`relay received no data for ${Math.round(silentMs / 1000)}s; terminating the socket`);
			ws.terminate();
			return;
		}
		try {
			ws.ping();
		} catch {
			/* socket already closing; `close` handles the reconnect */
		}
	}

	private rejectAllPending(err: Error): void {
		for (const [, entry] of this.pending) entry.reject(err);
		this.pending.clear();
	}

	private async sendHello(): Promise<void> {
		try {
			const result = await this.request<HarnessHelloResult>('harness.hello', this.opts.hello);
			this.helloResult = result;
		} catch (error) {
			log(`harness.hello failed: ${error instanceof Error ? error.message : String(error)}`);
			this.ws?.close();
		}
	}

	private request<T>(method: string, params: unknown): Promise<T> {
		return new Promise((resolve, reject) => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				reject(new Error('not connected'));
				return;
			}
			const id = this.nextId();
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
		});
	}

	/** Sends a bridge->hub notification (no reply expected). No-ops silently when not connected. */
	notify(method: string, params: unknown): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		try {
			this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
		} catch {
			/* best-effort; the hub will notice via its own connection-loss handling */
		}
	}

	private async handleMessage(data: unknown): Promise<void> {
		let text: string;
		if (typeof data === 'string') text = data;
		else if (Buffer.isBuffer(data)) text = data.toString('utf8');
		else return;
		let msg: unknown;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (!isPlainObject(msg)) return;

		// Response to a request WE sent (has id, no method).
		if (typeof msg.method !== 'string' && (msg.id !== undefined || 'result' in msg || 'error' in msg)) {
			const id = typeof msg.id === 'string' ? msg.id : undefined;
			if (id === undefined) return;
			const entry = this.pending.get(id);
			if (!entry) return;
			this.pending.delete(id);
			if ('error' in msg) {
				const error = isPlainObject(msg.error) ? msg.error : {};
				entry.reject(new Error(typeof error.message === 'string' ? error.message : 'request failed'));
			} else {
				entry.resolve(msg.result);
			}
			return;
		}

		if (typeof msg.method !== 'string') return;
		const hasId = msg.id !== undefined;

		if (msg.method === 'turn.start' && hasId) {
			const id = msg.id as string | number;
			try {
				const result = await this.opts.handlers.onTurnStart(msg.params as AgentHarnessTurnStartParams);
				this.sendResult(id, result);
			} catch (error) {
				if (error instanceof HarnessBusyError) {
					this.sendError(id, { code: -32000, message: AGENT_HARNESS_BUSY_ERROR_CODE, data: { code: AGENT_HARNESS_BUSY_ERROR_CODE } });
				} else {
					this.sendError(id, { code: -32603, message: error instanceof Error ? error.message : 'internal error' });
				}
			}
			return;
		}
		if (msg.method === 'turn.cancel' && !hasId) {
			this.opts.handlers.onTurnCancel(msg.params as { turnId: string });
			return;
		}
		if (msg.method === 'turn.steer' && hasId) {
			const id = msg.id as string | number;
			try {
				const result = await this.opts.handlers.onTurnSteer(msg.params as AgentHarnessTurnSteerParams);
				this.sendResult(id, result);
			} catch (error) {
				this.sendError(id, { code: -32603, message: error instanceof Error ? error.message : 'internal error' });
			}
			return;
		}
		if (msg.method === 'harness.resetSessions' && !hasId) {
			this.opts.handlers.onResetSessions();
			return;
		}
		// Unknown method: ignored generically (forward-compatible with future hub notifications).
	}

	private sendResult(id: string | number, result: unknown): void {
		this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
	}

	private sendError(id: string | number, error: { code: number; message: string; data?: unknown }): void {
		this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, error }));
	}
}

export { SOCKET_LOSS_CANCEL_MS };
