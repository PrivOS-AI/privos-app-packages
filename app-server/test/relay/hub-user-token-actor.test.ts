/**
 * Covers the Hub-signed RS256 user-token path for protocol-v3 Relay dispatch:
 * `_meta.privosUser.userToken` verified against a real Hub JWKS endpoint
 * (jose's `createRemoteJWKSet` talks to Node's http/https stack directly, not
 * `fetch`, so these tests spin up a real local HTTP server rather than
 * injecting a fetch mock) and cross-bound to the already-verified dispatch
 * assertion's room.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppDescriptor } from '../../src/app-descriptor.js';
import {
	buildHubUserTokenAuthOptions,
	extractRelayUserTokenCredential,
	validateHubUserTokenOrigin,
	DEFAULT_HUB_USER_TOKEN_JWKS_PATH,
} from '../../src/relay/hub-user-token-actor.js';
import { connectRelay } from '../../src/relay/relay-client.js';
import { saveStandaloneIdentity, loadStandaloneIdentity, standaloneHubFingerprint, type StandaloneIdentityV2 } from '../../src/relay/standalone-identity.js';
import { createStandaloneRelayIdentityController } from '../../src/relay/standalone-control.js';
import { AppServerRuntime } from '../../src/runtime.js';
import {
	sha256RuntimeDispatchBodyV3,
	type RuntimeDispatchSecurityV3,
	type RuntimeDispatchTrustV3,
	type VerifiedRuntimeDispatchAssertionV3,
} from '../../src/workload/dispatch-assertion.js';

const MCP_APP_ID = 'mcp-app-1';
const descriptor: AppDescriptor = { id: MCP_APP_ID, name: 'Demo', version: '0.0.1' };

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

// ---------------------------------------------------------------------------
// A real (loopback) JWKS HTTP server — jose's remote JWKS client speaks
// Node's http/https module directly, so a fetch-mock cannot stand in for it.
// ---------------------------------------------------------------------------
interface JwksTestServer {
	origin: string;
	setJwks: (jwks: { keys: unknown[] }) => void;
	requestCount: () => number;
	close: () => Promise<void>;
}

function startJwksServer(initialJwks: { keys: unknown[] }): Promise<JwksTestServer> {
	let jwks = initialJwks;
	let requests = 0;
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			if (req.url === DEFAULT_HUB_USER_TOKEN_JWKS_PATH) {
				requests += 1;
				res.setHeader('Content-Type', 'application/json');
				res.writeHead(200);
				res.end(JSON.stringify(jwks));
				return;
			}
			res.writeHead(404);
			res.end();
		});
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			resolve({
				origin: `http://127.0.0.1:${port}`,
				setJwks: (next) => {
					jwks = next;
				},
				requestCount: () => requests,
				close: () => new Promise((res) => server.close(() => res())),
			});
		});
	});
}

async function mintUserToken(input: {
	sub?: string;
	aud?: string;
	rid?: string;
	kid?: string;
	expiresInSeconds?: number;
	/** Reuse an already-minted signing key — e.g. to sign two tokens the same JWKS entry must verify. */
	signingKey?: KeyLike;
}) {
	const generated = input.signingKey ? undefined : await generateKeyPair('RS256');
	const privateKey = input.signingKey ?? generated!.privateKey;
	const publicKey = input.signingKey
		? crypto.createPublicKey(input.signingKey as unknown as crypto.KeyObject)
		: generated!.publicKey;
	const jwk = await exportJWK(publicKey);
	const kid = input.kid ?? 'user-token-kid';
	jwk.kid = kid;
	jwk.alg = 'RS256';
	jwk.use = 'sig';
	const signer = new SignJWT({
		sub: input.sub ?? 'user-1',
		preferred_username: 'alice',
		...(input.rid ? { rid: input.rid } : {}),
	})
		.setProtectedHeader({ alg: 'RS256', kid })
		.setIssuedAt()
		.setExpirationTime(`${input.expiresInSeconds ?? 300}s`)
		.setAudience(input.aud ?? MCP_APP_ID);
	const token = await signer.sign(privateKey);
	return { token, jwk, kid, privateKey };
}

function tamperSignature(token: string): string {
	const parts = token.split('.');
	const sig = Buffer.from(parts[2]!, 'base64url');
	sig[0] = sig[0]! ^ 0xff;
	parts[2] = sig.toString('base64url');
	return parts.join('.');
}

