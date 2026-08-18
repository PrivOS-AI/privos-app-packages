import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppDescriptor } from '../../src/app-descriptor.js';
import { connectRelay, pairOverWebSocket, resumeStandalonePairing } from '../../src/relay/relay-client.js';
import { createStandaloneRelayIdentityController, STANDALONE_SECRET_ROTATE_METHOD } from '../../src/relay/standalone-control.js';
import {
	loadStandaloneIdentity,
	loadStandalonePendingIdentity,
	saveStandaloneIdentity,
	standaloneHubFingerprint,
	type StandaloneIdentityV2,
} from '../../src/relay/standalone-identity.js';
import { sha256CanonicalJson } from '../../src/manifest-tools.js';
import { relayCallerAuthSurface } from '../../src/runtime.js';
import {
	BoundedRuntimeDispatchReplayConsumerV3,
	sha256RuntimeDispatchBodyV3,
	type RuntimeDispatchSecurityV3,
	type RuntimeDispatchTrustV3,
} from '../../src/workload/dispatch-assertion.js';

const descriptor: AppDescriptor = {
	id: 'ai.privos.demo',
	name: 'Demo',
	version: '0.0.1',
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

function signedRelayDispatch(): {
	logicalRpc: Record<string, unknown>;
	envelope: Record<string, unknown>;
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
		workspaceId: 'workspace-relay',
		deploymentId: 'deployment-relay',
		mcpAppId: descriptor.id,
		executionMode: 'PUBLISHER_HOSTED' as const,
		generationId: 'generation-relay',
		generationNumber: 1,
		runtimeInstallationId: 'installation-relay',
		manifestDigest: `sha256:${'a'.repeat(64)}`,
		resourceManifestHash: 'B'.repeat(43),
		runtimeResourceInventoryHash: 'C'.repeat(43),
		runtimeApprovalReceiptHash: 'D'.repeat(43),
		runtimeAuthorizationEpoch: 1,
	};
	const logicalRpc = {
		jsonrpc: '2.0',
		id: 7,
		method: 'tools/call',
		params: {
			_meta: { traceId: 'trace-relay' },
			name: 'demo.ping',
			arguments: { message: 'hello' },
		},
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
		authorizationContext: 'room',
		roomId: 'room-relay',
		authorizationBindingId: 'binding-relay',
		bindingReceiptHash: 'E'.repeat(43),
		bindingGrantHash: 'F'.repeat(43),
		bindingEpoch: 1,
		bindingTokenVersion: 1,
		htm: 'POST',
		htu: '/mcp',
		bodyDigest: sha256RuntimeDispatchBodyV3(logicalRpc),
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
	const assertion = `${encodedHeader}.${encodedPayload}.${signature}`;
	return {
		logicalRpc,
		envelope: {
			...logicalRpc,
			params: {
				...(logicalRpc.params as Record<string, unknown>),
				_meta: {
					traceId: 'trace-relay',
					privosAuthorization: {
						assertion,
						runtimeInstallationId: 'installation-relay',
						authorizationBindingId: 'binding-relay',
					},
					privosUser: { userToken: 'token-relay', userId: 'user-relay', roomId: 'room-relay' },
				},
			},
		},
		security: {
			mode: 'required',
			trust: { hubKid: kid, hubPublicJwk: publicJwk, affinity },
			now: () => now,
			replayConsumer: new BoundedRuntimeDispatchReplayConsumerV3(),
		},
	};
}

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
	it('verifies nested v3 authorization, sanitizes handler input, and propagates room affinity', async () => {
		FakeWebSocket.instances = [];
		const signed = signedRelayDispatch();
		const seenRequests: unknown[] = [];
		const seenContexts: unknown[] = [];
		const seenAuthSurfaces: unknown[] = [];
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ access_token: 'tok' }),
		}));
		const handle = connectRelay({
			privosUrl: 'http://hub.test',
			clientId: 'cid',
			clientSecret: 'sec',
			descriptor,
			runtimeDispatchV3: signed.security,
			extractCallerCredential: async (surface) => {
				seenAuthSurfaces.push(surface);
				return undefined;
			},
			handler: async (rpc, context) => {
				seenRequests.push(rpc);
				seenContexts.push(context);
				return { ok: true };
			},
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});

		await handle.whenConnected();
		const ws = FakeWebSocket.instances[0]!;
		ws.emit('message', Buffer.from(JSON.stringify(signed.envelope)));
		await vi.waitFor(() => expect(ws.sent.length).toBe(1));
		expect(JSON.parse(ws.sent[0]!)).toMatchObject({ id: 7, result: { ok: true } });
		expect(seenRequests).toEqual([signed.logicalRpc]);
		expect(seenAuthSurfaces).toEqual([{
			_meta: {
				privosUser: { userToken: 'token-relay', userId: 'user-relay', roomId: 'room-relay' },
			},
		}]);
		expect(seenContexts[0]).toMatchObject({
			roomId: 'room-relay',
			runtimeAuthorization: {
				authorizationContext: 'room',
				runtimeInstallationId: 'installation-relay',
				authorizationBindingId: 'binding-relay',
				roomId: 'room-relay',
			},
		});
		expect(Object.isFrozen(
			(seenContexts[0] as { runtimeAuthorization: object }).runtimeAuthorization,
		)).toBe(true);
		await handle.stop();
	});

	it('rejects wrapper mismatch, body tamper, reserved collisions, and replay before handler dispatch', async () => {
		FakeWebSocket.instances = [];
		const signed = signedRelayDispatch();
		const handler = vi.fn(async () => ({ ok: true }));
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ access_token: 'tok' }),
		}));
		const handle = connectRelay({
			privosUrl: 'http://hub.test',
			clientId: 'cid',
			clientSecret: 'sec',
			descriptor,
			runtimeDispatchV3: signed.security,
			handler,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});
		await handle.whenConnected();
		const ws = FakeWebSocket.instances[0]!;

		const wrongRuntime = structuredClone(signed.envelope);
		const wrongRuntimeMeta = (wrongRuntime.params as { _meta: Record<string, unknown> })._meta;
		(wrongRuntimeMeta.privosAuthorization as Record<string, unknown>).runtimeInstallationId = 'wrong';
		const wrongBinding = structuredClone(signed.envelope);
		const wrongBindingMeta = (wrongBinding.params as { _meta: Record<string, unknown> })._meta;
		(wrongBindingMeta.privosAuthorization as Record<string, unknown>).authorizationBindingId = 'wrong';
		const tampered = structuredClone(signed.envelope);
		(tampered.params as { arguments: { message: string } }).arguments.message = 'tampered';
		const topLevelCollision = { ...signed.envelope, _meta: { privosUser: { userId: 'collision' } } };

		for (const message of [wrongRuntime, wrongBinding, tampered, topLevelCollision]) {
			ws.emit('message', Buffer.from(JSON.stringify(message)));
			await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(1));
			const response = JSON.parse(ws.sent.at(-1)!);
			expect(response.error.data.code).toBe('DISPATCH_ASSERTION_INVALID');
			ws.sent.splice(0);
		}
		expect(handler).not.toHaveBeenCalled();

		ws.emit('message', Buffer.from(JSON.stringify(signed.envelope)));
		await vi.waitFor(() => expect(ws.sent.length).toBe(1));
		expect(JSON.parse(ws.sent[0]!)).toMatchObject({ result: { ok: true } });
		expect(handler).toHaveBeenCalledTimes(1);
		ws.sent.splice(0);

		ws.emit('message', Buffer.from(JSON.stringify(signed.envelope)));
		await vi.waitFor(() => expect(ws.sent.length).toBe(1));
		expect(JSON.parse(ws.sent[0]!).error.data.code).toBe('DISPATCH_ASSERTION_INVALID');
		expect(handler).toHaveBeenCalledTimes(1);
		await handle.stop();
	});

	it('never permits unsigned Relay requests, including the Direct-only discovery exception', async () => {
		FakeWebSocket.instances = [];
		const signed = signedRelayDispatch();
		const handler = vi.fn(async () => ({ tools: [] }));
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ access_token: 'tok' }),
		}));
		const handle = connectRelay({
			privosUrl: 'http://hub.test',
			clientId: 'cid',
			clientSecret: 'sec',
			descriptor,
			runtimeDispatchV3: {
				...signed.security,
				unsignedReadiness: 'initialize-and-tools-list',
			},
			handler,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});
		await handle.whenConnected();
		const ws = FakeWebSocket.instances[0]!;
		const directOnlyBodies = [
			{
				jsonrpc: '2.0', id: 1, method: 'initialize', params: {
					protocolVersion: '2025-03-26',
					capabilities: { extensions: {
						'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
					} },
					clientInfo: { name: 'privos-hub', version: '1.0.0' },
				},
			},
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
		];
		for (const body of directOnlyBodies) {
			ws.emit('message', Buffer.from(JSON.stringify(body)));
			await vi.waitFor(() => expect(ws.sent.length).toBe(1));
			expect(JSON.parse(ws.sent[0]!).error.data.code).toBe('DISPATCH_ASSERTION_INVALID');
			ws.sent.splice(0);
		}
		expect(handler).not.toHaveBeenCalled();
		await handle.stop();
	});

	it('rejects v3 Relay metadata when receiver trust is not configured', async () => {
		FakeWebSocket.instances = [];
		const signed = signedRelayDispatch();
		const handler = vi.fn(async () => ({ ok: true }));
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ access_token: 'tok' }),
		}));
		const handle = connectRelay({
			privosUrl: 'http://hub.test',
			clientId: 'cid',
			clientSecret: 'sec',
			descriptor,
			handler,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});
		await handle.whenConnected();
		const ws = FakeWebSocket.instances[0]!;
		ws.emit('message', Buffer.from(JSON.stringify(signed.envelope)));
		await vi.waitFor(() => expect(ws.sent.length).toBe(1));
		expect(JSON.parse(ws.sent[0]!).error.data.code).toBe('DISPATCH_ASSERTION_INVALID');
		expect(handler).not.toHaveBeenCalled();
		await handle.stop();
	});

	it('fetches oauth token, answers tools/list, ignores notifications', async () => {
		FakeWebSocket.instances = [];
		const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
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
			logger: (event, fields) => logs.push({ event, fields }),
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
		expect(logs).toContainEqual({
			event: 'relay.rpc.inbound',
			fields: {
				direction: '←',
				generation: 1,
				requestId: 'x',
				method: 'tools/list',
			},
		});
		expect(logs).toContainEqual({
			event: 'relay.rpc.outbound',
			fields: {
				direction: '→',
				generation: 1,
				requestId: 'x',
				method: 'tools/list',
				responseKind: 'result',
			},
		});

		ws.emit(
			'message',
			Buffer.from(
				JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'notifications/initialized' }),
			),
		);
		await new Promise((r) => setTimeout(r, 20));
		expect(ws.sent.length).toBe(1);
		expect(logs).toContainEqual({
			event: 'relay.rpc.inbound',
			fields: {
				direction: '←',
				generation: 1,
				requestId: 99,
				method: 'notifications/initialized',
			},
		});

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

