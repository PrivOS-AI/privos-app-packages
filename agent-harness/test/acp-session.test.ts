import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpSession, type RunTurnInput, type RunTurnResult } from '../src/acp/acp-session.js';
import type { AdapterSpec } from '../src/acp/adapter-table.js';

const here = dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = join(here, 'fake-acp-agent.ts');

const spec: AdapterSpec = {
	id: 'custom',
	testedVersion: 'n/a',
	command: process.execPath,
	args: ['--experimental-strip-types', fakeAgentPath],
	systemPromptTransport: 'prefix',
	authHint: 'n/a',
	installHint: 'n/a',
	expectedLoadSession: true,
	steering: 'none',
	credentialFiles: [],
	realStateDir: () => '',
	writeNativeSandboxConfig: () => undefined,
};

let workspace: string;
let session: AcpSession;

function baseInput(overrides: Partial<RunTurnInput> & Pick<RunTurnInput, 'turnId' | 'sessionKey' | 'prompt'>): RunTurnInput {
	return {
		roomId: 'room-1',
		senderName: 'Alice',
		promptFull: overrides.prompt,
		resume: false,
		savedSessionId: undefined,
		policy: 'auto',
		idleTimeoutMs: 5_000,
		deadlineMs: Date.now() + 10_000,
		onChunk: () => undefined,
		onToolUse: () => undefined,
		onActivity: () => undefined,
		...overrides,
	};
}