describe('extractRelayUserTokenCredential', () => {
	it('extracts the signed token and the unverified userId as assertedUserId', () => {
		const credential = extractRelayUserTokenCredential({
			_meta: { privosUser: { userToken: 'tok-1', userId: 'user-1', roomId: 'room-1' } },
		});
		expect(credential).toEqual({ token: 'tok-1', assertedUserId: 'user-1', source: 'relay-metadata' });
	});

	it('omits assertedUserId when userId is absent', () => {
		const credential = extractRelayUserTokenCredential({ _meta: { privosUser: { userToken: 'tok-1' } } });
		expect(credential).toEqual({ token: 'tok-1', source: 'relay-metadata' });
	});

	it('returns undefined (no throw) when _meta is absent', () => {
		expect(extractRelayUserTokenCredential({})).toBeUndefined();
	});

	it('returns undefined when _meta.privosUser is absent', () => {
		expect(extractRelayUserTokenCredential({ _meta: { other: 1 } })).toBeUndefined();
	});

	for (const malformed of [
		{ privosUser: 'not-an-object' },
		{ privosUser: { userId: 'user-1' } },
		{ privosUser: { userToken: '' } },
		{ privosUser: { userToken: 42 } },
	]) {
		it(`returns undefined for malformed privosUser: ${JSON.stringify(malformed)}`, () => {
			expect(extractRelayUserTokenCredential({ _meta: malformed })).toBeUndefined();
		});
	}
});

describe('validateHubUserTokenOrigin / buildHubUserTokenAuthOptions', () => {
	it('normalizes an origin with a trailing path to the bare origin', () => {
		expect(validateHubUserTokenOrigin('https://hub.example/some/path')).toBe('https://hub.example');
	});

	it('rejects a malformed URL', () => {
		expect(() => validateHubUserTokenOrigin('not a url')).toThrow();
	});

	it('rejects a non-http(s) protocol', () => {
		expect(() => validateHubUserTokenOrigin('ws://hub.example')).toThrow();
	});

	it('rejects userinfo/query/hash on the origin', () => {
		expect(() => validateHubUserTokenOrigin('https://user:pass@hub.example')).toThrow();
		expect(() => validateHubUserTokenOrigin('https://hub.example?x=1')).toThrow();
		expect(() => validateHubUserTokenOrigin('https://hub.example#frag')).toThrow();
	});

	it('builds AuthOptions pointed at the default well-known JWKS path', () => {
		const auth = buildHubUserTokenAuthOptions({ hubOrigin: 'https://hub.example', audience: MCP_APP_ID });
		expect((auth.jwksUrl as URL).toString()).toBe(`https://hub.example${DEFAULT_HUB_USER_TOKEN_JWKS_PATH}`);
		expect(auth.audience).toBe(MCP_APP_ID);
		expect(auth.clockToleranceSeconds).toBe(5);
	});

	it('honors an overridden jwksPath', () => {
		const auth = buildHubUserTokenAuthOptions({ hubOrigin: 'https://hub.example', audience: MCP_APP_ID, jwksPath: '/custom/jwks.json' });
		expect((auth.jwksUrl as URL).toString()).toBe('https://hub.example/custom/jwks.json');
	});
});

