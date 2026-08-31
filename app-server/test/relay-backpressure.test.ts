import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import type { AppDescriptor } from '../src/app-descriptor.js';
import { connectRelay } from '../src/relay/relay-client.js';

const descriptor: AppDescriptor = {
	id: 'ai.privos.demo',
	name: 'Demo',
	version: '0.0.1',
};

/** Same shape as the other relay-client fixtures, plus a settable `bufferedAmount`. */
class FakeWebSocket extends EventEmitter {
	static OPEN = 1;
	static instances: FakeWebSocket[] = [];
	readyState = FakeWebSocket.OPEN;
	bufferedAmount = 0;
	sent: string[] = [];

	constructor(_url: string, _opts?: unknown) {
		super();
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => this.emit('open'));
	}

	send(data: string, cb?: (err?: Error) => void) {
		this.sent.push(data);
		cb?.();
	}

	close() {
		this.readyState = 3;
		this.emit('close', 1000);
	}

	pong() {}
	removeAllListeners() {
		return super.removeAllListeners();
	}
}

function fakeFetch() {
	return vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'tok' }) }));
}

describe('relay backpressure', () => {
	it('enqueues a JSON-RPC -32000 relay_backpressure error for the affected id instead of dropping the response', async () => {
		FakeWebSocket.instances = [];
		const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
		const handle = connectRelay({
			privosUrl: 'http://hub.test',
			clientId: 'cid',
			clientSecret: 'sec',
			descriptor,
			handler: async () => ({ tools: [{ name: 'demo.ping' }] }),
			logger: (event, fields) => logs.push({ event, fields }),
			limits: { maxBufferedBytes: 10 },
			fetchImpl: fakeFetch() as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});

		await handle.whenConnected();
		const ws = FakeWebSocket.instances[0]!;
		ws.bufferedAmount = 1_000_000; // far past maxBufferedBytes: 10

		ws.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' })));
		await vi.waitFor(() => expect(ws.sent.length).toBe(1));

		expect(JSON.parse(ws.sent[0]!)).toEqual({
			jsonrpc: '2.0',
			id: 42,
			error: { code: -32000, message: 'relay_backpressure' },
		});
		expect(logs.some((entry) => entry.event === 'relay.backpressure')).toBe(true);
		await handle.stop();
	});

	it('preserves a string request id and never invokes the handler-produced result once congested', async () => {
		FakeWebSocket.instances = [];
		const handler = vi.fn(async () => ({ ok: true }));
		const handle = connectRelay({
			privosUrl: 'http://hub.test',
			clientId: 'cid',
			clientSecret: 'sec',
			descriptor,
			handler,
			limits: { maxBufferedBytes: 10 },
			fetchImpl: fakeFetch() as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});

		await handle.whenConnected();
		const ws = FakeWebSocket.instances[0]!;
		ws.bufferedAmount = 1_000_000;

		ws.emit(
			'message',
			Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'req-x', method: 'tools/list' })),
		);
		await vi.waitFor(() => expect(ws.sent.length).toBe(1));

		const sent = JSON.parse(ws.sent[0]!);
		expect(sent).toEqual({
			jsonrpc: '2.0',
			id: 'req-x',
			error: { code: -32000, message: 'relay_backpressure' },
		});
		expect(sent.result).toBeUndefined();
		await handle.stop();
	});

	it('sends normally once bufferedAmount drops back under the limit', async () => {
		FakeWebSocket.instances = [];
		const handle = connectRelay({
			privosUrl: 'http://hub.test',
			clientId: 'cid',
			clientSecret: 'sec',
			descriptor,
			handler: async () => ({ tools: [] }),
			limits: { maxBufferedBytes: 10 },
			fetchImpl: fakeFetch() as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});

		await handle.whenConnected();
		const ws = FakeWebSocket.instances[0]!;
		ws.bufferedAmount = 0;

		ws.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })));
		await vi.waitFor(() => expect(ws.sent.length).toBe(1));

		expect(JSON.parse(ws.sent[0]!)).toMatchObject({ id: 1, result: { tools: [] } });
		await handle.stop();
	});
});