function trustFixture(overrides: Partial<RuntimeDispatchTrustV3['affinity']> = {}) {
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const publicJwk = pair.publicKey.export({ format: 'jwk' }) as { crv: string; kty: string; x: string; y: string };
	const hubPublicJwk = { crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y };
	const hubKid = crypto.createHash('sha256').update(canonical(hubPublicJwk), 'utf8').digest('base64url');
	const trust: RuntimeDispatchTrustV3 = {
		hubKid,
		hubPublicJwk,
		affinity: {
			workspaceId: 'workspace-1',
			deploymentId: 'deployment-1',
			mcpAppId: 'mcp-app-1',
			executionMode: 'PUBLISHER_HOSTED',
			generationId: 'generation-1',
			generationNumber: 1,
			runtimeInstallationId: 'installation-1',
			manifestDigest: `sha256:${'a'.repeat(64)}`,
			resourceManifestHash: 'B'.repeat(43),
			runtimeResourceInventoryHash: 'C'.repeat(43),
			runtimeApprovalReceiptHash: 'D'.repeat(43),
			runtimeAuthorizationEpoch: 1,
			...overrides,
		},
	};
	return { privateKey: pair.privateKey, trust };
}

function signControlAssertion(input: {
	privateKey: crypto.KeyObject;
	kid: string;
	type: string;
	deploymentId: string;
	mcpAppId: string;
	data: unknown;
	now: number;
}): string {
	const header = { alg: 'ES256', kid: input.kid, privos_protocol: 3, typ: 'privos-hub-standalone-control+jws' };
	const payload = {
		protocolVersion: 3,
		type: input.type,
		iss: `hub:${input.deploymentId}`,
		aud: `mcp-runtime:${input.mcpAppId}`,
		jti: crypto.randomUUID(),
		nonce: crypto.randomBytes(24).toString('base64url'),
		iat: input.now,
		exp: input.now + 30,
		data: input.data,
	};
	const encodedHeader = Buffer.from(canonical(header)).toString('base64url');
	const encodedPayload = Buffer.from(canonical(payload)).toString('base64url');
	const signature = crypto
		.sign('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'), { key: input.privateKey, dsaEncoding: 'ieee-p1363' })
		.toString('base64url');
	return `${encodedHeader}.${encodedPayload}.${signature}`;
}

