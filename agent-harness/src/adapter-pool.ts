/**
 * One adapter process PER ROOM (red-team M4 — one process model at every
 * isolation level), pooled up to `--max-rooms` (default 8), lazily spawned
 * on a room's first turn. Deletes Phase 4's single-shared-process model:
 * `turn-runner.ts` still owns the per-`sessionKey` FIFO and only ever calls
 * `runTurn`/`cancelTurn` on whatever it was given (the seam) — this class
 * satisfies that exact interface by routing on `input.roomId`, so
 * `TurnRunner` needed no rewrite.
 *
 * - Full pool + a new room -> reap the least-recently-used IDLE room (empty
 *   queue, nothing in flight) to make space; if none is idle, `harness_busy`
 *   (M5).
 * - Idle reap after `idleReapMs` (10 min default) — never while a turn is in
 *   flight; reap always goes through the room's own `dispose()` (SIGTERM,
 *   then SIGKILL after a grace period), so a reap can never land mid
 *   `session/load`/`session/prompt` (M6).
 * - An explicit `turnId -> roomId` map routes `cancelTurn` to the right
 *   process even if the pool has since evicted/re-created other rooms (M6).
 */
import { HarnessBusyError } from './hub-relay-client.js';
import type { RunTurnInput, RunTurnResult, SteerAck } from './acp/acp-session.js';

export interface PooledSession {
	runTurn(input: RunTurnInput): Promise<RunTurnResult>;
	cancelTurn(turnId: string): void;
	/** Phase-04 mid-turn steer — routed like `cancelTurn`, via the pool's own `turnId -> roomId` map. */
	steer(turnId: string, text: string, deadlineMs: number): SteerAck;
	dispose(): Promise<void>;
}

export interface AdapterPoolOptions {
	maxRooms: number;
	idleReapMs: number;
	createSession: (roomId: string) => PooledSession;
	onReap?: (roomId: string, reason: 'lru-cap' | 'idle-timeout' | 'shutdown') => void;
	/** Fires on every 0->1 / 1->0 transition of a room's in-flight turn count — `skills update`'s cross-process busy check (a separate CLI invocation) is built on this. */
	onBusyChange?: (roomId: string, busy: boolean) => void;
}

interface RoomEntry {
	session: PooledSession;
	turnsInFlight: number;
	lastActiveAt: number;
	idleTimer: NodeJS.Timeout | undefined;
}

export class AdapterPool implements PooledSession {
	private readonly opts: AdapterPoolOptions;
	private readonly rooms = new Map<string, RoomEntry>();
	private readonly turnRoom = new Map<string, string>();

	constructor(opts: AdapterPoolOptions) {
		this.opts = opts;
	}

	get roomCount(): number {
		return this.rooms.size;
	}

	/** For `status`/diagnostics only. */
	roomIds(): string[] {
		return [...this.rooms.keys()];
	}

	async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
		const roomId = input.roomId;
		let entry = this.rooms.get(roomId);
		if (!entry) {
			if (this.rooms.size >= this.opts.maxRooms) {
				const reaped = await this.reapIdleLru();
				if (!reaped) throw new HarnessBusyError();
			}
			entry = { session: this.opts.createSession(roomId), turnsInFlight: 0, lastActiveAt: Date.now(), idleTimer: undefined };
			this.rooms.set(roomId, entry);
		}
		this.clearIdleTimer(entry);
		entry.turnsInFlight++;
		if (entry.turnsInFlight === 1) this.opts.onBusyChange?.(roomId, true);
		entry.lastActiveAt = Date.now();
		this.turnRoom.set(input.turnId, roomId);
		try {
			return await entry.session.runTurn(input);
		} finally {
			entry.turnsInFlight--;
			if (entry.turnsInFlight === 0) this.opts.onBusyChange?.(roomId, false);
			entry.lastActiveAt = Date.now();
			this.turnRoom.delete(input.turnId);
			// The room may have been reaped (LRU-cap) while this turn ran; only
			// re-arm the idle timer if it is still the one this pool tracks.
			if (this.rooms.get(roomId) === entry) this.armIdleTimer(roomId, entry);
		}
	}

	cancelTurn(turnId: string): void {
		const roomId = this.turnRoom.get(turnId);
		if (!roomId) return;
		this.rooms.get(roomId)?.session.cancelTurn(turnId);
	}

	/** Routes to the owning room's session via the SAME `turnId -> roomId` map `cancelTurn` uses -- an unknown turnId (finished, or never routed here) answers `notRunning`, matching a queued-but-not-yet-started turn (M6: this map is authoritative even across an LRU-cap reap/recreate of other rooms). */
	steer(turnId: string, text: string, deadlineMs: number): SteerAck {
		const roomId = this.turnRoom.get(turnId);
		const session = roomId ? this.rooms.get(roomId)?.session : undefined;
		if (!session) return { outcome: 'notRunning' };
		return session.steer(turnId, text, deadlineMs);
	}

	private armIdleTimer(roomId: string, entry: RoomEntry): void {
		if (entry.turnsInFlight > 0) return;
		entry.idleTimer = setTimeout(() => void this.reapRoom(roomId, 'idle-timeout'), this.opts.idleReapMs);
		entry.idleTimer.unref?.();
	}

	private clearIdleTimer(entry: RoomEntry): void {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
	}

	/** Reaps the least-recently-used room with nothing in flight. Returns `false` if every room is busy (pool stays full -> caller answers `harness_busy`). */
	private async reapIdleLru(): Promise<boolean> {
		let victimId: string | undefined;
		let victimEntry: RoomEntry | undefined;
		for (const [roomId, entry] of this.rooms) {
			if (entry.turnsInFlight > 0) continue;
			if (!victimEntry || entry.lastActiveAt < victimEntry.lastActiveAt) {
				victimId = roomId;
				victimEntry = entry;
			}
		}
		if (!victimId) return false;
		await this.reapRoom(victimId, 'lru-cap');
		return true;
	}

	private async reapRoom(roomId: string, reason: 'lru-cap' | 'idle-timeout' | 'shutdown'): Promise<void> {
		const entry = this.rooms.get(roomId);
		if (!entry || entry.turnsInFlight > 0) return; // never reap mid session/load or session/prompt (M6)
		this.clearIdleTimer(entry);
		this.rooms.delete(roomId);
		this.opts.onReap?.(roomId, reason);
		await entry.session.dispose();
	}

	/** Disposes every pooled process (bridge shutdown). */
	async dispose(): Promise<void> {
		const roomIds = [...this.rooms.keys()];
		await Promise.all(roomIds.map((roomId) => this.reapRoom(roomId, 'shutdown')));
	}
}
