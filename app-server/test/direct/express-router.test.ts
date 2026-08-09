import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createDirectRouter } from '../../src/direct/express-router.js';
import type { AppDescriptor } from '../../src/app-descriptor.js';
import {
	BoundedRuntimeDispatchReplayConsumerV3,
	sha256RuntimeDispatchBodyV3,
	type RuntimeDispatchSecurityV3,
} from '../../src/workload/dispatch-assertion.js';

const descriptor: AppDescriptor = {
	id: 'ai.privos.demo',
	name: 'Demo',
	version: '0.1.0',
	title: 'Demo',
};

const INIT_PARAMS = {
	protocolVersion: '2025-03-26',
	capabilities: {
		extensions: {
			'io.modelcontextprotocol/ui': {
				mimeTypes: ['text/html;profile=mcp-app'],
			},
		},
	},
	clientInfo: { name: 'privos-hub', version: '1.0.0' },
};

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, child]) => [key, canonicalize(child)]),
		);
	}
	return value;
}

function canonical(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function signedRuntimeDispatch(body: unknown): {
	compact: string;
	security: RuntimeDispatchSecurityV3;
} {
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const publicJwk = pair.publicKey.export({ format: 'jwk' });
	const kid = crypto.createHash('sha256').update(canonical({
		crv: publicJwk.crv,
		kty: publicJwk.kty,
		x: publicJwk.x,
		y: publicJwk.y,
	})).digest('base64url');
	const now = 2_000_000_000;
	const affinity = {
		workspaceId: 'workspace-direct',
		deploymentId: 'deployment-direct',
		mcpAppId: descriptor.id,
		executionMode: 'PUBLISHER_HOSTED' as const,
		generationId: 'generation-direct',
		generationNumber: 1,
		runtimeInstallationId: 'installation-direct',
		manifestDigest: `sha256:${'a'.repeat(64)}`,
		resourceManifestHash: 'B'.repeat(43),
		runtimeResourceInventoryHash: 'C'.repeat(43),
		runtimeApprovalReceiptHash: 'D'.repeat(43),
		runtimeAuthorizationEpoch: 1,
	};
	const payload = {
		protocolVersion: 3,
		type: 'hub-runtime-dispatch-assertion',
		iss: `hub:${affinity.deploymentId}`,
		aud: `mcp-runtime:${affinity.mcpAppId}`,
		jti: crypto.randomUUID(),
		nonce: crypto.randomBytes(24).toString('base64url'),
		iat: now,
		exp: now + 30,
		...affinity,
		authorizationContext: 'workspace',
		htm: 'POST',
		htu: '/mcp',
		bodyDigest: sha256RuntimeDispatchBodyV3(body),
	};
	const encodedHeader = Buffer.from(canonical({
		alg: 'ES256',
		kid,
		privos_protocol: 3,
		typ: 'privos-hub-runtime-dispatch+jws',
	})).toString('base64url');
	const encodedPayload = Buffer.from(canonical(payload)).toString('base64url');
	const signature = crypto.sign('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'), {
		key: pair.privateKey,
		dsaEncoding: 'ieee-p1363',
	}).toString('base64url');
	return {
		compact: `${encodedHeader}.${encodedPayload}.${signature}`,
		security: {
			mode: 'required',
			trust: { hubKid: kid, hubPublicJwk: publicJwk, affinity },
			now: () => now,
			replayConsumer: new BoundedRuntimeDispatchReplayConsumerV3(),
		},
	};
}

