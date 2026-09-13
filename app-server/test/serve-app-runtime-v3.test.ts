import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppDescriptor } from '../src/app-descriptor.js';
import { serveApp, type ServeAppHandle, type ServeAppOptions } from '../src/serve-app.js';
import {
	RUNTIME_V3_ACTIVE_TRUST,
	RUNTIME_V3_PREACTIVATION_TRUST,
	signRuntimeV3DispatchAssertion,
} from './fixtures/runtime-v3-dispatch-trust-vector.js';

const descriptor: AppDescriptor = { id: 'demo-mcp-app', name: 'Demo', version: '1.0.0' };

/** Real driver env — mode + trust JSON + unsigned-readiness flag — no `resolveRuntimeMode` test seam involved. */
function runtimeV3Env(trust: unknown, allowUnsigned: boolean): NodeJS.ProcessEnv {
	return {
		PRIVOS_RUNTIME_SECURITY_MODE: 'runtime-v3',
		PRIVOS_RUNTIME_DISPATCH_TRUST_V3: JSON.stringify(trust),
		PRIVOS_RUNTIME_ALLOW_UNSIGNED_PREACTIVATION_READINESS: allowUnsigned ? 'true' : 'false',
	};
}

const openHandles: ServeAppHandle[] = [];
async function start(options: ServeAppOptions): Promise<ServeAppHandle> {
	const handle = await serveApp(options);
	openHandles.push(handle);
	return handle;
}
function baseUrl(handle: ServeAppHandle): string {
	return `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
}

afterEach(async () => {
	while (openHandles.length) await openHandles.pop()!.close().catch(() => {});
});

const INIT_PARAMS = {
	protocolVersion: '2025-03-26',
	capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
	clientInfo: { name: 'privos-hub', version: '1.0.0' },
};

describe('serveApp — runtime-v3 mode (real env → real router)', () => {
	it('verifies a signed dispatch assertion from the real cluster-derived trust and dispatches to the handler', async () => {
		const seen: unknown[] = [];
		const handle = await start({
			descriptor,
			createHandler: () => async (rpc, context) => {
				seen.push(context.runtimeAuthorization);
				return { ok: true, rpc };
			},
			port: 0,
			installSignalHandlers: false,
			logger: () => {},
			__test: { env: runtimeV3Env(RUNTIME_V3_ACTIVE_TRUST, false) },
		});
		expect(handle.mode).toBe('runtime-v3');

		const body = { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} };
		const compact = signRuntimeV3DispatchAssertion({
			trust: RUNTIME_V3_ACTIVE_TRUST,
			body,
			now: Math.floor(Date.now() / 1000),
		});
		const res = await fetch(`${baseUrl(handle)}/mcp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-PrivOS-MCP-Dispatch-Assertion': compact },
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(200);
		const responseBody = (await res.json()) as { result: unknown };
		expect(responseBody.result).toMatchObject({ ok: true });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			runtimeInstallationId: RUNTIME_V3_ACTIVE_TRUST.affinity.runtimeInstallationId,
		});
	});

	it('accepts the unsigned pre-activation readiness triple only for the exact bodies, only when the driver allows it', async () => {
		const allowed = await start({
			descriptor,
			createHandler: () => async () => ({ tools: [] }),
			port: 0,
			installSignalHandlers: false,
			logger: () => {},
			__test: { env: runtimeV3Env(RUNTIME_V3_PREACTIVATION_TRUST, true) },
		});
		const base = baseUrl(allowed);
		const post = (body: unknown) =>
			fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

		await expect(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS }).then((r) => r.status)).resolves.toBe(200);
		await expect(post({ jsonrpc: '2.0', method: 'notifications/initialized' }).then((r) => r.status)).resolves.toBe(202);
		await expect(post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }).then((r) => r.status)).resolves.toBe(200);

		// Not the exact frozen body → still denied even though unsigned readiness is allowed.
		const mutatedInit = await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: INIT_PARAMS });
		expect(mutatedInit.status).toBe(403);

		const denied = await start({
			descriptor,
			createHandler: () => async () => ({ tools: [] }),
			port: 0,
			installSignalHandlers: false,
			logger: () => {},
			__test: { env: runtimeV3Env(RUNTIME_V3_PREACTIVATION_TRUST, false) },
		});
		const deniedRes = await fetch(`${baseUrl(denied)}/mcp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
		});
		expect(deniedRes.status).toBe(403);
	});

	it('never grants the readiness exception to tools/call, even when unsigned readiness is allowed', async () => {
		const handle = await start({
			descriptor,
			createHandler: () => async () => ({ ok: true }),
			port: 0,
			installSignalHandlers: false,
			logger: () => {},
			__test: { env: runtimeV3Env(RUNTIME_V3_PREACTIVATION_TRUST, true) },
		});
		const res = await fetch(`${baseUrl(handle)}/mcp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'demo.ping' } }),
		});
		expect(res.status).toBe(403);
		const responseBody = (await res.json()) as { error: { data: { code: string } } };
		expect(responseBody.error.data.code).toBe('DISPATCH_ASSERTION_MISSING');
	});

	it('denies the legacy managed dispatch header — runtime-v3 never accepts it', async () => {
		const handle = await start({
			descriptor,
			createHandler: () => async () => ({ ok: true }),
			port: 0,
			installSignalHandlers: false,
			logger: () => {},
			__test: { env: runtimeV3Env(RUNTIME_V3_ACTIVE_TRUST, false) },
		});
		const res = await fetch(`${baseUrl(handle)}/mcp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-PrivOS-Dispatch-Assertion': 'anything' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		});
		expect(res.status).toBe(403);
	});

	it('/ready is 200 with workload "unattested" once listening, before any broker socket exists', async () => {
		const handle = await start({
			descriptor,
			createHandler: () => async () => ({ ok: true }),
			port: 0,
			installSignalHandlers: false,
			logger: () => {},
			__test: { env: runtimeV3Env(RUNTIME_V3_PREACTIVATION_TRUST, true) },
		});
		const res = await fetch(`${baseUrl(handle)}/ready`);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, status: 'ready', mode: 'runtime-v3', workload: 'unattested' });
	});

	it('/ready reports "active" and the handler receives the workload singleton once the broker socket is present', async () => {
		let ctxClient: unknown;
		const fakeClient = {
			isAvailable: () => true,
			peekEffectiveCapabilities: () => ({ status: 'active', scopes: ['files:read'], updatedAt: Date.now() }),
			getEffectiveCapabilities: async () => ({ status: 'active', scopes: ['files:read'], updatedAt: Date.now() }),
			brokerContext: async () => ({ hubOrigin: 'https://hub.example', hubKid: 'k', hubPublicJwk: {}, binding: {} }),
			startCapabilityMonitor: (_intervalMs?: number) => () => {},
			dispose: () => {},
		};
		const handle = await start({
			descriptor,
			createHandler: (ctx) => {
				ctxClient = ctx.workloadIdentityClient;
				return async () => ({ ok: true });
			},
			port: 0,
			installSignalHandlers: false,
			logger: () => {},
			__test: {
				env: runtimeV3Env(RUNTIME_V3_ACTIVE_TRUST, false),
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				getWorkloadIdentityClient: (() => fakeClient) as any,
			},
		});
		expect(ctxClient).toBe(fakeClient);
		const res = await fetch(`${baseUrl(handle)}/ready`);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, mode: 'runtime-v3', workload: 'active' });
	});
});