describe('pairOverWebSocket v2 (standalone identity)', () => {
	let tempDirectory: string;
	let filePath: string;

	beforeEach(async () => {
		tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'pairing-v2-'));
		filePath = path.join(tempDirectory, 'identity.json');
	});

	afterEach(async () => {
		await fs.rm(tempDirectory, { recursive: true, force: true });
	});

	class PairingV2Ws extends EventEmitter {
		constructor(
			_url: string,
			private readonly result: Record<string, unknown>,
		) {
			super();
			queueMicrotask(() => this.emit('open'));
		}
		send() {
			queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ result: this.result }))));
		}
		close() {}
	}

	it('captures trust, persists a standalone identity file at 0600, and prints the fingerprint', async () => {
		const { trust } = trustFixture();
		const fingerprint = standaloneHubFingerprint(trust.hubKid);
		const Ws = class extends PairingV2Ws {
			constructor(url: string) {
				super(url, {
					paired: true,
					clientId: 'client-1',
					clientSecret: 'secret-1',
					relayUrl: 'ws://hub.example/api/v1/mcp-apps.relay',
					mcpAppId: 'mcp-app-1',
					pairingVersion: 2,
					trust,
					fingerprint,
				});
			}
		};
		const fingerprintLines: string[] = [];
		const result = await pairOverWebSocket('ws://hub/pair', { name: 'Demo' }, Ws as unknown as typeof import('ws').default, {
			identityFilePath: filePath,
			onFingerprint: (line) => fingerprintLines.push(line),
		});

		expect(result.pairingVersion).toBe(2);
		expect(result.trust).toEqual(trust);
		expect(result.fingerprint).toBe(fingerprint);
		expect(result.identityFilePath).toBe(filePath);
		expect(fingerprintLines).toHaveLength(1);
		expect(fingerprintLines[0]).toContain(fingerprint);

		const loaded = loadStandaloneIdentity({ filePath });
		expect(loaded.relay).toEqual({ privosUrl: 'http://hub.example', clientId: 'client-1', clientSecret: 'secret-1' });
		const stat = await fs.stat(filePath);
		expect((stat.mode & 0o777).toString(8)).toBe('600');
	});

	it('a v1 Hub response (no pairingVersion) still pairs as before — additive only, nothing persisted', async () => {
		const Ws = class extends PairingV2Ws {
			constructor(url: string) {
				super(url, {
					paired: true,
					clientId: 'client-1',
					clientSecret: 'secret-1',
					relayUrl: 'ws://hub.example/api/v1/mcp-apps.relay',
				});
			}
		};
		const result = await pairOverWebSocket('ws://hub/pair', { name: 'Demo' }, Ws as unknown as typeof import('ws').default, {
			identityFilePath: filePath,
		});
		expect(result).toEqual({
			state: 'legacy-complete',
			privosUrl: 'http://hub.example',
			clientId: 'client-1',
			clientSecret: 'secret-1',
			mcpAppId: undefined,
		});
		expect(result.pairingVersion).toBeUndefined();
		await expect(fs.stat(filePath)).rejects.toThrow();
	});

	it('persists an exact manifest pairing as non-dispatchable pending state and promotes it after restart', async () => {
		const pendingPath = `${filePath}.pending`;
		const manifest = {
			schemaVersion: 3,
			kind: 'mcp-app',
			name: 'com.example.pending',
			version: '1.0.0',
			title: 'Pending App',
			description: 'Pending app contract.',
			permissions: [{
				scope: 'basic:information',
				requirement: 'required',
				context: 'workspace',
				executionContext: 'both',
				feature: 'pending.core',
				reason: 'Identify the installation.',
			}],
			resourceManifestTemplate: [],
		};
		const manifestDigest = sha256CanonicalJson(manifest);
		const permissionContractHash = 'P'.repeat(43);
		const { trust: rawTrust } = trustFixture({ mcpAppId: 'mcp-app-pending', manifestDigest });
		const trust = rawTrust;
		let announced: unknown;
		const PendingWs = class extends EventEmitter {
			constructor(_url: string) {
				super();
				queueMicrotask(() => this.emit('open'));
			}
			send(data: string) {
				announced = JSON.parse(data);
				queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
					result: {
						paired: false,
						pairingState: 'pending-approval',
						clientId: 'client-pending',
						clientSecret: 'secret-pending',
						relayUrl: 'ws://hub.example/api/v1/mcp-apps.relay',
						appId: 'mcp-app-pending',
						pairingVersion: 2,
						pairingId: 'pairing-pending',
						oauthClientId: 'client-pending',
						manifestDigest,
						permissionContractHash,
						declaredPermissionCeiling: ['basic:information'],
						hubKid: trust.hubKid,
						fingerprint: standaloneHubFingerprint(trust.hubKid),
					},
				}))));
			}
			close() {}
		};

		const pending = await pairOverWebSocket(
			'ws://hub/pair',
			{ name: 'Pending App', manifest },
			PendingWs as unknown as typeof import('ws').default,
			{ identityFilePath: filePath, pendingIdentityFilePath: pendingPath, onFingerprint: () => undefined },
		);
		expect(pending).toMatchObject({ state: 'pending-approval', manifestDigest, pendingIdentityFilePath: pendingPath });
		expect((announced as any).manifest).toEqual(manifest);
		expect(loadStandalonePendingIdentity({ filePath: pendingPath }).identity.clientId).toBe('client-pending');
		await expect(fs.stat(filePath)).rejects.toThrow();

		const CompletionWs = class extends EventEmitter {
			constructor(_url: string, _options: unknown) {
				super();
				queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
					result: {
						paired: true,
						pairingState: 'complete',
						clientId: 'client-pending',
						clientSecret: 'secret-pending',
						relayUrl: 'ws://hub.example/api/v1/mcp-apps.relay',
						appId: 'mcp-app-pending',
						pairingVersion: 2,
						pairingId: 'pairing-pending',
						oauthClientId: 'client-pending',
						manifestDigest,
						permissionContractHash,
						declaredPermissionCeiling: ['basic:information'],
						approvedPermissionCeiling: ['basic:information'],
						hubKid: trust.hubKid,
						fingerprint: standaloneHubFingerprint(trust.hubKid),
						trust,
					},
				}))));
			}
			close() {}
		};
		const completed = await resumeStandalonePairing({
			identityFilePath: filePath,
			pendingIdentityFilePath: pendingPath,
			fetchImpl: (async () => ({ ok: true, json: async () => ({ access_token: 'token' }) })) as unknown as typeof fetch,
			WebSocketImpl: CompletionWs as unknown as typeof import('ws').default,
			onFingerprint: () => undefined,
		});
		expect(completed).toMatchObject({ state: 'complete', identityFilePath: filePath, manifestDigest });
		expect(loadStandaloneIdentity({ filePath }).identity.mcpAppId).toBe('mcp-app-pending');
		await expect(fs.stat(pendingPath)).rejects.toThrow();
	});

	it('rejects a v2 response whose trust is malformed instead of silently degrading to v1', async () => {
		const Ws = class extends PairingV2Ws {
			constructor(url: string) {
				super(url, {
					paired: true,
					clientId: 'client-1',
					clientSecret: 'secret-1',
					relayUrl: 'ws://hub.example/api/v1/mcp-apps.relay',
					pairingVersion: 2,
					trust: { hubKid: 'not-a-real-trust-object' },
				});
			}
		};
		await expect(
			pairOverWebSocket('ws://hub/pair', { name: 'Demo' }, Ws as unknown as typeof import('ws').default, {
				identityFilePath: filePath,
			}),
		).rejects.toThrow();
		await expect(fs.stat(filePath)).rejects.toThrow();
	});
});