describe('createDirectRouter', () => {
	it('mounts as a composable router without owning /ui or /health', async () => {
		const app = express();
		app.get('/health', (_req, res) => res.json({ ok: true }));
		app.get('/ui', (_req, res) => res.send('ui'));
		app.use(
			createDirectRouter({
				descriptor,
				handler: async () => ({ tools: [] }),
			}),
		);

		await request(app).get('/health').expect(200, { ok: true });
		await request(app).get('/ui').expect(200, 'ui');
		const manifest = await request(app).get('/.well-known/mcp/manifest.json').expect(200);
		expect(manifest.body.name).toBe('ai.privos.demo');
	});

	it('serves descriptor capabilities from the canonical manifest route', async () => {
		const app = express();
		app.use(createDirectRouter({
			descriptor: { ...descriptor, capabilities: { verifiedActor: true } },
			handler: async () => ({ tools: [] }),
		}));

		const manifest = await request(app).get('/.well-known/mcp/manifest.json').expect(200);
		expect(manifest.body.capabilities).toEqual({ verifiedActor: true });
	});

	it('returns 202 empty body for notifications/initialized', async () => {
		const handler = vi.fn();
		const app = express();
		app.use(createDirectRouter({ descriptor, handler }));
		const res = await request(app)
			.post('/mcp')
			.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
			.expect(202);
		expect(res.text).toBe('');
		expect(handler).not.toHaveBeenCalled();
	});

	it('returns initialize from descriptor without calling handler', async () => {
		const handler = vi.fn();
		const app = express();
		app.use(createDirectRouter({ descriptor, handler }));
		const res = await request(app)
			.post('/mcp')
			.send({ jsonrpc: '2.0', id: 1, method: 'initialize' })
			.expect(200);
		expect(handler).not.toHaveBeenCalled();
		expect(res.body.result.protocolVersion).toBe('2025-03-26');
		expect(res.body.result.serverInfo.name).toBe('Demo');
	});

	it('includes identity CORS headers by default', async () => {
		const app = express();
		app.use(createDirectRouter({ descriptor, handler: async () => ({ tools: [] }) }));
		const res = await request(app).options('/mcp').expect(204);
		const allow = res.headers['access-control-allow-headers'] ?? '';
		expect(allow.toLowerCase()).toContain('authorization');
		expect(allow.toLowerCase()).toContain('x-mcp-user-id');
		expect(allow.toLowerCase()).toContain('x-privos-dispatch-assertion');
		expect(allow.toLowerCase()).toContain('x-privos-mcp-dispatch-assertion');
	});

	it('verifies the exact v3 header before dispatch and propagates immutable runtime authorization', async () => {
		const body = {
			jsonrpc: '2.0',
			id: 9,
			method: 'tools/call',
			params: { name: 'demo.ping', arguments: {} },
		};
		const signed = signedRuntimeDispatch(body);
		const seen: unknown[] = [];
		const app = express();
		app.use(createDirectRouter({
			descriptor,
			runtimeDispatchV3: signed.security,
			handler: async (rpc, context) => {
				seen.push({ rpc, authorization: context.runtimeAuthorization });
				return { ok: true };
			},
		}));
		const response = await request(app)
			.post('/mcp')
			.set('X-PrivOS-MCP-Dispatch-Assertion', signed.compact)
			.send(body)
			.expect(200);
		expect(response.body.result).toEqual({ ok: true });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			rpc: body,
			authorization: {
				authorizationContext: 'workspace',
				runtimeInstallationId: 'installation-direct',
			},
		});
		expect(Object.isFrozen((seen[0] as { authorization: object }).authorization)).toBe(true);
	});

	it('fails closed on missing, legacy, duplicate, ambiguous, or unconfigured v3 headers', async () => {
		const body = {
			jsonrpc: '2.0',
			id: 9,
			method: 'tools/call',
			params: { name: 'demo.ping', arguments: {} },
		};
		const signed = signedRuntimeDispatch(body);
		const app = express();
		app.use(createDirectRouter({
			descriptor,
			runtimeDispatchV3: signed.security,
			handler: async () => ({ ok: true }),
		}));
		for (const execute of [
			() => request(app).post('/mcp').send(body),
			() => request(app).post('/mcp').set('X-PrivOS-Dispatch-Assertion', signed.compact).send(body),
			() => request(app).post('/mcp')
				.set('X-PrivOS-Dispatch-Assertion', signed.compact)
				.set('X-PrivOS-MCP-Dispatch-Assertion', signed.compact)
				.send(body),
			() => request(app).post('/mcp')
				.set('X-PrivOS-MCP-Dispatch-Assertion', [signed.compact, signed.compact] as unknown as string)
				.send(body),
			() => request(app).post('/mcp')
				.set('X-PrivOS-MCP-Dispatch-Assertion', signed.compact)
				.set('X-PrivOS-MCP-Runtime-Installation-Id', 'installation-direct')
				.send(body),
			() => request(app).post('/mcp')
				.set('X-PrivOS-MCP-Dispatch-Assertion', signed.compact)
				.set('X-PrivOS-MCP-Authorization-Binding-Id', 'binding-direct')
				.send(body),
		]) {
			const response = await execute().expect(403);
			expect(response.body.error.data.code).toBe('DISPATCH_ASSERTION_INVALID');
		}

		const unconfigured = express();
		unconfigured.use(createDirectRouter({ descriptor, handler: async () => ({ ok: true }) }));
		await request(unconfigured)
			.post('/mcp')
			.set('X-PrivOS-MCP-Dispatch-Assertion', signed.compact)
			.send(body)
			.expect(403);
	});

	it('permits only exact explicitly configured unsigned Hub discovery messages', async () => {
		const seed = signedRuntimeDispatch({});
		const handler = vi.fn(async () => ({ tools: [] }));
		const app = express();
		app.use(createDirectRouter({
			descriptor,
			runtimeDispatchV3: {
				...seed.security,
				unsignedReadiness: 'initialize-and-tools-list',
			},
			handler,
		}));

		await request(app).post('/mcp').send({
			jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS,
		}).expect(200);
		await request(app).post('/mcp').send({
			jsonrpc: '2.0', method: 'notifications/initialized',
		}).expect(202);
		await request(app).post('/mcp').send({
			jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
		}).expect(200);

		const denied = [
			{ jsonrpc: '2.0', id: 2, method: 'initialize', params: INIT_PARAMS },
			{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { ...INIT_PARAMS, _meta: {} } },
			{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: {} } },
			{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'demo.ping' } },
			{ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'ui://demo' } },
			{ jsonrpc: '2.0', id: 3, method: 'custom/readiness', params: {} },
		];
		for (const body of denied) {
			const response = await request(app).post('/mcp').send(body).expect(403);
			expect(response.body.error.data.code).toBe('DISPATCH_ASSERTION_INVALID');
		}
	});

	it('rejects every present assertion header during unsigned preactivation readiness', async () => {
		const seed = signedRuntimeDispatch({});
		const app = express();
		app.use(createDirectRouter({
			descriptor,
			runtimeDispatchV3: {
				...seed.security,
				unsignedReadiness: 'initialize-and-tools-list',
			},
			handler: async () => ({ tools: [] }),
		}));
		const readiness = {
			jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
		};
		for (const assertion of [
			'',
			'not-a-compact-jws',
			[seed.compact, seed.compact] as unknown as string,
		]) {
			const response = await request(app)
				.post('/mcp')
				.set('X-PrivOS-MCP-Dispatch-Assertion', assertion)
				.send(readiness)
				.expect(403);
			expect(response.body.error.data.code).toBe('DISPATCH_ASSERTION_INVALID');
		}
	});

	it('fails closed when workload dispatch security is required', async () => {
		const app = express();
		app.use(createDirectRouter({ descriptor, workloadSecurity: 'required', handler: async () => ({ tools: [] }) }));
		const response = await request(app)
			.post('/mcp')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
			.expect(403);
		expect(response.body.error.data.code).toBe('DISPATCH_ASSERTION_INVALID');
	});

	it('rejects ambiguous v3/legacy configuration and non-canonical v3 MCP paths', () => {
		const signed = signedRuntimeDispatch({});
		expect(() => createDirectRouter({
			descriptor,
			handler: async () => ({}),
			workloadSecurity: 'required',
			runtimeDispatchV3: signed.security,
		})).toThrow(/cannot both be required/i);
		expect(() => createDirectRouter({
			descriptor,
			handler: async () => ({}),
			mcpPath: '/private-mcp',
			runtimeDispatchV3: signed.security,
		})).toThrow(/canonical \/mcp/i);
	});

	it('returns JSON-RPC parse error for malformed JSON body', async () => {
		const app = express();
		app.use(createDirectRouter({ descriptor, handler: async () => ({ tools: [] }) }));
		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send('{not-json')
			.expect(200);
		expect(res.body).toEqual({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32700, message: 'Parse error' },
		});
	});

	it('marks extractor throw as invalid (not missing)', async () => {
		const seen: string[] = [];
		const app = express();
		app.use(
			createDirectRouter({
				descriptor,
				auth: {
					jwksUrl: 'http://unused.invalid/jwks',
					audience: 'demo',
					localJwks: { keys: [] },
				},
				extractCallerCredential: async () => {
					throw new Error('extractor boom');
				},
				handler: async (_req, context) => {
					seen.push(context.identityState);
					return { tools: [] };
				},
			}),
		);
		await request(app)
			.post('/mcp')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
			.expect(200);
		expect(seen).toEqual(['invalid']);
	});

	it('returns 413 JSON-RPC for oversized body', async () => {
		const app = express();
		app.use(
			createDirectRouter({
				descriptor,
				limits: { maxMessageBytes: 64 },
				handler: async () => ({ tools: [] }),
			}),
		);
		const big = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { pad: 'x'.repeat(200) },
		});
		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send(big);
		expect(res.status).toBe(413);
		expect(res.body).toMatchObject({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32600, data: { code: 'REQUEST_TOO_LARGE' } },
		});
	});
});
