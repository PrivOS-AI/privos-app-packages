import { describe, expect, it, vi } from 'vitest';

import {
	buildInitializeResult,
	type AppDescriptor,
} from '../../src/app-descriptor.js';
import { METHOD_NOT_FOUND, INTERNAL_ERROR } from '../../src/protocol/errors.js';
import { AppServerRuntime } from '../../src/runtime.js';
import { normalizeThrownError } from '../../src/protocol/errors.js';

const descriptor: AppDescriptor = {
	id: 'ai.privos.demo',
	name: 'Demo',
	version: '1.0.0',
	title: 'Demo App',
	scopes: ['basic:information'],
	relayIcon: 'data:image/svg+xml;base64,abc',
};

async function ctx(
	runtime: AppServerRuntime,
	partial: { requestId?: string | number | null; sessionScope?: string } = {},
) {
	return runtime.buildContext({
		transport: 'direct',
		requestId: partial.requestId,
		sessionScope: partial.sessionScope ?? 'test-session',
	});
}

describe('AppServerRuntime', () => {
	it('handles initialize without calling the app handler', async () => {
		const handler = vi.fn();
		const runtime = new AppServerRuntime({ descriptor, handler });
		const context = await ctx(runtime, { requestId: 1 });
		const outcome = await runtime.dispatchObject(
			{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
			context,
		);
		expect(handler).not.toHaveBeenCalled();
		expect(outcome.type).toBe('response');
		if (outcome.type === 'response' && 'result' in outcome.response) {
			expect(outcome.response.result).toEqual(
				buildInitializeResult(descriptor, { uiEnabled: false }),
			);
			expect(
				(outcome.response.result as { capabilities: Record<string, unknown> }).capabilities
					.extensions,
			).toBeUndefined();
		}
	});

	it('echoes descriptor.manifest verbatim as serverInfo.manifest on initialize', () => {
		const manifest = { schemaVersion: 3, name: 'demo', version: '1.0.0', permissions: [] };
		const result = buildInitializeResult({ ...descriptor, manifest }, { uiEnabled: false });
		expect(result.serverInfo.manifest).toEqual(manifest);
		expect(result.serverInfo.manifest).not.toBe(manifest);
		expect(buildInitializeResult(descriptor, { uiEnabled: false }).serverInfo.manifest).toBeUndefined();
	});

	it('declares UI extension only when ui is configured', async () => {
		const runtime = new AppServerRuntime({
			descriptor,
			handler: async () => ({ tools: [] }),
			ui: {
				uri: 'ui://demo/main.html',
				renderHtml: async () => '<html></html>',
			},
		});
		const context = await ctx(runtime, { requestId: 1 });
		const outcome = await runtime.dispatchObject(
			{ jsonrpc: '2.0', id: 1, method: 'initialize' },
			context,
		);
		if (outcome.type === 'response' && 'result' in outcome.response) {
			expect(
				(outcome.response.result as { capabilities: { extensions: unknown } }).capabilities
					.extensions,
			).toBeTruthy();
		}
	});

	it('does not call handler for notifications/* even with id', async () => {
		const handler = vi.fn();
		const runtime = new AppServerRuntime({ descriptor, handler });
		const context = await ctx(runtime, { requestId: 9 });
		const outcome = await runtime.dispatchObject(
			{ jsonrpc: '2.0', id: 9, method: 'notifications/initialized' },
			context,
		);
		expect(handler).not.toHaveBeenCalled();
		expect(outcome.type).toBe('protocol_warning');
	});

	it('missing-id result-bearing method yields no_response (Hub quirk)', async () => {
		const handler = vi.fn();
		const runtime = new AppServerRuntime({ descriptor, handler });
		const context = await ctx(runtime);
		const outcome = await runtime.dispatchObject(
			{ jsonrpc: '2.0', method: 'tools/list' },
			context,
		);
		expect(handler).not.toHaveBeenCalled();
		expect(outcome).toEqual({ type: 'no_response', reason: 'missing_request_id' });
	});

	it('invalid request without id responds with id null', async () => {
		const runtime = new AppServerRuntime({
			descriptor,
			handler: async () => ({ tools: [] }),
		});
		const context = await ctx(runtime);
		const outcome = await runtime.dispatchObject({ jsonrpc: '2.0' }, context);
		expect(outcome.type).toBe('response');
		if (outcome.type === 'response' && 'error' in outcome.response) {
			expect(outcome.response.id).toBeNull();
			expect(outcome.response.error.code).toBe(-32600);
		}
	});

	it('parse error responds with id null', async () => {
		const runtime = new AppServerRuntime({
			descriptor,
			handler: async () => ({ tools: [] }),
		});
		const context = await ctx(runtime);
		const outcome = await runtime.dispatchText('{not-json', context);
		expect(outcome.type).toBe('response');
		if (outcome.type === 'response' && 'error' in outcome.response) {
			expect(outcome.response.id).toBeNull();
			expect(outcome.response.error.code).toBe(-32700);
		}
	});

	it('treats number 1 and string "1" as distinct in-flight ids', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const runtime = new AppServerRuntime({
			descriptor,
			handler: async () => {
				await gate;
				return { ok: true };
			},
		});
		const pNum = runtime.dispatchObject(
			{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
			await ctx(runtime, { requestId: 1, sessionScope: 'typed' }),
		);
		const pStr = runtime.dispatchObject(
			{ jsonrpc: '2.0', id: '1', method: 'tools/list' },
			await ctx(runtime, { requestId: '1', sessionScope: 'typed' }),
		);
		await Promise.resolve();
		release();
		const [a, b] = await Promise.all([pNum, pStr]);
		expect(a.type).toBe('response');
		expect(b.type).toBe('response');
		if (a.type === 'response') expect('result' in a.response).toBe(true);
		if (b.type === 'response') expect('result' in b.response).toBe(true);
	});

	it('encodeInFlightId distinguishes types', async () => {
		const { encodeInFlightId } = await import('../../src/runtime.js');
		expect(encodeInFlightId(1)).not.toBe(encodeInFlightId('1'));
		expect(encodeInFlightId(null)).toBe(JSON.stringify(['object', null]));
	});

	it('scopes duplicate in-flight ids per sessionScope', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const runtime = new AppServerRuntime({
			descriptor,
			handler: async () => {
				await gate;
				return { ok: true };
			},
		});

		const a = runtime.dispatchObject(
			{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
			await ctx(runtime, { requestId: 1, sessionScope: 'session-a' }),
		);
		const b = runtime.dispatchObject(
			{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
			await ctx(runtime, { requestId: 1, sessionScope: 'session-b' }),
		);
		// Same id, different sessions — both should be accepted (not duplicate).
		await Promise.resolve();
		release();
		const [ra, rb] = await Promise.all([a, b]);
		expect(ra.type).toBe('response');
		expect(rb.type).toBe('response');
		if (ra.type === 'response') expect('result' in ra.response).toBe(true);
		if (rb.type === 'response') expect('result' in rb.response).toBe(true);
	});

	it('rejects duplicate in-flight ids within the same session', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const runtime = new AppServerRuntime({
			descriptor,
			handler: async () => {
				await gate;
				return { ok: true };
			},
		});
		const p1 = runtime.dispatchObject(
			{ jsonrpc: '2.0', id: 7, method: 'tools/list' },
			await ctx(runtime, { requestId: 7, sessionScope: 'same' }),
		);
		const p2 = runtime.dispatchObject(
			{ jsonrpc: '2.0', id: 7, method: 'tools/list' },
			await ctx(runtime, { requestId: 7, sessionScope: 'same' }),
		);
		const second = await p2;
		expect(second.type).toBe('response');
		if (second.type === 'response' && 'error' in second.response) {
			expect(second.response.error.data).toMatchObject({ code: 'DUPLICATE_IN_FLIGHT_ID' });
		}
		release();
		await p1;
	});

	it('keeps in-flight until handler settles after timeout', async () => {
		let releaseHandler!: () => void;
		const hold = new Promise<void>((r) => {
			releaseHandler = r;
		});
		let aborted = false;
		const runtime = new AppServerRuntime({
			descriptor,
			limits: { requestTimeoutMs: 20 },
			handler: async (_req, context) => {
				expect(context.signal).toBeDefined();
				context.signal?.addEventListener('abort', () => {
					aborted = true;
				});
				await hold;
				return { late: true };
			},
		});

		const outcomeP = runtime.dispatchObject(
			{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x' } },
			await ctx(runtime, { requestId: 3, sessionScope: 'timeout-session' }),
		);
		const outcome = await outcomeP;
		expect(aborted).toBe(true);
		expect(outcome.type).toBe('response');
		if (outcome.type === 'response' && 'error' in outcome.response) {
			expect(outcome.response.error.data).toMatchObject({ code: 'REQUEST_TIMEOUT' });
		}

		const dup = await runtime.dispatchObject(
			{ jsonrpc: '2.0', id: 3, method: 'tools/list' },
			await ctx(runtime, { requestId: 3, sessionScope: 'timeout-session' }),
		);
		expect(dup.type).toBe('response');
		if (dup.type === 'response' && 'error' in dup.response) {
			expect(dup.response.error.data).toMatchObject({ code: 'DUPLICATE_IN_FLIGHT_ID' });
		}

		releaseHandler();
		await new Promise((r) => setTimeout(r, 10));

		const after = await runtime.dispatchObject(
			{ jsonrpc: '2.0', id: 3, method: 'tools/list' },
			await ctx(runtime, { requestId: 3, sessionScope: 'timeout-session' }),
		);
		expect(after.type).toBe('response');
		if (after.type === 'response') expect('result' in after.response).toBe(true);
	});

	it('marks extractor errors as invalid identity, not missing', async () => {
		const runtime = new AppServerRuntime({
			descriptor,
			handler: async () => ({ tools: [] }),
			auth: {
				jwksUrl: 'http://unused.invalid/jwks',
				audience: 'x',
				localJwks: { keys: [] },
			},
		});
		const context = await runtime.buildContext({
			transport: 'direct',
			sessionScope: 's',
			credentialResolution: { kind: 'error', message: 'boom' },
		});
		expect(context.identityState).toBe('invalid');
	});

	it('returns -32601 for unknown methods', async () => {
		const handler = vi.fn();
		const runtime = new AppServerRuntime({ descriptor, handler });
		const outcome = await runtime.dispatchObject(
			{ jsonrpc: '2.0', id: 3, method: 'foo/bar' },
			await ctx(runtime, { requestId: 3 }),
		);
		expect(handler).not.toHaveBeenCalled();
		if (outcome.type === 'response' && 'error' in outcome.response) {
			expect(outcome.response.error.code).toBe(METHOD_NOT_FOUND);
		}
	});

	it('maps app errors once via mapAppError', async () => {
		const runtime = new AppServerRuntime({
			descriptor,
			handler: async () => {
				throw new Error('secret upstream url https://internal/db');
			},
			mapAppError: () => ({ code: -32099, message: 'APP_ERR', data: { code: 'X' } }),
		});
		const outcome = await runtime.dispatchObject(
			{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'demo.ping' } },
			await ctx(runtime, { requestId: 1 }),
		);
		if (outcome.type === 'response' && 'error' in outcome.response) {
			expect(outcome.response.error).toEqual({
				code: -32099,
				message: 'APP_ERR',
				data: { code: 'X' },
			});
		}
	});
});

describe('normalizeThrownError', () => {
	it('does not leak unmapped Error.message to clients', () => {
		const err = normalizeThrownError(new Error('postgres://user:pass@host/db failed'));
		expect(err).toEqual({ code: INTERNAL_ERROR, message: 'Internal error' });
	});
});