describe('hub user-token verification against a real JWKS endpoint', () => {
	let server: JwksTestServer;

	// The ambient shell/CI environment may already export NODE_ENV=production;
	// pin it explicitly per test so these plaintext-HTTP loopback fixtures are
	// deterministic regardless of that. The one test that means to prove the
	// production refusal overrides it back with its own `vi.stubEnv` call.
	beforeEach(() => {
		vi.stubEnv('NODE_ENV', 'test');
	});

	afterEach(async () => {
		await server?.close();
		vi.unstubAllEnvs();
	});

	function runtimeFor(auth: ReturnType<typeof buildHubUserTokenAuthOptions>) {
		return new AppServerRuntime({ descriptor, handler: async () => ({}), auth });
	}

	it('verifies a valid token and populates a user-token-provenance actor', async () => {
		const { token, jwk } = await mintUserToken({});
		server = await startJwksServer({ keys: [jwk] });
		const runtime = runtimeFor(buildHubUserTokenAuthOptions({ hubOrigin: server.origin, audience: MCP_APP_ID }));
		const context = await runtime.buildContext({
			transport: 'relay',
			sessionScope: 'test',
			credentialResolution: { kind: 'present', credential: { token, source: 'relay-metadata' } },
		});
		expect(context.identityState).toBe('verified');
		expect(context.actor).toMatchObject({ userId: 'user-1', username: 'alice', provenance: 'user-token' });
		expect(Object.isFrozen(context.actor)).toBe(true);
	});

	it('rejects a token whose aud does not match this app', async () => {
		const { token, jwk } = await mintUserToken({ aud: 'some-other-app' });
		server = await startJwksServer({ keys: [jwk] });
		const runtime = runtimeFor(buildHubUserTokenAuthOptions({ hubOrigin: server.origin, audience: MCP_APP_ID }));
		const context = await runtime.buildContext({
			transport: 'relay',
			sessionScope: 'test',
			credentialResolution: { kind: 'present', credential: { token, source: 'relay-metadata' } },
		});
		expect(context.identityState).toBe('invalid');
		expect(context.actor).toBeUndefined();
	});

	it('rejects an expired token', async () => {
		const { token, jwk } = await mintUserToken({ expiresInSeconds: -10 });
		server = await startJwksServer({ keys: [jwk] });
		const runtime = runtimeFor(buildHubUserTokenAuthOptions({ hubOrigin: server.origin, audience: MCP_APP_ID }));
		const context = await runtime.buildContext({
			transport: 'relay',
			sessionScope: 'test',
			credentialResolution: { kind: 'present', credential: { token, source: 'relay-metadata' } },
		});
		expect(context.identityState).toBe('invalid');
		expect(context.actor).toBeUndefined();
	});

	it('rejects a tampered signature', async () => {
		const { token, jwk } = await mintUserToken({});
		server = await startJwksServer({ keys: [jwk] });
		const runtime = runtimeFor(buildHubUserTokenAuthOptions({ hubOrigin: server.origin, audience: MCP_APP_ID }));
		const context = await runtime.buildContext({
			transport: 'relay',
			sessionScope: 'test',
			credentialResolution: { kind: 'present', credential: { token: tamperSignature(token), source: 'relay-metadata' } },
		});
		expect(context.identityState).toBe('invalid');
		expect(context.actor).toBeUndefined();
	});

	it('refetches once on an unknown kid, then fails closed', async () => {
		const { token } = await mintUserToken({ kid: 'kid-never-published' });
		// The server's published set never contains the signing key.
		const { jwk: unrelatedJwk } = await mintUserToken({ kid: 'kid-unrelated' });
		server = await startJwksServer({ keys: [unrelatedJwk] });
		const runtime = runtimeFor(buildHubUserTokenAuthOptions({ hubOrigin: server.origin, audience: MCP_APP_ID }));
		const context = await runtime.buildContext({
			transport: 'relay',
			sessionScope: 'test',
			credentialResolution: { kind: 'present', credential: { token, source: 'relay-metadata' } },
		});
		expect(context.identityState).toBe('invalid');
		expect(context.actor).toBeUndefined();
		// A fresh verifier's first call has no cached set, so its one unmatched-key
		// fetch already reflects the current server state (jose's own cooldown
		// then skips a redundant second attempt for the same fresh fetch) — bounded
		// to exactly one request, never an unbounded retry loop.
		expect(server.requestCount()).toBe(1);
	});

	it('missing token: actor stays undefined, no throw', async () => {
		const runtime = runtimeFor(buildHubUserTokenAuthOptions({ hubOrigin: 'https://unused.invalid', audience: MCP_APP_ID }));
		const context = await runtime.buildContext({
			transport: 'relay',
			sessionScope: 'test',
			credentialResolution: { kind: 'absent' },
		});
		expect(context.identityState).toBe('missing');
		expect(context.actor).toBeUndefined();
	});

	it('an unreachable JWKS endpoint degrades to actor-undefined without throwing', async () => {
		const { token, jwk } = await mintUserToken({});
		server = await startJwksServer({ keys: [jwk] });
		const origin = server.origin;
		await server.close();
		const runtime = runtimeFor(buildHubUserTokenAuthOptions({ hubOrigin: origin, audience: MCP_APP_ID, fetchTimeoutMs: 500 }));
		const context = await runtime.buildContext({
			transport: 'relay',
			sessionScope: 'test',
			credentialResolution: { kind: 'present', credential: { token, source: 'relay-metadata' } },
		});
		expect(context.identityState).toBe('invalid');
		expect(context.actor).toBeUndefined();
	});

	it('refuses a plaintext-HTTP JWKS origin under NODE_ENV=production', async () => {
		const { token, jwk } = await mintUserToken({});
		server = await startJwksServer({ keys: [jwk] });
		vi.stubEnv('NODE_ENV', 'production');
		const runtime = runtimeFor(buildHubUserTokenAuthOptions({ hubOrigin: server.origin, audience: MCP_APP_ID }));
		const context = await runtime.buildContext({
			transport: 'relay',
			sessionScope: 'test',
			credentialResolution: { kind: 'present', credential: { token, source: 'relay-metadata' } },
		});
		expect(context.identityState).toBe('invalid');
		expect(context.actor).toBeUndefined();
		expect(server.requestCount()).toBe(0);
	});

	it('cross-binds the token rid against the verified room dispatch assertion, and rejects a mismatch', async () => {
		const runtimeAuthorizationBase = {
			protocolVersion: 3,
			type: 'hub-runtime-dispatch-assertion',
			iss: 'hub:deployment-1',
			aud: `mcp-runtime:${MCP_APP_ID}`,
			jti: 'dispatch-1',
			nonce: 'A'.repeat(32),
			iat: 2_000_000_000,
			exp: 2_000_000_030,
			workspaceId: 'workspace-1',
			deploymentId: 'deployment-1',
			mcpAppId: MCP_APP_ID,
			executionMode: 'PUBLISHER_HOSTED',
			generationId: 'generation-1',
			generationNumber: 1,
			runtimeInstallationId: 'installation-1',
			manifestDigest: `sha256:${'a'.repeat(64)}`,
			resourceManifestHash: 'B'.repeat(43),
			runtimeResourceInventoryHash: 'C'.repeat(43),
			runtimeApprovalReceiptHash: 'D'.repeat(43),
			runtimeAuthorizationEpoch: 1,
			htm: 'POST',
			htu: '/mcp',
			bodyDigest: 'E'.repeat(43),
		} as const;
		const roomAuthorization = Object.freeze({
			...runtimeAuthorizationBase,
			authorizationContext: 'room',
			roomId: 'room-1',
			authorizationBindingId: 'binding-1',
			bindingReceiptHash: 'F'.repeat(43),
			bindingGrantHash: 'G'.repeat(43),
			bindingEpoch: 1,
			bindingTokenVersion: 1,
		}) as VerifiedRuntimeDispatchAssertionV3;
		const workspaceAuthorization = Object.freeze({
			...runtimeAuthorizationBase,
			authorizationContext: 'workspace',
		}) as VerifiedRuntimeDispatchAssertionV3;

		const { token: matchingToken, jwk, privateKey } = await mintUserToken({ rid: 'room-1' });
		server = await startJwksServer({ keys: [jwk] });
		const runtime = runtimeFor(buildHubUserTokenAuthOptions({ hubOrigin: server.origin, audience: MCP_APP_ID }));

		const okContext = await runtime.buildContext({
			transport: 'relay',
			sessionScope: 'test',
			credentialResolution: { kind: 'present', credential: { token: matchingToken, source: 'relay-metadata' } },
			runtimeAuthorization: roomAuthorization,
		});
		expect(okContext.actor).toMatchObject({ userId: 'user-1', roomId: 'room-1' });

		// Same signing key (same published `kid`) — only the `rid` claim differs —
		// so a mismatch is caught by the cross-bind check, not a JWKS lookup miss.
		const { token: otherRoomToken } = await mintUserToken({ rid: 'room-2', signingKey: privateKey });
		await expect(runtime.buildContext({
			transport: 'relay',
			sessionScope: 'test',
			credentialResolution: { kind: 'present', credential: { token: otherRoomToken, source: 'relay-metadata' } },
			runtimeAuthorization: roomAuthorization,
		})).rejects.toThrow('dispatch_assertion_binding_mismatch');

		// A workspace-scoped assertion must never accept a room-bound token either.
		await expect(runtime.buildContext({
			transport: 'relay',
			sessionScope: 'test',
			credentialResolution: { kind: 'present', credential: { token: matchingToken, source: 'relay-metadata' } },
			runtimeAuthorization: workspaceAuthorization,
		})).rejects.toThrow('dispatch_assertion_binding_mismatch');
	});
});

