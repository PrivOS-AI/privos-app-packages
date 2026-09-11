import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterPool, type PooledSession } from '../src/adapter-pool.js';
import { HarnessBusyError } from '../src/hub-relay-client.js';
import type { RunTurnInput, RunTurnResult, SteerAck } from '../src/acp/acp-session.js';

class FakeRoomSession implements PooledSession {
	disposed = false;
	private resolvers = new Map<string, (result: RunTurnResult) => void>();
	calls: RunTurnInput[] = [];

	async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
		this.calls.push(input);
		return new Promise((resolve) => this.resolvers.set(input.turnId, resolve));
	}
	resolveTurn(turnId: string, result: RunTurnResult): void {
		this.resolvers.get(turnId)?.(result);
	}
	cancelTurn = vi.fn();
	steer = vi.fn((): SteerAck => ({ outcome: 'notRunning' }));
	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

const okResult = (turnId: string): RunTurnResult => ({ status: 'completed', text: `done-${turnId}`, sessionFresh: true, acpSessionId: 'acp-1' });

function mkInput(overrides: Partial<RunTurnInput> & Pick<RunTurnInput, 'turnId' | 'roomId'>): RunTurnInput {
	return {
		sessionKey: `${overrides.roomId}:key`,
		senderName: 'Alice',
		prompt: 'hi',
		promptFull: 'hi',
		resume: false,
		savedSessionId: undefined,
		policy: 'auto',
		idleTimeoutMs: 10_000,
		deadlineMs: Date.now() + 60_000,
		onChunk: () => undefined,
		onToolUse: () => undefined,
		onActivity: () => undefined,
		...overrides,
	};
}

