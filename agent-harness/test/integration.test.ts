/**
 * End-to-end wiring test: fake hub WS server (`fake-hub-server.ts`) <->
 * `HubRelayClient` <-> `TurnRunner` <-> `AcpSession` <-> real fake ACP agent
 * subprocess (`fake-acp-agent.ts`). This is the exact combination `cli.ts`'s
 * `start` command assembles at runtime, minus the CLI/config/env plumbing
 * already covered by their own unit tests.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterSpec } from '../src/acp/adapter-table.js';
import type { AcpSession as AcpSessionType } from '../src/acp/acp-session.js';
import type { HubRelayClient as HubRelayClientType } from '../src/hub-relay-client.js';
import type { TurnRunner as TurnRunnerType } from '../src/turn-runner.js';
import type { FakeHub as FakeHubType } from './fake-hub-server.js';

let fakeHome: string;
vi.mock('node:os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:os')>();
	return { ...actual, homedir: () => fakeHome };
});

const { AcpSession } = await import('../src/acp/acp-session.js');
const { HubRelayClient } = await import('../src/hub-relay-client.js');
const { TurnRunner } = await import('../src/turn-runner.js');
const { FakeHub } = await import('./fake-hub-server.js');

const here = dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = join(here, 'fake-acp-agent.ts');
const GOOD_TOKEN = 'privos_integration_token';

const spec: AdapterSpec = {
	id: 'custom',
	testedVersion: 'n/a',
	command: process.execPath,
	args: ['--experimental-strip-types', fakeAgentPath],
	systemPromptTransport: 'prefix',
	authHint: 'n/a',
	expectedLoadSession: true,
	steering: 'none',
	credentialFiles: [],
	realStateDir: () => '',
	writeNativeSandboxConfig: () => undefined,
};

describe('bridge integration: hub relay + turn runner + real ACP subprocess', () => {
	let hub: FakeHubType;
	let hubUrl: string;
	let workspace: string;
	let session: AcpSessionType;
	let relay: HubRelayClientType;
	let runner: TurnRunnerType;

	beforeEach(async () => {
		fakeHome = mkdtempSync(join(tmpdir(), 'agent-harness-integration-home-'));
		workspace = mkdtempSync(join(tmpdir(), 'agent-harness-integration-ws-'));
		hub = new FakeHub(GOOD_TOKEN);
		hubUrl = await hub.listen();

		session = new AcpSession(spec, { cwd: workspace, env: process.env, verbose: false, isolation: 'none', cancelGraceMs: 300 });
		runner = new TurnRunner({ agentId: 'integration-agent', session, policy: 'auto', idleTimeoutMs: 5_000 });
		relay = new HubRelayClient({
			hubUrl,
			botToken: GOOD_TOKEN,
			hello: {
				adapter: 'custom',
				bridgeVersion: '0.1.0-test',
				hostname: 'test-host',
				cwd: workspace,
				permissions: 'auto',
				isolation: 'none',
				capabilities: { loadSession: true },
				steering: false,
			},
			handlers: {
				onTurnStart: (p) => runner.onTurnStart(p),
				onTurnCancel: (p) => runner.onTurnCancel(p),
				onTurnSteer: (p) => runner.onTurnSteer(p),
				onResetSessions: () => runner.onResetSessions(),
				onConnectionChange: (c) => runner.onConnectionChange(c),
			},
		});
		runner.attachRelay(relay);
		relay.start();
		await vi.waitFor(() => expect(relay.hello).toBeDefined());
	});

	afterEach(async () => {
		relay.stop();
		await session.dispose();
		await hub.close();
		rmSync(workspace, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it('runs a full turn through the wire: turn.start -> chunks/tool_use -> turn.done(completed)', async () => {
		const startResponse = await hub.sendRequest('turn.start', {
			turnId: 'turn-1',
			sessionKey: 'room-1:agent',
			roomId: 'room-1',
			prompt: 'FAKE_SCENARIO=echo hello from the hub',
			promptFull: 'FAKE_SCENARIO=echo hello from the hub',
			displayPrompt: 'hello',
			sender: { _id: 'u1', name: 'Alice' },
			resume: false,
			deadlineMs: Date.now() + 10_000,
		});
		expect(startResponse.result).toEqual({ accepted: true, queued: 0 });

		await vi.waitFor(() => expect(hub.notifications.some((n) => n.method === 'turn.done')).toBe(true), { timeout: 5_000 });

		const chunkNotifications = hub.notifications.filter((n) => n.method === 'turn.chunk') as { params: { chunk: string; index: number } }[];
		expect(chunkNotifications.length).toBeGreaterThan(0);
		for (let i = 1; i < chunkNotifications.length; i++) {
			expect(chunkNotifications[i]!.params.chunk.length).toBeGreaterThanOrEqual(chunkNotifications[i - 1]!.params.chunk.length);
		}
		expect(hub.notifications.some((n) => n.method === 'turn.tool_use')).toBe(true);
		const done = hub.notifications.find((n) => n.method === 'turn.done')!.params as { status: string; text: string };
		expect(done.status).toBe('completed');
		expect(done.text).toContain('hello from the hub');
	});

	it('cancels a running turn on turn.cancel and the fake agent observes session/cancel', async () => {
		await hub.sendRequest('turn.start', {
			turnId: 'turn-cancel',
			sessionKey: 'room-2:agent',
			roomId: 'room-2',
			prompt: 'FAKE_SCENARIO=cancel_cooperative',
			promptFull: 'FAKE_SCENARIO=cancel_cooperative',
			displayPrompt: 'cancel me',
			sender: { _id: 'u1', name: 'Alice' },
			resume: false,
			deadlineMs: Date.now() + 10_000,
		});
		await vi.waitFor(() => expect(hub.notifications.some((n) => n.method === 'turn.chunk')).toBe(true));

		hub.sendNotification('turn.cancel', { turnId: 'turn-cancel' });
		await vi.waitFor(
			() => {
				const done = hub.notifications.find((n) => n.method === 'turn.done');
				expect(done?.params).toMatchObject({ status: 'cancelled' });
			},
			{ timeout: 5_000 },
		);
	});

	it('turn.steer end-to-end: ack accepted, then turn.steer-result injected once the adapter answers', async () => {
		await hub.sendRequest('turn.start', {
			turnId: 'turn-steer',
			sessionKey: 'room-4:agent',
			roomId: 'room-4',
			prompt: 'FAKE_SCENARIO=cancel_cooperative',
			promptFull: 'FAKE_SCENARIO=cancel_cooperative',
			displayPrompt: 'hold',
			sender: { _id: 'u1', name: 'Alice' },
			resume: false,
			deadlineMs: Date.now() + 10_000,
		});
		await vi.waitFor(() => expect(hub.notifications.some((n) => n.method === 'turn.chunk')).toBe(true));

		// This fixture's fake agent never advertised steering support (no
		// FAKE_STEERING_SUPPORTED on this describe block's env) -- the ack
		// itself must be `unsupported`, WITHOUT ever writing the request.
		const steerResponse = await hub.sendRequest('turn.steer', {
			turnId: 'turn-steer',
			roomId: 'room-4',
			steerId: 'steer-1',
			text: 'a new message',
			deadlineMs: Date.now() + 10_000,
		});
		expect(steerResponse.result).toEqual({ outcome: 'unsupported' });
		expect(hub.notifications.some((n) => n.method === 'turn.steer-result')).toBe(false); // unsupported never produces a result notification

		hub.sendNotification('turn.cancel', { turnId: 'turn-steer' });
		await vi.waitFor(() => expect(hub.notifications.find((n) => n.method === 'turn.done')?.params).toMatchObject({ status: 'cancelled' }));
	});

	it('turn.steer for a queued (not yet started) turn answers notRunning', async () => {
		await hub.sendRequest('turn.start', {
			turnId: 'turn-hold-2',
			sessionKey: 'room-5:agent',
			roomId: 'room-5',
			prompt: 'FAKE_SCENARIO=cancel_cooperative',
			promptFull: 'FAKE_SCENARIO=cancel_cooperative',
			displayPrompt: 'hold',
			sender: { _id: 'u1', name: 'Alice' },
			resume: false,
			deadlineMs: Date.now() + 10_000,
		});
		await vi.waitFor(() => expect(hub.notifications.some((n) => n.method === 'turn.chunk')).toBe(true));

		// Same sessionKey, same room -- second turn queues behind the first.
		await hub.sendRequest('turn.start', {
			turnId: 'turn-queued',
			sessionKey: 'room-5:agent',
			roomId: 'room-5',
			prompt: 'FAKE_SCENARIO=echo never runs yet',
			promptFull: 'FAKE_SCENARIO=echo never runs yet',
			displayPrompt: 'never yet',
			sender: { _id: 'u1', name: 'Alice' },
			resume: false,
			deadlineMs: Date.now() + 10_000,
		});

		const steerResponse = await hub.sendRequest('turn.steer', {
			turnId: 'turn-queued',
			roomId: 'room-5',
			steerId: 'steer-2',
			text: 'hi',
			deadlineMs: Date.now() + 10_000,
		});
		expect(steerResponse.result).toEqual({ outcome: 'notRunning' });

		hub.sendNotification('turn.cancel', { turnId: 'turn-queued' });
		hub.sendNotification('turn.cancel', { turnId: 'turn-hold-2' });
		// Wait for BOTH turn.done notifications (queued turns resolve
		// synchronously; the running one needs the real cancel round trip) so
		// `afterEach`'s `session.dispose()` never races an in-flight ACP request.
		await vi.waitFor(() => {
			const doneFor = (turnId: string) =>
				hub.notifications.find((n) => n.method === 'turn.done' && (n.params as { turnId?: string }).turnId === turnId)?.params;
			expect(doneFor('turn-queued')).toMatchObject({ status: 'cancelled' });
			expect(doneFor('turn-hold-2')).toMatchObject({ status: 'cancelled' });
		});
	});

	it('a deadline that expires while queued behind another turn is answered without ever running', async () => {
		// A short deadline on the holding turn lets the ACP session's own
		// deadline-then-SIGKILL path (cancelGraceMs: 300ms in beforeEach) free
		// the single FIFO loop quickly, so the second, already-expired turn
		// gets dequeued and skipped instead of waiting on a turn that never ends.
		await hub.sendRequest('turn.start', {
			turnId: 'turn-hold',
			sessionKey: 'room-3:agent',
			roomId: 'room-3',
			prompt: 'FAKE_SCENARIO=hang',
			promptFull: 'FAKE_SCENARIO=hang',
			displayPrompt: 'hang',
			sender: { _id: 'u1', name: 'Alice' },
			resume: false,
			deadlineMs: Date.now() + 300,
		});
		const queuedResponse = await hub.sendRequest('turn.start', {
			turnId: 'turn-too-late',
			sessionKey: 'room-3:agent',
			roomId: 'room-3',
			prompt: 'FAKE_SCENARIO=echo never runs',
			promptFull: 'FAKE_SCENARIO=echo never runs',
			displayPrompt: 'never',
			sender: { _id: 'u1', name: 'Alice' },
			resume: false,
			deadlineMs: Date.now() - 1,
		});
		expect(queuedResponse.result).toEqual({ accepted: true, queued: 1 });

		await vi.waitFor(
			() => {
				const done = hub.notifications.find((n) => (n.params as { turnId?: string }).turnId === 'turn-too-late');
				expect(done?.params).toMatchObject({ status: 'failed', errorMessage: 'queued past deadline' });
			},
			{ timeout: 5_000 },
		);
	});
});

describe('bridge integration: turn.steer with a steering-capable fake agent', () => {
	let hub: FakeHubType;
	let hubUrl: string;
	let workspace: string;
	let session: AcpSessionType;
	let relay: HubRelayClientType;
	let runner: TurnRunnerType;

	beforeEach(async () => {
		fakeHome = mkdtempSync(join(tmpdir(), 'agent-harness-integration-steer-home-'));
		workspace = mkdtempSync(join(tmpdir(), 'agent-harness-integration-steer-ws-'));
		hub = new FakeHub(GOOD_TOKEN);
		hubUrl = await hub.listen();
	});

	afterEach(async () => {
		relay.stop();
		await session.dispose();
		await hub.close();
		rmSync(workspace, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});

	// The child process's `_session/steering` scenario is chosen by an env var
	// baked into the process AT SPAWN -- a later mutation of the PARENT's
	// `process.env` is invisible to an already-running child, so each test
	// that needs a different `FAKE_STEERING_RESULT` builds its OWN stack here
	// rather than sharing one `session` from `beforeEach`.
	function buildStack(env: Record<string, string>): void {
		session = new AcpSession(spec, { cwd: workspace, env: { ...process.env, ...env }, verbose: false, isolation: 'none', cancelGraceMs: 300 });
		runner = new TurnRunner({ agentId: 'integration-steer-agent', session, policy: 'auto', idleTimeoutMs: 5_000 });
		relay = new HubRelayClient({
			hubUrl,
			botToken: GOOD_TOKEN,
			hello: {
				adapter: 'custom',
				bridgeVersion: '0.1.0-test',
				hostname: 'test-host',
				cwd: workspace,
				permissions: 'auto',
				isolation: 'none',
				capabilities: { loadSession: true },
				steering: true,
			},
			handlers: {
				onTurnStart: (p) => runner.onTurnStart(p),
				onTurnCancel: (p) => runner.onTurnCancel(p),
				onTurnSteer: (p) => runner.onTurnSteer(p),
				onResetSessions: () => runner.onResetSessions(),
				onConnectionChange: (c) => runner.onConnectionChange(c),
			},
		});
		runner.attachRelay(relay);
	}

	it('injected: ack accepted, then turn.steer-result injected on the SAME turnId', async () => {
		buildStack({ FAKE_STEERING_SUPPORTED: '1' });
		relay.start();
		await vi.waitFor(() => expect(relay.hello).toBeDefined());

		await hub.sendRequest('turn.start', {
			turnId: 'turn-steer-ok',
			sessionKey: 'room-6:agent',
			roomId: 'room-6',
			prompt: 'FAKE_SCENARIO=cancel_cooperative',
			promptFull: 'FAKE_SCENARIO=cancel_cooperative',
			displayPrompt: 'hold',
			sender: { _id: 'u1', name: 'Alice' },
			resume: false,
			deadlineMs: Date.now() + 10_000,
		});
		await vi.waitFor(() => expect(hub.notifications.some((n) => n.method === 'turn.chunk')).toBe(true));

		const steerResponse = await hub.sendRequest('turn.steer', {
			turnId: 'turn-steer-ok',
			roomId: 'room-6',
			steerId: 'steer-ok',
			text: 'a new message',
			deadlineMs: Date.now() + 10_000,
		});
		expect(steerResponse.result).toEqual({ outcome: 'accepted' });

		await vi.waitFor(() =>
			expect(hub.notifications.find((n) => n.method === 'turn.steer-result')?.params).toEqual({
				turnId: 'turn-steer-ok',
				steerId: 'steer-ok',
				outcome: 'injected',
			}),
		);

		hub.sendNotification('turn.cancel', { turnId: 'turn-steer-ok' }); // let the still-open held turn finish
		await vi.waitFor(() =>
			expect(hub.notifications.find((n) => n.method === 'turn.done')?.params).toMatchObject({ status: 'cancelled' }),
		);
	});

	it('startedNewTurn: the bridge writes session/cancel for the detached turn and reports dropped', async () => {
		// Baked in at spawn -- the child's `_session/steering` handler always
		// answers `startedNewTurn` for this stack.
		buildStack({ FAKE_STEERING_SUPPORTED: '1', FAKE_STEERING_RESULT: 'startedNewTurn' });
		relay.start();
		await vi.waitFor(() => expect(relay.hello).toBeDefined());

		await hub.sendRequest('turn.start', {
			turnId: 'turn-steer-detached',
			sessionKey: 'room-7:agent',
			roomId: 'room-7',
			prompt: 'FAKE_SCENARIO=cancel_cooperative',
			promptFull: 'FAKE_SCENARIO=cancel_cooperative',
			displayPrompt: 'hold',
			sender: { _id: 'u1', name: 'Alice' },
			resume: false,
			deadlineMs: Date.now() + 10_000,
		});
		await vi.waitFor(() => expect(hub.notifications.some((n) => n.method === 'turn.chunk')).toBe(true));

		const steerResponse = await hub.sendRequest('turn.steer', {
			turnId: 'turn-steer-detached',
			roomId: 'room-7',
			steerId: 'steer-detached',
			text: 'a new message',
			deadlineMs: Date.now() + 10_000,
		});
		expect(steerResponse.result).toEqual({ outcome: 'accepted' });

		await vi.waitFor(() =>
			expect(hub.notifications.find((n) => n.method === 'turn.steer-result')?.params).toEqual({
				turnId: 'turn-steer-detached',
				steerId: 'steer-detached',
				outcome: 'dropped',
			}),
		);

		// Proof the bridge really sent `session/cancel` for the held turn: the
		// `cancel_cooperative` fake-agent scenario only resolves `cancelled`
		// when it observes that notification, and it does so WITHOUT us ever
		// sending `turn.cancel` ourselves here.
		await vi.waitFor(() => {
			const done = hub.notifications.find((n) => n.method === 'turn.done');
			expect(done?.params).toMatchObject({ status: 'cancelled' });
		});
	});
});
