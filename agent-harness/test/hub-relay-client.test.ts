import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessBusyError, HubRelayClient, type HubRelayHandlers } from '../src/hub-relay-client.js';
import { FakeHub } from './fake-hub-server.js';

const GOOD_TOKEN = 'privos_good_token';

function fakeHandlers(overrides: Partial<HubRelayHandlers> = {}): HubRelayHandlers {
	return {
		onTurnStart: vi.fn(async () => ({ accepted: true as const, queued: 0 })),
		onTurnCancel: vi.fn(),
		onTurnSteer: vi.fn(async () => ({ outcome: 'accepted' as const })),
		onResetSessions: vi.fn(),
		...overrides,
	};
}

describe('HubRelayClient', () => {
	let hub: FakeHub;
	let hubUrl: string;
	let client: HubRelayClient | undefined;

	beforeEach(async () => {
		hub = new FakeHub(GOOD_TOKEN);
		hubUrl = await hub.listen();
	});
	afterEach(async () => {
		client?.stop();
		await hub.close();
	});

	it('connects, sends harness.hello, and exposes the result', async () => {
		client = new HubRelayClient({ hubUrl, botToken: GOOD_TOKEN, hello: helloParams(), handlers: fakeHandlers() });
		client.start();
		await vi.waitFor(() => expect(client!.hello).toEqual({ agentRoomId: 'agent-room-1', respondTo: 'owner' }));
		expect(client.isConnected()).toBe(true);
	});

	it('dispatches turn.start to the handler and relays its result', async () => {
		const onTurnStart = vi.fn(async () => ({ accepted: true as const, queued: 2 }));
		client = new HubRelayClient({ hubUrl, botToken: GOOD_TOKEN, hello: helloParams(), handlers: fakeHandlers({ onTurnStart }) });
		client.start();
		await vi.waitFor(() => expect(client!.hello).toBeDefined());

		const response = await hub.sendRequest('turn.start', { turnId: 't1' });
		expect(onTurnStart).toHaveBeenCalledWith({ turnId: 't1' });
		expect(response.result).toEqual({ accepted: true, queued: 2 });
	});

	it('converts HarnessBusyError into a JSON-RPC error with data.code === "harness_busy"', async () => {
		const onTurnStart = vi.fn(async () => {
			throw new HarnessBusyError();
		});
		client = new HubRelayClient({ hubUrl, botToken: GOOD_TOKEN, hello: helloParams(), handlers: fakeHandlers({ onTurnStart }) });
		client.start();
		await vi.waitFor(() => expect(client!.hello).toBeDefined());

		const response = await hub.sendRequest('turn.start', { turnId: 't1' });
		expect(response.error?.data).toEqual({ code: 'harness_busy' });
	});

	it('dispatches turn.steer to the handler and relays its ack', async () => {
		const onTurnSteer = vi.fn(async () => ({ outcome: 'notRunning' as const }));
		client = new HubRelayClient({ hubUrl, botToken: GOOD_TOKEN, hello: helloParams(), handlers: fakeHandlers({ onTurnSteer }) });
		client.start();
		await vi.waitFor(() => expect(client!.hello).toBeDefined());

		const response = await hub.sendRequest('turn.steer', { turnId: 't1', roomId: 'room-1', steerId: 's1', text: 'hi', deadlineMs: 123 });
		expect(onTurnSteer).toHaveBeenCalledWith({ turnId: 't1', roomId: 'room-1', steerId: 's1', text: 'hi', deadlineMs: 123 });
		expect(response.result).toEqual({ outcome: 'notRunning' });
	});

	it('notify() forwards turn.steer-result to the hub', async () => {
		client = new HubRelayClient({ hubUrl, botToken: GOOD_TOKEN, hello: helloParams(), handlers: fakeHandlers() });
		client.start();
		await vi.waitFor(() => expect(client!.hello).toBeDefined());

		client.notify('turn.steer-result', { turnId: 't1', steerId: 's1', outcome: 'injected' });
		await vi.waitFor(() => expect(hub.notifications.map((n) => n.method)).toEqual(['turn.steer-result']));
		expect(hub.notifications[0]!.params).toEqual({ turnId: 't1', steerId: 's1', outcome: 'injected' });
	});

	it('routes turn.cancel and harness.resetSessions notifications to the handlers', async () => {
		const onTurnCancel = vi.fn();
		const onResetSessions = vi.fn();
		client = new HubRelayClient({ hubUrl, botToken: GOOD_TOKEN, hello: helloParams(), handlers: fakeHandlers({ onTurnCancel, onResetSessions }) });
		client.start();
		await vi.waitFor(() => expect(client!.hello).toBeDefined());

		hub.sendNotification('turn.cancel', { turnId: 't1' });
		hub.sendNotification('harness.resetSessions', {});
		await vi.waitFor(() => {
			expect(onTurnCancel).toHaveBeenCalledWith({ turnId: 't1' });
			expect(onResetSessions).toHaveBeenCalled();
		});
	});

	it('notify() forwards turn.chunk/turn.done to the hub and drops silently when disconnected', async () => {
		client = new HubRelayClient({ hubUrl, botToken: GOOD_TOKEN, hello: helloParams(), handlers: fakeHandlers() });
		client.start();
		await vi.waitFor(() => expect(client!.hello).toBeDefined());

		client.notify('turn.chunk', { turnId: 't1', chunk: 'hi', index: 0, isComplete: false });
		client.notify('turn.done', { turnId: 't1', status: 'completed', text: 'hi', sessionFresh: true });
		await vi.waitFor(() => expect(hub.notifications.map((n) => n.method)).toEqual(['turn.chunk', 'turn.done']));

		client.stop();
		expect(() => client!.notify('turn.chunk', { turnId: 't2', chunk: 'x', index: 0, isComplete: false })).not.toThrow();
	});

	it('close code 4409 is terminal with the replacing hostname and does not reconnect', async () => {
		client = new HubRelayClient({ hubUrl, botToken: GOOD_TOKEN, hello: helloParams(), handlers: fakeHandlers() });
		client.start();
		await vi.waitFor(() => expect(hub.readyConnections).toHaveLength(1));

		hub.readyConnections[0]!.close(4409, 'replaced by other-laptop');
		const reason = await client.whenTerminal;
		expect(reason).toEqual({ kind: 'replaced', hostname: 'replaced by other-laptop' });

		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(hub.readyConnections).toHaveLength(1); // no reconnect attempt
	});

	it('close code 4401 is terminal as revoked', async () => {
		client = new HubRelayClient({ hubUrl, botToken: GOOD_TOKEN, hello: helloParams(), handlers: fakeHandlers() });
		client.start();
		await vi.waitFor(() => expect(hub.readyConnections).toHaveLength(1));

		hub.readyConnections[0]!.close(4401, 'bot key rotated');
		await expect(client.whenTerminal).resolves.toEqual({ kind: 'revoked' });
	});

	it('HTTP 401 at the upgrade is terminal as revoked, without ever opening', async () => {
		hub.rejectStatus = 401;
		client = new HubRelayClient({ hubUrl, botToken: GOOD_TOKEN, hello: helloParams(), handlers: fakeHandlers() });
		client.start();
		await expect(client.whenTerminal).resolves.toEqual({ kind: 'revoked' });
		expect(client.isConnected()).toBe(false);
	});

	it('HTTP 403 at the upgrade is terminal as not_a_harness_agent', async () => {
		hub.rejectStatus = 403;
		client = new HubRelayClient({ hubUrl, botToken: GOOD_TOKEN, hello: helloParams(), handlers: fakeHandlers() });
		client.start();
		await expect(client.whenTerminal).resolves.toEqual({ kind: 'not_a_harness_agent' });
	});

	it('a non-terminal close reconnects and re-sends harness.hello', async () => {
		client = new HubRelayClient({ hubUrl, botToken: GOOD_TOKEN, hello: helloParams(), handlers: fakeHandlers() });
		client.start();
		await vi.waitFor(() => expect(hub.readyConnections).toHaveLength(1));

		hub.readyConnections[0]!.close(1001, 'going away');
		await vi.waitFor(() => expect(hub.readyConnections).toHaveLength(2), { timeout: 5_000, interval: 100 });
		expect(client.isConnected()).toBe(true);
	});
});

function helloParams() {
	return {
		adapter: 'claude',
		bridgeVersion: '0.1.0-test',
		hostname: 'test-host',
		cwd: '/tmp/workspace',
		permissions: 'auto',
		isolation: 'none' as const,
		capabilities: { loadSession: true },
		steering: true,
	};
}