describe('connectRelay with standaloneIdentity', () => {
	let tempDirectory: string;
	let filePath: string;

	beforeEach(async () => {
		tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'connect-relay-standalone-'));
		filePath = path.join(tempDirectory, 'identity.json');
	});

	afterEach(async () => {
		await fs.rm(tempDirectory, { recursive: true, force: true });
	});

	async function seedIdentity(trust: RuntimeDispatchTrustV3) {
		const identity: StandaloneIdentityV2 = {
			pairingVersion: 2,
			relayUrl: 'https://hub.example',
			clientId: 'client-1',
			clientSecret: 'secret-1',
			trust,
			fingerprint: standaloneHubFingerprint(trust.hubKid),
			mcpAppId: trust.affinity.mcpAppId,
			pairedAt: Date.now(),
		};
		await saveStandaloneIdentity(identity, { filePath });
		return loadStandaloneIdentity({ filePath });
	}

	it('sources OAuth credentials from the controller and reports isConnected() through the connection lifecycle', async () => {
		const { trust } = trustFixture();
		const loaded = await seedIdentity(trust);
		const controller = createStandaloneRelayIdentityController(loaded);

		FakeWebSocket.instances = [];
		const seenBodies: string[] = [];
		const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
			seenBodies.push(init.body);
			return { ok: true, json: async () => ({ access_token: 'tok' }) };
		});
		const handle = connectRelay({
			privosUrl: 'https://hub.example',
			standaloneIdentity: controller,
			descriptor,
			handler: async () => ({ ok: true }),
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});

		expect(handle.isConnected()).toBe(false);
		await handle.whenConnected();
		expect(handle.isConnected()).toBe(true);
		expect(seenBodies[0]).toContain('client_id=client-1');
		expect(seenBodies[0]).toContain('client_secret=secret-1');

		await handle.stop();
		expect(handle.isConnected()).toBe(false);
	});

	it('routes a signed standalone control notification to the controller instead of MCP dispatch', async () => {
		const { privateKey, trust } = trustFixture();
		const loaded = await seedIdentity(trust);
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loaded, { now: () => now });

		FakeWebSocket.instances = [];
		const handler = vi.fn(async () => ({ ok: true }));
		const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'tok' }) }));
		const handle = connectRelay({
			privosUrl: 'https://hub.example',
			standaloneIdentity: controller,
			descriptor,
			handler,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});
		await handle.whenConnected();
		const ws = FakeWebSocket.instances[0]!;

		const assertion = signControlAssertion({
			privateKey,
			kid: trust.hubKid,
			type: 'standalone-secret-rotate',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: { clientId: 'client-2', clientSecret: 'secret-2' },
			now,
		});
		ws.emit(
			'message',
			Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: STANDALONE_SECRET_ROTATE_METHOD, params: { assertion } })),
		);

		await vi.waitFor(() => expect(controller.getCredentials().clientId).toBe('client-2'));
		expect(handler).not.toHaveBeenCalled();
		expect(ws.sent).toHaveLength(0);
		await handle.stop();
	});

	it('requires either clientId+clientSecret or a standaloneIdentity controller', () => {
		expect(() =>
			connectRelay({
				privosUrl: 'https://hub.example',
				descriptor,
				handler: async () => ({ ok: true }),
			}),
		).toThrow(/clientId and clientSecret, or a standaloneIdentity controller/);
	});
});
