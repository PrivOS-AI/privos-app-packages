import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpSession, RunTurnInput, RunTurnResult, SteerAck } from '../src/acp/acp-session.js';
import type { AgentHarnessTurnStartParams, HubRelayClient } from '../src/hub-relay-client.js';

let fakeHome: string;
vi.mock('node:os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:os')>();
	return { ...actual, homedir: () => fakeHome };
});

const { TurnRunner } = await import('../src/turn-runner.js');

class FakeSession {
	calls: RunTurnInput[] = [];
	cancelCalls: string[] = [];
	private resolvers = new Map<string, (result: RunTurnResult) => void>();

	async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
		this.calls.push(input);
		return new Promise<RunTurnResult>((resolve) => {
			this.resolvers.set(input.turnId, resolve);
		});
	}

	resolveTurn(turnId: string, result: RunTurnResult): void {
		this.resolvers.get(turnId)?.(result);
	}

	cancelTurn(turnId: string): void {
		this.cancelCalls.push(turnId);
	}

	steerCalls: { turnId: string; text: string; deadlineMs: number }[] = [];
	steerReturn: SteerAck = { outcome: 'notRunning' };

	steer(turnId: string, text: string, deadlineMs: number): SteerAck {
		this.steerCalls.push({ turnId, text, deadlineMs });
		return this.steerReturn;
	}
}

function mkParams(overrides: Partial<AgentHarnessTurnStartParams> & { turnId: string; sessionKey: string }): AgentHarnessTurnStartParams {
	return {
		roomId: 'room-1',
		prompt: 'hello',
		promptFull: 'hello (full)',
		displayPrompt: 'hello',
		sender: { _id: 'u1', name: 'Alice' },
		resume: false,
		deadlineMs: Date.now() + 60_000,
		...overrides,
	};
}

const okResult = (turnId: string): RunTurnResult => ({ status: 'completed', text: `done-${turnId}`, sessionFresh: true, acpSessionId: 'acp-1' });