describe('AdapterPool', () => {
	let sessions: Map<string, FakeRoomSession>;
	let onReap: (roomId: string, reason: 'lru-cap' | 'idle-timeout' | 'shutdown') => void;

	beforeEach(() => {
		sessions = new Map();
		onReap = vi.fn((_roomId: string, _reason: 'lru-cap' | 'idle-timeout' | 'shutdown') => undefined);
	});
	afterEach(() => vi.useRealTimers());

	function setup(opts: Partial<{ maxRooms: number; idleReapMs: number }> = {}) {
		const pool = new AdapterPool({
			maxRooms: opts.maxRooms ?? 8,
			idleReapMs: opts.idleReapMs ?? 10_000,
			createSession: (roomId) => {
				const session = new FakeRoomSession();
				sessions.set(roomId, session);
				return session;
			},
			onReap,
		});
		return pool;
	}

	it('spawns exactly one process per room and reuses it for a second turn in the same room', async () => {
		const pool = setup();
		const p1 = pool.runTurn(mkInput({ turnId: 't1', roomId: 'room-a' }));
		await vi.waitFor(() => expect(sessions.get('room-a')?.calls).toHaveLength(1));
		sessions.get('room-a')!.resolveTurn('t1', okResult('t1'));
		await p1;

		const p2 = pool.runTurn(mkInput({ turnId: 't2', roomId: 'room-a' }));
		await vi.waitFor(() => expect(sessions.get('room-a')?.calls).toHaveLength(2));
		sessions.get('room-a')!.resolveTurn('t2', okResult('t2'));
		await p2;
		expect(sessions.size).toBe(1);
		expect(pool.roomCount).toBe(1);
	});

	it('runs different rooms concurrently against separate processes', async () => {
		const pool = setup();
		const pa = pool.runTurn(mkInput({ turnId: 'ta', roomId: 'room-a' }));
		const pb = pool.runTurn(mkInput({ turnId: 'tb', roomId: 'room-b' }));
		await vi.waitFor(() => {
			expect(sessions.get('room-a')?.calls).toHaveLength(1);
			expect(sessions.get('room-b')?.calls).toHaveLength(1);
		});
		expect(sessions.size).toBe(2);
		sessions.get('room-a')!.resolveTurn('ta', okResult('ta'));
		sessions.get('room-b')!.resolveTurn('tb', okResult('tb'));
		await Promise.all([pa, pb]);
	});

	it('routes cancelTurn to the room that owns the turnId, via the explicit turnId -> room map', async () => {
		const pool = setup();
		const pa = pool.runTurn(mkInput({ turnId: 'ta', roomId: 'room-a' }));
		const pb = pool.runTurn(mkInput({ turnId: 'tb', roomId: 'room-b' }));
		await vi.waitFor(() => {
			expect(sessions.get('room-a')?.calls).toHaveLength(1);
			expect(sessions.get('room-b')?.calls).toHaveLength(1);
		});

		pool.cancelTurn('tb');
		expect(sessions.get('room-b')!.cancelTurn).toHaveBeenCalledWith('tb');
		expect(sessions.get('room-a')!.cancelTurn).not.toHaveBeenCalled();

		sessions.get('room-a')!.resolveTurn('ta', okResult('ta'));
		sessions.get('room-b')!.resolveTurn('tb', { status: 'cancelled', text: '', sessionFresh: true, acpSessionId: 'acp-1' });
		await Promise.all([pa, pb]);
	});

	it('routes steer to the room that owns the turnId, via the same turnId -> room map cancelTurn uses', async () => {
		const pool = setup();
		const pa = pool.runTurn(mkInput({ turnId: 'ta', roomId: 'room-a' }));
		const pb = pool.runTurn(mkInput({ turnId: 'tb', roomId: 'room-b' }));
		await vi.waitFor(() => {
			expect(sessions.get('room-a')?.calls).toHaveLength(1);
			expect(sessions.get('room-b')?.calls).toHaveLength(1);
		});

		sessions.get('room-b')!.steer.mockReturnValue({ outcome: 'unsupported' });
		const ack = pool.steer('tb', 'hello', Date.now() + 1000);
		expect(ack).toEqual({ outcome: 'unsupported' });
		expect(sessions.get('room-b')!.steer).toHaveBeenCalledWith('tb', 'hello', expect.any(Number));
		expect(sessions.get('room-a')!.steer).not.toHaveBeenCalled();

		sessions.get('room-a')!.resolveTurn('ta', okResult('ta'));
		sessions.get('room-b')!.resolveTurn('tb', okResult('tb'));
		await Promise.all([pa, pb]);
	});

	it('steer for an unknown/unrouted turnId answers notRunning without touching any room', async () => {
		const pool = setup();
		expect(pool.steer('ghost', 'hi', Date.now())).toEqual({ outcome: 'notRunning' });
	});

	it('reaps the least-recently-used IDLE room to make space at the cap, never a busy one', async () => {
		const pool = setup({ maxRooms: 2 });
		const pa = pool.runTurn(mkInput({ turnId: 'ta', roomId: 'room-a' }));
		await vi.waitFor(() => expect(sessions.get('room-a')?.calls).toHaveLength(1));
		sessions.get('room-a')!.resolveTurn('ta', okResult('ta'));
		await pa; // room-a now idle

		const pb = pool.runTurn(mkInput({ turnId: 'tb', roomId: 'room-b' })); // room-b becomes busy (never resolved yet)
		await vi.waitFor(() => expect(sessions.get('room-b')?.calls).toHaveLength(1));

		// Cap is 2 and both slots are taken (room-a idle, room-b busy); a 3rd room
		// must reap the only idle one (room-a), never the busy room-b.
		const pc = pool.runTurn(mkInput({ turnId: 'tc', roomId: 'room-c' }));
		await vi.waitFor(() => expect(sessions.get('room-c')?.calls).toHaveLength(1));
		expect(sessions.get('room-a')!.disposed).toBe(true);
		expect(onReap).toHaveBeenCalledWith('room-a', 'lru-cap');
		expect(sessions.get('room-b')!.disposed).toBe(false);

		sessions.get('room-b')!.resolveTurn('tb', okResult('tb'));
		sessions.get('room-c')!.resolveTurn('tc', okResult('tc'));
		await Promise.all([pb, pc]);
	});

	it('answers harness_busy when the cap is full and every room is busy', async () => {
		const pool = setup({ maxRooms: 1 });
		const pa = pool.runTurn(mkInput({ turnId: 'ta', roomId: 'room-a' }));
		await vi.waitFor(() => expect(sessions.get('room-a')?.calls).toHaveLength(1));

		await expect(pool.runTurn(mkInput({ turnId: 'tb', roomId: 'room-b' }))).rejects.toBeInstanceOf(HarnessBusyError);

		sessions.get('room-a')!.resolveTurn('ta', okResult('ta'));
		await pa;
	});

	it('reaps an idle room after idleReapMs, via the room\'s own dispose (SIGTERM/SIGKILL path)', async () => {
		// FakeRoomSession registers the call synchronously (before its first
		// await), so there is no real async gap to wait out here — fake timers
		// and real `vi.waitFor` polling would otherwise fight each other.
		vi.useFakeTimers();
		const pool = setup({ idleReapMs: 1_000 });
		const p1 = pool.runTurn(mkInput({ turnId: 't1', roomId: 'room-a' }));
		expect(sessions.get('room-a')?.calls).toHaveLength(1);
		sessions.get('room-a')!.resolveTurn('t1', okResult('t1'));
		await p1;

		await vi.advanceTimersByTimeAsync(1_001);
		expect(sessions.get('room-a')!.disposed).toBe(true);
		expect(onReap).toHaveBeenCalledWith('room-a', 'idle-timeout');
		expect(pool.roomCount).toBe(0);
	});

	it('never reaps a room while a turn is in flight, even past the idle deadline', async () => {
		vi.useFakeTimers();
		const pool = setup({ idleReapMs: 1_000 });
		void pool.runTurn(mkInput({ turnId: 't1', roomId: 'room-a' }));
		expect(sessions.get('room-a')?.calls).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(5_000); // no idle timer was armed while busy -> nothing to fire
		expect(sessions.get('room-a')!.disposed).toBe(false);

		sessions.get('room-a')!.resolveTurn('t1', okResult('t1'));
	});

	it('dispose() reaps every pooled room', async () => {
		const pool = setup();
		const p1 = pool.runTurn(mkInput({ turnId: 't1', roomId: 'room-a' }));
		await vi.waitFor(() => expect(sessions.get('room-a')?.calls).toHaveLength(1));
		sessions.get('room-a')!.resolveTurn('t1', okResult('t1'));
		await p1;

		await pool.dispose();
		expect(sessions.get('room-a')!.disposed).toBe(true);
		expect(pool.roomCount).toBe(0);
	});
});
