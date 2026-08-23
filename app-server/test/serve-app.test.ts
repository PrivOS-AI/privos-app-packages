import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
	AGENT_BOT_CREDENTIAL_ENV_KEY,
	AGENT_BOT_USER_ID_ENV_KEY,
	readAgentBotCredential,
	resetAgentBotCredentialOutcomeForTests,
} from '../src/relay/agent-bot-credential.js';
import { RuntimeModeError, type RuntimeModeResolution } from '../src/runtime-mode.js';
import { serveApp, type ServeAppHandle, type ServeAppOptions } from '../src/serve-app.js';
import type { AppDescriptor } from '../src/app-descriptor.js';

const descriptor: AppDescriptor = { id: 'test-app', name: 'Test App', version: '1.0.0' };

function modeResolution(mode: RuntimeModeResolution['mode']): () => RuntimeModeResolution {
	return () =>
		Object.freeze({
			mode,
			reason: `forced ${mode}`,
			workloadSocketPath: '/tmp/never',
			standaloneIdentityFilePath: '/tmp/never',
		});
}

function baseOptions(overrides: Partial<ServeAppOptions>): ServeAppOptions {
	return {
		descriptor,
		createHandler: () => async () => ({ ok: true }),
		port: 0, // ephemeral
		installSignalHandlers: false,
		logger: () => {},
		...overrides,
	};
}

function portOf(handle: ServeAppHandle): number {
	return (handle.server.address() as AddressInfo).port;
}

const openHandles: ServeAppHandle[] = [];
async function start(options: ServeAppOptions): Promise<ServeAppHandle> {
	const handle = await serveApp(options);
	openHandles.push(handle);
	return handle;
}

afterEach(async () => {
	while (openHandles.length) await openHandles.pop()!.close().catch(() => {});
	delete process.env[AGENT_BOT_CREDENTIAL_ENV_KEY];
	delete process.env[AGENT_BOT_USER_ID_ENV_KEY];
	resetAgentBotCredentialOutcomeForTests();
});

describe('transportOverride guard (H1)', () => {
	it('is a boot error under managed mode', async () => {
		await expect(
			serveApp(
				baseOptions({
					transportOverride: 'relay',
					__test: { resolveRuntimeMode: modeResolution('managed'), env: {} },
				}),
			),
		).rejects.toMatchObject({ name: 'RuntimeModeError', code: 'TRANSPORT_OVERRIDE_NOT_ALLOWED' });
	});

	it('is accepted under development mode', async () => {
		const handle = await start(
			baseOptions({ transportOverride: 'http', __test: { resolveRuntimeMode: modeResolution('development'), env: {} } }),
		);
		expect(handle.mode).toBe('development');
	});
});

describe('development mode', () => {
	it('serves trivial /health and /ready and mounts the Direct MCP router by default', async () => {
		const handle = await start(baseOptions({ __test: { resolveRuntimeMode: modeResolution('development'), env: {} } }));
		const base = `http://127.0.0.1:${portOf(handle)}`;

		const health = await fetch(`${base}/health`);
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({ ok: true, status: 'alive', mode: 'development' });

		const ready = await fetch(`${base}/ready`);
		expect(ready.status).toBe(200);
		expect(await ready.json()).toMatchObject({ ok: true, status: 'ready', mode: 'development' });

		// Router mounted → manifest is served.
		const manifest = await fetch(`${base}/.well-known/mcp/manifest.json`);
		expect(manifest.status).toBe(200);
		expect(await manifest.json()).toMatchObject({ name: 'test-app', version: '1.0.0' });
	});

	it('transportOverride=relay steps aside: no Direct MCP router, HTTP surface stays up', async () => {
		const handle = await start(
			baseOptions({ transportOverride: 'relay', __test: { resolveRuntimeMode: modeResolution('development'), env: {} } }),
		);
		const base = `http://127.0.0.1:${portOf(handle)}`;
		expect((await fetch(`${base}/health`)).status).toBe(200);
		// No router → manifest route is absent.
		expect((await fetch(`${base}/.well-known/mcp/manifest.json`)).status).toBe(404);
	});

	it('mounts configure routes BEFORE the router so they are reachable', async () => {
		const handle = await start(
			baseOptions({
				configure: (app) => {
					app.get('/diagnostics', (_req, res) => res.json({ diag: true }));
				},
				__test: { resolveRuntimeMode: modeResolution('development'), env: {} },
			}),
		);
		const res = await fetch(`http://127.0.0.1:${portOf(handle)}/diagnostics`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ diag: true });
	});
});