describe('TurnRunner', () => {
	beforeEach(() => {
		fakeHome = mkdtempSync(join(tmpdir(), 'agent-harness-turnrunner-test-'));
	});
	afterEach(() => {
		rmSync(fakeHome, { recursive: true, force: true });
	});

	function setup() {
		const session = new FakeSession();
		const notify = vi.fn();
		const runner = new TurnRunner({
			agentId: 'agent-x',
			session: session as unknown as AcpSession,
			policy: 'auto',
			idleTimeoutMs: 10_000,
			adapterId: 'claude',
			cwd: '/workspace',
		});
		runner.attachRelay({ notify } as unknown as HubRelayClient);
		return { session, notify, runner };
	}

	it('accepts the first turn for a session with queued: 0 and eventually notifies turn.done', async () => {
		const { session, notify, runner } = setup();
		const result = await runner.onTurnStart(mkParams({ turnId: 't1', sessionKey: 'room:1' }));
		expect(result).toEqual({ accepted: true, queued: 0 });
		await vi.waitFor(() => expect(session.calls).toHaveLength(1));
		session.resolveTurn('t1', okResult('t1'));
		await vi.waitFor(() =>
			expect(notify).toHaveBeenCalledWith('turn.done', expect.objectContaining({ turnId: 't1', status: 'completed' })),
		);
	});

	it('queues a second turn for the same sessionKey behind the first, and runs a different room in parallel-arrival order', async () => {
		const { session, runner } = setup();
		const first = await runner.onTurnStart(mkParams({ turnId: 't1', sessionKey: 'room:1' }));
		const second = await runner.onTurnStart(mkParams({ turnId: 't2', sessionKey: 'room:1' }));
		const otherRoom = await runner.onTurnStart(mkParams({ turnId: 't3', sessionKey: 'room:2' }));
		expect(first).toEqual({ accepted: true, queued: 0 });
		expect(second).toEqual({ accepted: true, queued: 1 });
		// A fresh sessionKey has no pending turns of its own yet, regardless of global queue position.
		expect(otherRoom).toEqual({ accepted: true, queued: 0 });

		await vi.waitFor(() => expect(session.calls.map((c) => c.turnId)).toEqual(['t1']));
		session.resolveTurn('t1', okResult('t1'));
		await vi.waitFor(() => expect(session.calls.map((c) => c.turnId)).toEqual(['t1', 't2']));
		session.resolveTurn('t2', okResult('t2'));
		await vi.waitFor(() => expect(session.calls.map((c) => c.turnId)).toEqual(['t1', 't2', 't3']));
		session.resolveTurn('t3', okResult('t3'));
	});

	it('rejects a 6th pending turn for the same sessionKey with harness_busy', async () => {
		const { runner } = setup();
		for (let i = 1; i <= 5; i++) {
			await runner.onTurnStart(mkParams({ turnId: `t${i}`, sessionKey: 'room:busy' }));
		}
		await expect(runner.onTurnStart(mkParams({ turnId: 't6', sessionKey: 'room:busy' }))).rejects.toThrow('harness_busy');
	});

	it('removes a queued (not yet started) turn on cancel and notifies turn.done cancelled', async () => {
		const { session, notify, runner } = setup();
		await runner.onTurnStart(mkParams({ turnId: 't1', sessionKey: 'room:1' })); // starts running immediately
		await runner.onTurnStart(mkParams({ turnId: 't2', sessionKey: 'room:1' })); // stays queued
		await vi.waitFor(() => expect(session.calls.map((c) => c.turnId)).toEqual(['t1']));

		runner.onTurnCancel({ turnId: 't2' });
		expect(notify).toHaveBeenCalledWith('turn.done', expect.objectContaining({ turnId: 't2', status: 'cancelled' }));

		session.resolveTurn('t1', okResult('t1'));
		// t2 was removed from the queue, so the loop has nothing left to run for it.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(session.calls.map((c) => c.turnId)).toEqual(['t1']);
	});

	it('forwards cancel of the currently running turn to session.cancelTurn', async () => {
		const { session, runner } = setup();
		await runner.onTurnStart(mkParams({ turnId: 't1', sessionKey: 'room:1' }));
		await vi.waitFor(() => expect(session.calls).toHaveLength(1));
		runner.onTurnCancel({ turnId: 't1' });
		expect(session.cancelCalls).toEqual(['t1']);
		session.resolveTurn('t1', { status: 'cancelled', text: '', sessionFresh: true, acpSessionId: 'acp-1' });
	});

	it('answers a turn that is still queued past its deadline with "queued past deadline" and never runs it', async () => {
		const { session, notify, runner } = setup();
		await runner.onTurnStart(mkParams({ turnId: 't1', sessionKey: 'room:1' })); // holds the loop open
		await runner.onTurnStart(mkParams({ turnId: 't2', sessionKey: 'room:1', deadlineMs: Date.now() - 1 }));
		await vi.waitFor(() => expect(session.calls.map((c) => c.turnId)).toEqual(['t1']));

		session.resolveTurn('t1', okResult('t1'));
		await vi.waitFor(() =>
			expect(notify).toHaveBeenCalledWith(
				'turn.done',
				expect.objectContaining({ turnId: 't2', status: 'failed', errorMessage: 'queued past deadline' }),
			),
		);
		expect(session.calls.map((c) => c.turnId)).toEqual(['t1']); // t2 never reached runTurn
	});

	it('records adapter/cwd on the session-store entry alongside the acpSessionId', async () => {
		const { session, runner } = setup();
		await runner.onTurnStart(mkParams({ turnId: 't1', sessionKey: 'room:1' }));
		await vi.waitFor(() => expect(session.calls).toHaveLength(1));
		session.resolveTurn('t1', okResult('t1'));

		const sessionStore = await import('../src/session-store.js');
		await vi.waitFor(() => expect(sessionStore.getSession('agent-x', 'room:1')?.acpSessionId).toBe('acp-1'));
		expect(sessionStore.getSession('agent-x', 'room:1')?.adapter).toBe('claude');
		expect(sessionStore.getSession('agent-x', 'room:1')?.cwd).toBe('/workspace');
	});

	describe('onTurnSteer (phase-04)', () => {
		it('a queued (not yet started) turn is never steered — answers notRunning without reaching session.steer', async () => {
			const { session, runner } = setup();
			await runner.onTurnStart(mkParams({ turnId: 't1', sessionKey: 'room:1' })); // running
			await runner.onTurnStart(mkParams({ turnId: 't2', sessionKey: 'room:1' })); // queued
			await vi.waitFor(() => expect(session.calls.map((c) => c.turnId)).toEqual(['t1']));

			const ack = await runner.onTurnSteer({ turnId: 't2', roomId: 'room-1', steerId: 's1', text: 'hi', deadlineMs: Date.now() + 1000 });
			expect(ack).toEqual({ outcome: 'notRunning' });
			expect(session.steerCalls).toHaveLength(0);

			session.resolveTurn('t1', okResult('t1'));
			session.resolveTurn('t2', okResult('t2'));
		});

		it('routes to session.steer for the currently running turn and relays an immediate notRunning/unsupported ack', async () => {
			const { session, runner } = setup();
			await runner.onTurnStart(mkParams({ turnId: 't1', sessionKey: 'room:1' }));
			await vi.waitFor(() => expect(session.calls).toHaveLength(1));

			session.steerReturn = { outcome: 'unsupported' };
			const ack = await runner.onTurnSteer({ turnId: 't1', roomId: 'room-1', steerId: 's1', text: 'hi', deadlineMs: 42 });
			expect(ack).toEqual({ outcome: 'unsupported' });
			expect(session.steerCalls).toEqual([{ turnId: 't1', text: 'hi', deadlineMs: 42 }]);

			session.resolveTurn('t1', okResult('t1'));
		});

		it('an accepted steer acks immediately and reports the eventual outcome via turn.steer-result', async () => {
			const { session, notify, runner } = setup();
			await runner.onTurnStart(mkParams({ turnId: 't1', sessionKey: 'room:1' }));
			await vi.waitFor(() => expect(session.calls).toHaveLength(1));

			let resolveResult: (outcome: 'injected' | 'dropped') => void;
			session.steerReturn = { outcome: 'accepted', result: new Promise((resolve) => (resolveResult = resolve)) };

			const ack = await runner.onTurnSteer({ turnId: 't1', roomId: 'room-1', steerId: 's1', text: 'hi', deadlineMs: 42 });
			expect(ack).toEqual({ outcome: 'accepted' });
			expect(notify).not.toHaveBeenCalledWith('turn.steer-result', expect.anything());

			resolveResult!('injected');
			await vi.waitFor(() =>
				expect(notify).toHaveBeenCalledWith('turn.steer-result', { turnId: 't1', steerId: 's1', outcome: 'injected' }),
			);

			session.resolveTurn('t1', okResult('t1'));
		});

		it('a rejected steer result promise still reports dropped (never hangs the hub)', async () => {
			const { session, notify, runner } = setup();
			await runner.onTurnStart(mkParams({ turnId: 't1', sessionKey: 'room:1' }));
			await vi.waitFor(() => expect(session.calls).toHaveLength(1));

			session.steerReturn = { outcome: 'accepted', result: Promise.reject(new Error('boom')) };
			await runner.onTurnSteer({ turnId: 't1', roomId: 'room-1', steerId: 's1', text: 'hi', deadlineMs: 42 });

			await vi.waitFor(() =>
				expect(notify).toHaveBeenCalledWith('turn.steer-result', { turnId: 't1', steerId: 's1', outcome: 'dropped' }),
			);

			session.resolveTurn('t1', okResult('t1'));
		});
	});

	it('onResetSessions clears the on-disk session store for this agent', async () => {
		const { runner } = setup();
		const sessionStore = await import('../src/session-store.js');
		sessionStore.setSession('agent-x', 'room:1', 'acp-old');
		expect(sessionStore.getSession('agent-x', 'room:1')?.acpSessionId).toBe('acp-old');
		runner.onResetSessions();
		expect(sessionStore.getSession('agent-x', 'room:1')).toBeUndefined();
	});
});