// ---------------------------------------------------------------------------
// End-to-end: connectRelay's automatic hubUserTokenAuth wiring for standalone
// production identity, over the full protocol-v3 Relay dispatch envelope.
// ---------------------------------------------------------------------------

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

function dispatchTrustFixture(): { privateKey: crypto.KeyObject; trust: RuntimeDispatchTrustV3 } {
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const publicJwk = pair.publicKey.export({ format: 'jwk' }) as { crv: string; kty: string; x: string; y: string };
	const hubPublicJwk = { crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y };
	const hubKid = crypto.createHash('sha256').update(canonical(hubPublicJwk), 'utf8').digest('base64url');
	return {
		privateKey: pair.privateKey,
		trust: {
			hubKid,
			hubPublicJwk,
			affinity: {
				workspaceId: 'workspace-relay',
				deploymentId: 'deployment-relay',
				mcpAppId: MCP_APP_ID,
				executionMode: 'PUBLISHER_HOSTED',
				generationId: 'generation-relay',
				generationNumber: 1,
				runtimeInstallationId: 'installation-relay',
				manifestDigest: `sha256:${'a'.repeat(64)}`,
				resourceManifestHash: 'B'.repeat(43),
				runtimeResourceInventoryHash: 'C'.repeat(43),
				runtimeApprovalReceiptHash: 'D'.repeat(43),
				runtimeAuthorizationEpoch: 1,
			},
		},
	};
}