describe('managed mode', () => {
	function fakeWorkloadClient(status: string) {
		let disposed = false;
		return {
			isAvailable: () => true,
			getEffectiveCapabilities: async () => ({ status, scopes: ['files:read'], updatedAt: Date.now() }),
			peekEffectiveCapabilities: () => ({ status, scopes: ['files:read'], updatedAt: Date.now() }),
			brokerContext: async () => ({ hubOrigin: 'https://hub.example', hubKid: 'k', hubPublicJwk: {}, binding: {} }),
			ensureReady: async () => {},
			startCapabilityMonitor: (_intervalMs?: number) => () => {},
			dispose: () => {
				disposed = true;
			},
			wasDisposed: () => disposed,
		};
	}

	it('passes the workload singleton to the handler context and reports capability readiness', async () => {
		const client = fakeWorkloadClient('active');
		let ctxClient: unknown;
		const handle = await start(
			baseOptions({
				createHandler: (ctx) => {
					ctxClient = ctx.workloadIdentityClient;
					return async () => ({ ok: true });
				},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				__test: { resolveRuntimeMode: modeResolution('managed'), getWorkloadIdentityClient: (() => client) as any, env: {} },
			}),
		);
		expect(ctxClient).toBe(client);

		const ready = await fetch(`http://127.0.0.1:${portOf(handle)}/ready`);
		expect(ready.status).toBe(200);
		expect(await ready.json()).toMatchObject({ ok: true, mode: 'managed', workload: 'active' });
	});

	it('reports not_ready when the workload is not yet paired', async () => {
		const client = fakeWorkloadClient('pairing');
		const handle = await start(
			baseOptions({
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				__test: { resolveRuntimeMode: modeResolution('managed'), getWorkloadIdentityClient: (() => client) as any, env: {} },
			}),
		);
		const ready = await fetch(`http://127.0.0.1:${portOf(handle)}/ready`);
		expect(ready.status).toBe(503);
		expect(await ready.json()).toMatchObject({ ok: false, status: 'not_ready', mode: 'managed' });
	});
});

describe('standalone-production mode', () => {
	function fakeLoaded(agentBotCredential?: { botUserId: string; token: string }) {
		return {
			filePath: '/tmp/identity.json',
			identity: { pairingVersion: 2, agentBotCredential } as never,
			relay: { privosUrl: 'https://hub.example', clientId: 'c', clientSecret: 's' },
			trust: {} as never,
			fingerprint: 'SHA256:kid',
		};
	}

	function fakeRelay() {
		let connected = false;
		let stopped = false;
		return {
			handle: {
				stop: async () => {
					stopped = true;
				},
				whenConnected: async () => {},
				isConnected: () => connected,
			},
			connect: () => {
				connected = true;
			},
			wasStopped: () => stopped,
		};
	}

	it('connects the Relay, mounts no Direct router, and boot-seeds a persisted bot credential', async () => {
		const relay = fakeRelay();
		let connectArgs: unknown;
		const handle = await start(
			baseOptions({
				__test: {
					resolveRuntimeMode: modeResolution('standalone-production'),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					loadStandaloneIdentity: (() => fakeLoaded({ botUserId: 'seed-user', token: 'seed-token-not-real' })) as any,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					createStandaloneRelayIdentityController: (() => ({}) as any),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					connectRelay: ((args: unknown) => {
						connectArgs = args;
						relay.connect();
						return relay.handle;
					}) as any,
					env: {},
				},
			}),
		);

		expect(handle.mode).toBe('standalone-production');
		expect(connectArgs).toMatchObject({ privosUrl: 'https://hub.example' });
		// Boot seed makes the persisted credential immediately readable.
		expect(readAgentBotCredential()).toEqual({ botUserId: 'seed-user', token: 'seed-token-not-real' });

		const base = `http://127.0.0.1:${portOf(handle)}`;
		expect((await fetch(`${base}/health`)).status).toBe(200);
		// No Direct MCP router in standalone — MCP rides Relay.
		expect((await fetch(`${base}/.well-known/mcp/manifest.json`)).status).toBe(404);

		await handle.close();
		expect(relay.wasStopped()).toBe(true);
	});

	it('echoes the freshly resolved manifest through the Relay descriptor so Hub Refresh can re-read the contract', async () => {
		const relay = fakeRelay();
		let connectArgs: { descriptor: unknown } | undefined;
		let manifestVersion = '1.0.0';
		const handle = await start(
			baseOptions({
				resolveManifest: () => ({ schemaVersion: 3, name: 'ai.privos.demo', version: manifestVersion, permissions: [] }),
				__test: {
					resolveRuntimeMode: modeResolution('standalone-production'),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					loadStandaloneIdentity: (() => fakeLoaded()) as any,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					createStandaloneRelayIdentityController: (() => ({}) as any),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					connectRelay: ((args: { descriptor: unknown }) => {
						connectArgs = args;
						relay.connect();
						return relay.handle;
					}) as any,
					env: {},
				},
			}),
		);
		const resolve = connectArgs!.descriptor as () => Promise<{ manifest?: Record<string, unknown> }>;
		expect(typeof resolve).toBe('function');
		expect((await resolve()).manifest).toMatchObject({ version: '1.0.0' });
		// Re-resolved per call: an edited manifest is observed without a restart.
		manifestVersion = '1.1.0';
		expect((await resolve()).manifest).toMatchObject({ version: '1.1.0' });
		await handle.close();
	});

	it('/ready is not_ready until the Relay authenticates', async () => {
		const relay = fakeRelay(); // never connects
		const handle = await start(
			baseOptions({
				__test: {
					resolveRuntimeMode: modeResolution('standalone-production'),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					loadStandaloneIdentity: (() => fakeLoaded()) as any,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					createStandaloneRelayIdentityController: (() => ({}) as any),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					connectRelay: (() => relay.handle) as any,
					env: {},
				},
			}),
		);
		const ready = await fetch(`http://127.0.0.1:${portOf(handle)}/ready`);
		expect(ready.status).toBe(503);
		expect(await ready.json()).toMatchObject({ ok: false, status: 'not_ready' });
	});
});
