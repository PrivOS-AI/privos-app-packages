import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import type { AppDescriptor } from '../../src/app-descriptor.js';
import {
	createHttpIngressApp,
	resolveHttpIngressListen,
	startHttpIngress,
} from '../../src/direct/http-ingress.js';

const descriptor: AppDescriptor = {
	id: 'ai.privos.demo',
	name: 'Demo',
	version: '0.1.0',
	title: 'Demo',
};

describe('createHttpIngressApp', () => {
	it('serves health, ready, and MCP initialize', async () => {
		const app = createHttpIngressApp({
			descriptor,
			handler: async () => ({ tools: [] }),
			ready: {
				check: async () => ({ ok: true, body: { hub: true } }),
			},
			health: { body: { transport: 'test' } },
		});

		await request(app).get('/health').expect(200, {
			ok: true,
			status: 'alive',
			transport: 'test',
		});
		await request(app).get('/ready').expect(200, {
			ok: true,
			status: 'ready',
			hub: true,
		});
		const init = await request(app)
			.post('/mcp')
			.send({ jsonrpc: '2.0', id: 1, method: 'initialize' })
			.expect(200);
		expect(init.body.result.protocolVersion).toBe('2025-03-26');
	});

	it('returns 503 when ready check fails', async () => {
		const app = createHttpIngressApp({
			descriptor,
			handler: async () => ({ tools: [] }),
			ready: {
				check: async () => ({ ok: false, body: { missing: ['TOKEN'] } }),
			},
		});
		await request(app).get('/ready').expect(503, {
			ok: false,
			status: 'not_ready',
			missing: ['TOKEN'],
		});
	});
});

describe('resolveHttpIngressListen', () => {
	it('uses defaultPort when env unset', () => {
		expect(resolveHttpIngressListen({ defaultPort: 10003, env: {} })).toEqual({
			enabled: true,
			port: 10003,
			publicUrl: 'http://localhost:10003',
		});
	});

	it('disables on HTTP_INGRESS=0', () => {
		expect(
			resolveHttpIngressListen({ env: { HTTP_INGRESS: '0', HTTP_PORT: '9999' } }).enabled,
		).toBe(false);
	});

	it('prefers HTTP_PORT over PORT', () => {
		expect(
			resolveHttpIngressListen({
				env: { HTTP_PORT: '10003', PORT: '10002', PUBLIC_URL: 'https://ex.example' },
			}),
		).toEqual({
			enabled: true,
			port: 10003,
			publicUrl: 'https://ex.example',
		});
	});
});

describe('startHttpIngress', () => {
	const handles: Array<{ close(): Promise<void> }> = [];
	afterAll(async () => {
		for (const h of handles) await h.close();
	});

	it('listens and serves /health', async () => {
		const handle = await startHttpIngress({
			descriptor,
			handler: async () => ({ tools: [] }),
			port: 0, // ephemeral
			logPrefix: '[test]',
		});
		handles.push(handle);
		const addr = handle.server.address();
		const port = typeof addr === 'object' && addr ? addr.port : handle.port;
		const res = await fetch(`http://127.0.0.1:${port}/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, status: 'alive' });
	});

	it('runs configure before listen', async () => {
		const handle = await startHttpIngress({
			descriptor,
			handler: async () => ({ tools: [] }),
			port: 0,
			logPrefix: '[test-configure]',
			configure: (app) => {
				app.get('/custom', (_req, res) => {
					res.status(200).json({ custom: true });
				});
			},
		});
		handles.push(handle);
		const addr = handle.server.address();
		const port = typeof addr === 'object' && addr ? addr.port : handle.port;
		const res = await fetch(`http://127.0.0.1:${port}/custom`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ custom: true });
	});
});