function signedRoomEnvelope(input: {
	privateKey: crypto.KeyObject;
	trust: RuntimeDispatchTrustV3;
	userToken: string;
	roomId: string;
}): { envelope: Record<string, unknown>; logicalRpc: Record<string, unknown> } {
	// connectRelay's standaloneIdentity trust resolver has no test clock hook —
	// it always verifies against the real wall clock — so this fixture must too.
	const now = Math.floor(Date.now() / 1000);
	const logicalRpc = {
		jsonrpc: '2.0',
		id: 7,
		method: 'tools/call',
		params: { name: 'demo.ping', arguments: { message: 'hello' } },
	};
	const payload = {
		protocolVersion: 3,
		type: 'hub-runtime-dispatch-assertion',
		iss: `hub:${input.trust.affinity.deploymentId}`,
		aud: `mcp-runtime:${input.trust.affinity.mcpAppId}`,
		jti: crypto.randomUUID(),
		nonce: crypto.randomBytes(24).toString('base64url'),
		iat: now,
		exp: now + 30,
		...input.trust.affinity,
		authorizationContext: 'room',
		roomId: input.roomId,
		authorizationBindingId: 'binding-relay',
		bindingReceiptHash: 'E'.repeat(43),
		bindingGrantHash: 'F'.repeat(43),
		bindingEpoch: 1,
		bindingTokenVersion: 1,
		htm: 'POST',
		htu: '/mcp',
		bodyDigest: sha256RuntimeDispatchBodyV3(logicalRpc),
	};
	const encodedHeader = Buffer.from(canonical({ alg: 'ES256', kid: input.trust.hubKid, privos_protocol: 3, typ: 'privos-hub-runtime-dispatch+jws' })).toString('base64url');
	const encodedPayload = Buffer.from(canonical(payload)).toString('base64url');
	const signature = crypto.sign('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'), { key: input.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
	const assertion = `${encodedHeader}.${encodedPayload}.${signature}`;
	return {
		logicalRpc,
		envelope: {
			...logicalRpc,
			params: {
				...logicalRpc.params,
				_meta: {
					privosAuthorization: {
						assertion,
						runtimeInstallationId: input.trust.affinity.runtimeInstallationId,
						authorizationBindingId: 'binding-relay',
					},
					privosUser: { userToken: input.userToken, userId: 'user-1', roomId: input.roomId },
				},
			},
		},
	};
}

describe('connectRelay automatic hub user-token actor wiring (standaloneIdentity)', () => {
	let tempDirectory: string;
	let filePath: string;
	let jwksServer: JwksTestServer;

	beforeEach(async () => {
		// See the note on the previous describe block: pin NODE_ENV away from
		// whatever the ambient shell exports so the plaintext-HTTP loopback
		// JWKS fixture here is not refused by the production hardening guard.
		vi.stubEnv('NODE_ENV', 'test');
		tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-user-token-relay-'));
		filePath = path.join(tempDirectory, 'identity.json');
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await fs.rm(tempDirectory, { recursive: true, force: true });
		await jwksServer?.close();
	});

	async function seedIdentity(trust: RuntimeDispatchTrustV3, relayUrl: string) {
		const identity: StandaloneIdentityV2 = {
			pairingVersion: 2,
			relayUrl,
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

	it('populates context.actor from the verified user token and cross-binds it to the dispatch room', async () => {
		const { token: userToken, jwk } = await mintUserToken({ rid: 'room-relay' });
		jwksServer = await startJwksServer({ keys: [jwk] });
		const { privateKey, trust } = dispatchTrustFixture();
		const loaded = await seedIdentity(trust, jwksServer.origin);
		const controller = createStandaloneRelayIdentityController(loaded);
		const { envelope, logicalRpc } = signedRoomEnvelope({ privateKey, trust, userToken, roomId: 'room-relay' });

		FakeWebSocket.instances = [];
		const seenContexts: unknown[] = [];
		const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'tok' }) }));
		const handle = connectRelay({
			privosUrl: jwksServer.origin,
			standaloneIdentity: controller,
			descriptor,
			handler: async (rpc, context) => {
				seenContexts.push(context);
				return { ok: true };
			},
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});
		await handle.whenConnected();
		const ws = FakeWebSocket.instances[0]!;
		ws.emit('message', Buffer.from(JSON.stringify(envelope)));
		await vi.waitFor(() => expect(ws.sent.length).toBe(1));
		expect(JSON.parse(ws.sent[0]!)).toMatchObject({ id: 7, result: { ok: true } });
		expect(seenContexts).toHaveLength(1);
		expect(seenContexts[0]).toMatchObject({
			transport: 'relay',
			identityState: 'verified',
			roomId: 'room-relay',
			actor: { userId: 'user-1', roomId: 'room-relay', provenance: 'user-token' },
		});
		void logicalRpc;
		await handle.stop();
	});

	it('refuses dispatch when the token room does not match the verified assertion room', async () => {
		const { token: userToken, jwk } = await mintUserToken({ rid: 'room-other' });
		jwksServer = await startJwksServer({ keys: [jwk] });
		const { privateKey, trust } = dispatchTrustFixture();
		const loaded = await seedIdentity(trust, jwksServer.origin);
		const controller = createStandaloneRelayIdentityController(loaded);
		const { envelope } = signedRoomEnvelope({ privateKey, trust, userToken, roomId: 'room-relay' });

		FakeWebSocket.instances = [];
		const handler = vi.fn(async () => ({ ok: true }));
		const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'tok' }) }));
		const handle = connectRelay({
			privosUrl: jwksServer.origin,
			standaloneIdentity: controller,
			descriptor,
			handler,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});
		await handle.whenConnected();
		const ws = FakeWebSocket.instances[0]!;
		ws.emit('message', Buffer.from(JSON.stringify(envelope)));
		await vi.waitFor(() => expect(ws.sent.length).toBe(1));
		expect(JSON.parse(ws.sent[0]!).error.data.code).toBe('DISPATCH_ASSERTION_INVALID');
		expect(handler).not.toHaveBeenCalled();
		await handle.stop();
	});

	// Real Hubs pin dispatch trust to the app record `_id` while minting the
	// user token with `aud = app.appId` (the manifest name). The fixtures above
	// use one value for both, which is exactly why this mismatch went unnoticed.
	const HUB_RECORD_ID = '6a8ac7d916701d742ca1cb69';
	const MANIFEST_NAME = 'vn.example.app';
	const manifestDescriptor: AppDescriptor = { id: MANIFEST_NAME, name: 'Demo', version: '0.0.1' };

	function trustPinnedToRecordId() {
		const fixture = dispatchTrustFixture();
		const trust: RuntimeDispatchTrustV3 = {
			...fixture.trust,
			affinity: { ...fixture.trust.affinity, mcpAppId: HUB_RECORD_ID },
		};
		return { privateKey: fixture.privateKey, trust };
	}

	async function dispatchWithAud(aud: string, descriptorArg: AppDescriptor | (() => Promise<AppDescriptor>), extra: { manifestAppId?: string } = {}) {
		const { token: userToken, jwk } = await mintUserToken({ rid: 'room-relay', aud });
		jwksServer = await startJwksServer({ keys: [jwk] });
		const { privateKey, trust } = trustPinnedToRecordId();
		const loaded = await seedIdentity(trust, jwksServer.origin);
		const controller = createStandaloneRelayIdentityController(loaded);
		const { envelope } = signedRoomEnvelope({ privateKey, trust, userToken, roomId: 'room-relay' });
		FakeWebSocket.instances = [];
		const seenContexts: Array<{ identityState: string; actor?: unknown }> = [];
		const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'tok' }) }));
		const handle = connectRelay({
			privosUrl: jwksServer.origin,
			standaloneIdentity: controller,
			descriptor: descriptorArg,
			...extra,
			handler: async (_rpc, context) => {
				seenContexts.push(context as { identityState: string; actor?: unknown });
				return { ok: true };
			},
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});
		await handle.whenConnected();
		const ws = FakeWebSocket.instances[0]!;
		ws.emit('message', Buffer.from(JSON.stringify(envelope)));
		await vi.waitFor(() => expect(ws.sent.length).toBe(1));
		await handle.stop();
		expect(seenContexts).toHaveLength(1);
		return seenContexts[0]!;
	}

	it('accepts a token whose aud is the manifest name when trust is pinned to the Hub record _id', async () => {
		const context = await dispatchWithAud(MANIFEST_NAME, manifestDescriptor);
		expect(context.identityState).toBe('verified');
		expect(context.actor).toMatchObject({ userId: 'user-1', provenance: 'user-token' });
	});

	it('still accepts a token whose aud is the Hub record _id', async () => {
		const context = await dispatchWithAud(HUB_RECORD_ID, manifestDescriptor);
		expect(context.identityState).toBe('verified');
	});

	it('still rejects a token minted for another app', async () => {
		const context = await dispatchWithAud('vn.example.other-app', manifestDescriptor);
		expect(context.identityState).toBe('invalid');
		expect(context.actor).toBeUndefined();
	});

	it('honors an explicit manifestAppId when the descriptor is lazy (the serveApp path)', async () => {
		const lazy = async () => manifestDescriptor;
		const context = await dispatchWithAud(MANIFEST_NAME, lazy, { manifestAppId: MANIFEST_NAME });
		expect(context.identityState).toBe('verified');
	});

	it('falls back to the _id-only audience when the descriptor is lazy and no manifestAppId is given', async () => {
		const lazy = async () => manifestDescriptor;
		const context = await dispatchWithAud(MANIFEST_NAME, lazy);
		expect(context.identityState).toBe('invalid');
	});

	it('opts out entirely with hubUserTokenAuth: "disabled"', async () => {
		const { token: userToken, jwk } = await mintUserToken({ rid: 'room-relay' });
		jwksServer = await startJwksServer({ keys: [jwk] });
		const { privateKey, trust } = dispatchTrustFixture();
		const loaded = await seedIdentity(trust, jwksServer.origin);
		const controller = createStandaloneRelayIdentityController(loaded);
		const { envelope } = signedRoomEnvelope({ privateKey, trust, userToken, roomId: 'room-relay' });

		FakeWebSocket.instances = [];
		const seenContexts: unknown[] = [];
		const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'tok' }) }));
		const handle = connectRelay({
			privosUrl: jwksServer.origin,
			standaloneIdentity: controller,
			hubUserTokenAuth: 'disabled',
			descriptor,
			handler: async (rpc, context) => {
				seenContexts.push(context);
				return { ok: true };
			},
			fetchImpl: fetchImpl as unknown as typeof fetch,
			WebSocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
		});
		await handle.whenConnected();
		const ws = FakeWebSocket.instances[0]!;
		ws.emit('message', Buffer.from(JSON.stringify(envelope)));
		await vi.waitFor(() => expect(ws.sent.length).toBe(1));
		expect(JSON.parse(ws.sent[0]!)).toMatchObject({ id: 7, result: { ok: true } });
		expect(seenContexts[0]).toMatchObject({ identityState: 'missing' });
		expect((seenContexts[0] as { actor?: unknown }).actor).toBeUndefined();
		expect(jwksServer.requestCount()).toBe(0);
		await handle.stop();
	});
});
