import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createDirectRouter } from '../../src/direct/express-router.js';
import type { AppDescriptor } from '../../src/app-descriptor.js';

const descriptor: AppDescriptor = {
	id: 'ai.privos.demo',
	name: 'Demo',
	version: '0.1.0',
	title: 'Demo',
};

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
