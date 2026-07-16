import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import type { AppDescriptor } from '../../src/app-descriptor.js';
import { connectRelay, pairOverWebSocket } from '../../src/relay/relay-client.js';
import { relayCallerAuthSurface } from '../../src/runtime.js';

const descriptor: AppDescriptor = {
	id: 'ai.privos.demo',
	name: 'Demo',
	version: '0.0.1',
};

class FakeWebSocket extends EventEmitter {
	static OPEN = 1;
	readyState = FakeWebSocket.OPEN;
	sent: string[] = [];
	static instances: FakeWebSocket[] = [];

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

describe('relayCallerAuthSurface', () => {
	it('exposes only reserved meta keys, never params/arguments', () => {
		const surface = relayCallerAuthSurface({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'x', arguments: { userId: 'secret' } },
			_meta: { token: 't' },
			meta: { a: 1 },
		});
		expect(surface).toEqual({ _meta: { token: 't' }, meta: { a: 1 } });
		expect(Object.keys(surface).sort()).toEqual(['_meta', 'meta']);
	});
});

describe('connectRelay', () => {
	it('fetches oauth token, answers tools/list, ignores notifications', async () => {
		FakeWebSocket.instances = [];
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ access_token: 'tok' }),
		}));

		const handle = connectRelay({
			privosUrl: 'http://hub.test',
			clientId: 'cid',
			clientSecret: 'sec',
			descriptor,
			handler: async (req) => {
				if (req.method === 'tools/list') return { tools: [{ name: 'demo.ping' }] };
				throw Object.assign(new Error('unexpected'), { code: -32601 });
			},
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});

		await handle.whenConnected();
		const ws = FakeWebSocket.instances[0]!;
		expect(fetchImpl).toHaveBeenCalled();

		ws.emit(
			'message',
			Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'tools/list' })),
		);
		await vi.waitFor(() => expect(ws.sent.length).toBe(1));
		expect(JSON.parse(ws.sent[0]!)).toMatchObject({
			id: 'x',
			result: { tools: [{ name: 'demo.ping' }] },
		});

		ws.emit(
			'message',
			Buffer.from(
				JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'notifications/initialized' }),
			),
		);
		await new Promise((r) => setTimeout(r, 20));
		expect(ws.sent.length).toBe(1);

		await handle.stop();
	});

	it('stop() prevents reconnect after close', async () => {
		FakeWebSocket.instances = [];
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ access_token: 'tok' }),
		}));

		const handle = connectRelay({
			privosUrl: 'http://hub.test',
			clientId: 'cid',
			clientSecret: 'sec',
			descriptor,
			handler: async () => ({ tools: [] }),
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});

		await handle.whenConnected();
		const callsBeforeStop = fetchImpl.mock.calls.length;
		await handle.stop();
		FakeWebSocket.instances[0]?.emit('close', 1006);
		await new Promise((r) => setTimeout(r, 50));
		expect(fetchImpl.mock.calls.length).toBe(callsBeforeStop);
	});

	it('passes only auth surface to extractor', async () => {
		FakeWebSocket.instances = [];
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ access_token: 'tok' }),
		}));
		const seen: unknown[] = [];

		const handle = connectRelay({
			privosUrl: 'http://hub.test',
			clientId: 'cid',
			clientSecret: 'sec',
			descriptor,
			extractCallerCredential: async (ingress) => {
				seen.push(ingress);
				return undefined;
			},
			handler: async () => ({ tools: [] }),
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});

		await handle.whenConnected();
		FakeWebSocket.instances[0]!.emit(
			'message',
			Buffer.from(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
					params: { arguments: { userId: 'nope' } },
					_meta: { privos: true },
				}),
			),
		);
		await vi.waitFor(() => expect(seen.length).toBe(1));
		expect(seen[0]).toEqual({ _meta: { privos: true } });
		await handle.stop();
	});

	it('stop() without whenConnected() does not cause unhandled rejection', async () => {
		FakeWebSocket.instances = [];
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ access_token: 'tok' }),
		}));

		const rejections: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			rejections.push(reason);
		};
		process.on('unhandledRejection', onUnhandled);

		const handle = connectRelay({
			privosUrl: 'http://hub.test',
			clientId: 'cid',
			clientSecret: 'sec',
			descriptor,
			handler: async () => ({ tools: [] }),
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});

		// Deliberately do NOT call whenConnected().
		await handle.stop();
		await new Promise((r) => setTimeout(r, 30));
		process.off('unhandledRejection', onUnhandled);
		expect(rejections).toEqual([]);
	});

	it('whenConnected() still rejects after stop before connect', async () => {
		class NeverOpenWs extends EventEmitter {
			static OPEN = 1;
			readyState = 0;
			static instances: NeverOpenWs[] = [];
			constructor(_url: string) {
				super();
				NeverOpenWs.instances.push(this);
			}
			send() {}
			close() {
				this.readyState = 3;
				this.emit('close', 1006);
			}
			pong() {}
			removeAllListeners() {
				return super.removeAllListeners();
			}
		}

		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ access_token: 'tok' }),
		}));

		const handle = connectRelay({
			privosUrl: 'http://hub.test',
			clientId: 'cid',
			clientSecret: 'sec',
			descriptor,
			handler: async () => ({ tools: [] }),
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: NeverOpenWs as unknown as typeof import('ws').default,
			openHandshakeTimeoutMs: 50,
		});

		const pending = handle.whenConnected();
		await handle.stop();
		await expect(pending).rejects.toThrow(/stopped before connecting/i);
	});

	it('open handshake timeout closes socket and schedules reconnect', async () => {
		class HangOpenWs extends EventEmitter {
			static OPEN = 1;
			readyState = 0;
			static instances: HangOpenWs[] = [];
			closed = false;
			constructor(_url: string) {
				super();
				HangOpenWs.instances.push(this);
			}
			send() {}
			close() {
				this.closed = true;
				this.readyState = 3;
				this.emit('close', 1006);
			}
			pong() {}
			removeAllListeners() {
				return super.removeAllListeners();
			}
		}

		const events: string[] = [];
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ access_token: 'tok' }),
		}));

		const handle = connectRelay({
			privosUrl: 'http://hub.test',
			clientId: 'cid',
			clientSecret: 'sec',
			descriptor,
			handler: async () => ({ tools: [] }),
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: HangOpenWs as unknown as typeof import('ws').default,
			openHandshakeTimeoutMs: 30,
			logger: (event) => {
				events.push(event);
			},
		});

		await vi.waitFor(() => expect(events).toContain('relay.open_handshake_timeout'), {
			timeout: 500,
		});
		expect(HangOpenWs.instances[0]?.closed).toBe(true);
		await handle.stop();
	});
});

describe('pairOverWebSocket', () => {
	it('rejects when socket closes before paired result', async () => {
		class PairingWs extends EventEmitter {
			constructor(_url: string) {
				super();
				queueMicrotask(() => {
					this.emit('open');
					queueMicrotask(() => this.emit('close', 1000, Buffer.from('')));
				});
			}
			send() {}
			close() {}
		}

		await expect(
			pairOverWebSocket(
				'ws://hub/pair',
				{ name: 'Demo' },
				PairingWs as unknown as typeof import('ws').default,
				{ timeoutMs: 1000 },
			),
		).rejects.toThrow(/closed before credentials/i);
	});
});