describe('AcpSession (real fake-acp-agent subprocess)', () => {
	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), 'agent-harness-acp-session-test-'));
		session = new AcpSession(spec, { cwd: workspace, env: process.env, verbose: false, isolation: 'none', cancelGraceMs: 300 });
	});
	afterEach(async () => {
		await session.dispose();
		rmSync(workspace, { recursive: true, force: true });
	});

	it('streams monotonically-accumulating chunks, a tool_use, and completes', async () => {
		const chunks: string[] = [];
		const toolUses: { toolId: string; toolName: string }[] = [];
		const result = await session.runTurn(
			baseInput({
				turnId: 't1',
				sessionKey: 'k1',
				prompt: 'FAKE_SCENARIO=echo say hi',
				onChunk: (chunk) => chunks.push(chunk),
				onToolUse: (tu) => toolUses.push(tu),
			}),
		);
		expect(result.status).toBe('completed');
		expect(result.sessionFresh).toBe(true);
		expect(result.text).toContain('Echo: ');
		expect(result.text).toContain('FAKE_SCENARIO=echo say hi');
		// Chunks strictly grow (accumulated-text contract, never a delta).
		for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.length).toBeGreaterThanOrEqual(chunks[i - 1]!.length);
		expect(toolUses).toEqual([expect.objectContaining({ toolId: 'search-1', toolName: 'Search files' })]);
	});

	it('cancel mid-turn resolves as cancelled once the adapter cooperates', async () => {
		const resultPromise = session.runTurn(baseInput({ turnId: 't2', sessionKey: 'k2', prompt: 'FAKE_SCENARIO=cancel_cooperative' }));
		// Give the fake agent time to stream its first chunk and start waiting on cancel.
		await new Promise((resolve) => setTimeout(resolve, 200));
		session.cancelTurn('t2');
		const result = await resultPromise;
		expect(result.status).toBe('cancelled');
	});

	it('deadline expiry kills an unresponsive adapter and reports failed', async () => {
		const result = await session.runTurn(
			baseInput({ turnId: 't3', sessionKey: 'k3', prompt: 'FAKE_SCENARIO=hang', deadlineMs: Date.now() + 150 }),
		);
		expect(result.status).toBe('failed');
		expect(result.errorMessage).toMatch(/did not respond to cancellation/);
	});

	it.each([
		['auto', 'read=allow_once execute=allow_once'],
		['safe', 'read=allow_once execute=reject_once'],
		['deny', 'read=reject_once execute=reject_once'],
	] as const)('permission policy %s decides by kind: %s', async (policy, expectedText) => {
		const result = await session.runTurn(
			baseInput({ turnId: `t-perm-${policy}`, sessionKey: `k-perm-${policy}`, prompt: 'FAKE_SCENARIO=permission', policy }),
		);
		expect(result.status).toBe('completed');
		expect(result.text).toContain(expectedText);
	});

	it('session/load replay never reaches the turn.chunk accumulator', async () => {
		const first = await session.runTurn(baseInput({ turnId: 't4a', sessionKey: 'k4', prompt: 'FAKE_SCENARIO=echo first' }));
		expect(first.sessionFresh).toBe(true);

		const chunks: string[] = [];
		const second: RunTurnResult = await session.runTurn(
			baseInput({
				turnId: 't4b',
				sessionKey: 'k4',
				prompt: 'FAKE_SCENARIO=echo second',
				savedSessionId: first.acpSessionId,
				onChunk: (chunk) => chunks.push(chunk),
			}),
		);
		expect(second.sessionFresh).toBe(false); // session/load succeeded, reusing the same ACP session
		expect(second.acpSessionId).toBe(first.acpSessionId);
		expect(second.text).not.toContain('REPLAYED-HISTORY-SHOULD-NEVER-STREAM-AS-A-TURN-CHUNK');
		for (const chunk of chunks) expect(chunk).not.toContain('REPLAYED-HISTORY-SHOULD-NEVER-STREAM-AS-A-TURN-CHUNK');
	});

	describe('mid-turn steer (phase-04)', () => {
		/** A fresh session with its OWN env (steering support/result are per-process env vars on the fake agent). Disposed by the caller. */
		function steerSession(env: Partial<NodeJS.ProcessEnv>): AcpSession {
			return new AcpSession(spec, { cwd: workspace, env: { ...process.env, ...env }, verbose: false, isolation: 'none', cancelGraceMs: 300 });
		}

		/** Polls (never a fixed sleep -- flaky under parallel test-file load) until `predicate()` is true or `timeoutMs` elapses. */
		function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
			return new Promise((resolve, reject) => {
				const start = Date.now();
				const tick = (): void => {
					if (predicate()) {
						resolve();
						return;
					}
					if (Date.now() - start > timeoutMs) {
						reject(new Error('waitUntil timed out'));
						return;
					}
					setTimeout(tick, 20);
				};
				tick();
			});
		}

		/**
		 * Starts a `cancel_cooperative` held turn and awaits its first streamed
		 * chunk -- proof the turn is genuinely CURRENT (past `initialize`,
		 * `session/new`, and into `session/prompt`) before `steer()` is called
		 * against it, regardless of system load. `idleTimeoutMs`/`deadlineMs`
		 * are generous (60s) because a heavily loaded test run (many parallel
		 * subprocess spawns across the whole suite) can leave the FIRST chunk
		 * arriving several seconds late -- the default 5s idle timer would
		 * otherwise race and end the turn before `steer()` ever runs.
		 *
		 * Returns the STILL-PENDING run promise wrapped in an object -- an
		 * `async function` that `return`s a promise directly would AUTO-CHAIN
		 * onto it (the caller's `await startHeldTurn(...)` would then wait for
		 * the whole held turn to finish before ever getting a value back,
		 * deadlocking against the very `steer()`/`cancelTurn()` calls that are
		 * supposed to end it).
		 */
		async function startHeldTurn(
			session2: AcpSession,
			turnId: string,
			sessionKey: string,
		): Promise<{ runPromise: Promise<RunTurnResult> }> {
			let chunked = false;
			const runPromise = session2.runTurn(
				baseInput({
					turnId,
					sessionKey,
					prompt: 'FAKE_SCENARIO=cancel_cooperative',
					idleTimeoutMs: 60_000,
					deadlineMs: Date.now() + 60_000,
					onChunk: () => (chunked = true),
				}),
			);
			await waitUntil(() => chunked, 60_000);
			return { runPromise };
		}

		it('supported + injected: writes the _session/steering request and resolves injected', async () => {
			const session2 = steerSession({ FAKE_STEERING_SUPPORTED: '1', FAKE_STEERING_RESULT: 'injected' });
			try {
				const { runPromise } = await startHeldTurn(session2, 't-steer-1', 'k-steer-1');

				const ack = session2.steer('t-steer-1', 'a new message', Date.now() + 60_000);
				expect(ack.outcome).toBe('accepted');
				const outcome = await (ack as { outcome: 'accepted'; result: Promise<'injected' | 'dropped'> }).result;
				expect(outcome).toBe('injected');

				session2.cancelTurn('t-steer-1'); // let the held turn finish
				const result = await runPromise;
				expect(result.status).toBe('cancelled');
			} finally {
				await session2.dispose();
			}
		});

		it('unsupported: steer() returns unsupported synchronously WITHOUT ever writing a _session/steering request', async () => {
			const session2 = steerSession({}); // FAKE_STEERING_SUPPORTED unset
			try {
				const { runPromise } = await startHeldTurn(session2, 't-steer-2', 'k-steer-2');

				const ack = session2.steer('t-steer-2', 'a new message', Date.now() + 60_000);
				expect(ack).toEqual({ outcome: 'unsupported' });

				session2.cancelTurn('t-steer-2');
				await runPromise;

				// Prove nothing was ever written: a second turn on the SAME process
				// reports zero received _session/steering requests.
				const report = await session2.runTurn(
					baseInput({ turnId: 't-steer-2b', sessionKey: 'k-steer-2', prompt: 'FAKE_SCENARIO=report_steering_count' }),
				);
				expect(report.text).toContain('steering_calls=0');
			} finally {
				await session2.dispose();
			}
		});

		it('no in-flight turn: steer() returns notRunning without touching the adapter', async () => {
			const session2 = steerSession({ FAKE_STEERING_SUPPORTED: '1' });
			try {
				expect(session2.steer('no-such-turn', 'hi', Date.now() + 60_000)).toEqual({ outcome: 'notRunning' });
			} finally {
				await session2.dispose();
			}
		});

		it('a bare {} response (no outcome field) resolves dropped', async () => {
			const session2 = steerSession({ FAKE_STEERING_SUPPORTED: '1', FAKE_STEERING_RESULT: 'empty' });
			try {
				const { runPromise } = await startHeldTurn(session2, 't-steer-3', 'k-steer-3');

				const ack = session2.steer('t-steer-3', 'a new message', Date.now() + 60_000);
				const outcome = await (ack as { outcome: 'accepted'; result: Promise<'injected' | 'dropped'> }).result;
				expect(outcome).toBe('dropped');

				session2.cancelTurn('t-steer-3');
				await runPromise;
			} finally {
				await session2.dispose();
			}
		});

		it('promptRequired (the turn ended in the gap) resolves dropped', async () => {
			const session2 = steerSession({ FAKE_STEERING_SUPPORTED: '1', FAKE_STEERING_RESULT: 'promptRequired' });
			try {
				const { runPromise } = await startHeldTurn(session2, 't-steer-4', 'k-steer-4');

				const ack = session2.steer('t-steer-4', 'a new message', Date.now() + 60_000);
				const outcome = await (ack as { outcome: 'accepted'; result: Promise<'injected' | 'dropped'> }).result;
				expect(outcome).toBe('dropped');

				session2.cancelTurn('t-steer-4');
				await runPromise;
			} finally {
				await session2.dispose();
			}
		});

		it('startedNewTurn: the bridge sends session/cancel for that session, and resolves dropped (F11 — never answered twice)', async () => {
			const session2 = steerSession({ FAKE_STEERING_SUPPORTED: '1', FAKE_STEERING_RESULT: 'startedNewTurn' });
			try {
				const { runPromise } = await startHeldTurn(session2, 't-steer-5', 'k-steer-5');

				const ack = session2.steer('t-steer-5', 'a new message', Date.now() + 60_000);
				const outcome = await (ack as { outcome: 'accepted'; result: Promise<'injected' | 'dropped'> }).result;
				expect(outcome).toBe('dropped');

				// The ORIGINAL held turn must resolve `cancelled` on its own — proof
				// the bridge really issued `session/cancel` for it (the fake agent's
				// `cancel_cooperative` scenario only resolves that way on cancel).
				const result = await runPromise;
				expect(result.status).toBe('cancelled');
			} finally {
				await session2.dispose();
			}
		});

		it('turn.cancel while a steer is pending resolves the steer dropped immediately, without waiting for the adapter', async () => {
			const session2 = steerSession({ FAKE_STEERING_SUPPORTED: '1', FAKE_STEERING_RESULT: 'hang' });
			try {
				const { runPromise } = await startHeldTurn(session2, 't-steer-6', 'k-steer-6');

				const ack = session2.steer('t-steer-6', 'a new message', Date.now() + 60_000);
				expect(ack.outcome).toBe('accepted');

				session2.cancelTurn('t-steer-6'); // also aborts the pending (hanging) steer

				const outcome = await (ack as { outcome: 'accepted'; result: Promise<'injected' | 'dropped'> }).result;
				expect(outcome).toBe('dropped');

				const result = await runPromise;
				expect(result.status).toBe('cancelled');
			} finally {
				await session2.dispose();
			}
		});
	});
});
