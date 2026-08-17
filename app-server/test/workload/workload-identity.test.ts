import crypto, { type JsonWebKey } from 'node:crypto';
import { inspect } from 'node:util';

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createDirectRouter } from '../../src/direct/express-router.js';
import {
	WorkloadIdentityClient,
	WorkloadIdentityError,
	WorkloadPermissionDeniedError,
	type WorkloadBinding,
	type WorkloadBrokerResponse,
} from '../../src/workload/workload-identity.js';
import type { ToolCallContext } from '../../src/context/tool-call-context.js';
import { sha256RuntimeDispatchBodyV3 } from '../../src/workload/dispatch-assertion.js';

function hubIdentity(): { kid: string; publicJwk: JsonWebKey } {
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const publicJwk = pair.publicKey.export({ format: 'jwk' });
	const kid = crypto
		.createHash('sha256')
		.update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y }))
		.digest('base64url');
	return { kid, publicJwk };
}

function brokerFactory(input: { binding: WorkloadBinding; now: () => number }) {
	const hub = hubIdentity();
	return async (request: Record<string, unknown>): Promise<WorkloadBrokerResponse> => {
		const publicJwk = request.publicJwk as JsonWebKey;
		const dpopJkt = crypto
			.createHash('sha256')
			.update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y }))
			.digest('base64url');
		const iat = Math.floor(input.now() / 1_000);
		const payload = {
			type: 'node-workload-attestation',
			iat,
			exp: iat + 30,
			nonce: request.nonce,
			dpopJkt,
			...input.binding,
		};
		return {
			ok: true,
			attestation: `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2ln`,
			hubOrigin: 'https://hub.example',
			hubKid: hub.kid,
			hubPublicJwk: hub.publicJwk,
		};
	};
}

const binding = (): WorkloadBinding => ({
	workspaceId: 'workspace-1',
	installationId: 'installation-1',
	mcpAppId: 'app-1',
	replicaId: 'replica-1',
	receiptHash: `sha256:${'a'.repeat(64)}`,
	grantEpoch: 1,
});

const APPROVAL_RECEIPT_HASH = 'a'.repeat(43);
const HUB_ORIGIN = 'https://hub.example';
const generationHubPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const generationHubPublicJwk = generationHubPair.publicKey.export({ format: 'jwk' });
const generationHubKid = crypto.createHash('sha256').update(JSON.stringify({
	crv: generationHubPublicJwk.crv,
	kty: generationHubPublicJwk.kty,
	x: generationHubPublicJwk.x,
	y: generationHubPublicJwk.y,
})).digest('base64url');

/** Mirrors the attestation a cluster node issues for an App Library generation. */
function generationBrokerFactory(
	override: Record<string, unknown> | (() => Record<string, unknown>) = {},
	hubOrigin = 'https://hub.example',
	now: () => number = Date.now,
) {
	return async (request: Record<string, unknown>): Promise<WorkloadBrokerResponse> => {
		const currentOverride = typeof override === 'function' ? override() : override;
		const publicJwk = request.publicJwk as JsonWebKey;
		const iat = Math.floor(now() / 1_000);
		const payload = {
			protocolVersion: 3,
			type: 'node-workload-attestation',
			iss: 'urn:privos:cluster-node:cluster-1:node-1',
			aud: 'privos-hub-api',
			iat,
			exp: iat + 45,
			jti: crypto.randomUUID(),
			clusterId: 'cluster-1',
			nodeId: 'node-1',
			workspaceId: 'workspace-1',
			deploymentId: 'deployment-1',
			generationId: 'generation-1',
			generationNumber: 2,
			runtimeInstallationId: 'runtime-installation-1',
			mcpAppId: 'app-1',
			replicaId: 'replica-1',
			containerId: 'container-1',
			imageDigest: `sha256:${'b'.repeat(64)}`,
			manifestDigest: `sha256:${'c'.repeat(64)}`,
			approvalReceiptHash: APPROVAL_RECEIPT_HASH,
			authorizationEpoch: 7,
			resourceManifestHash: 'd'.repeat(43),
			runtimeResourceInventoryHash: 'e'.repeat(43),
			dpopJkt: crypto
				.createHash('sha256')
				.update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y }))
				.digest('base64url'),
			nonce: request.nonce,
			...currentOverride,
		};
		for (const [key, value] of Object.entries(currentOverride)) if (value === undefined) delete (payload as Record<string, unknown>)[key];
		return {
			ok: true,
			attestation: `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2ln`,
			hubOrigin,
			hubKid: generationHubKid,
			hubPublicJwk: generationHubPublicJwk,
		};
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fabricatedRoomContext(bindingId: string, roomId = 'room-1'): ToolCallContext {
	return {
		transport: 'direct',
		identityState: 'verified',
		sessionScope: `session-${bindingId}`,
		roomId,
		actor: Object.freeze({ userId: 'user-1', roomId, claims: Object.freeze({ sub: 'user-1', rid: roomId }), provenance: 'dispatch-assertion' }),
		runtimeAuthorization: Object.freeze({
			verificationPath: 'managed-cluster-v3',
			protocolVersion: 3,
			type: 'hub-dispatch-assertion',
			issuer: 'urn:privos:hub:deployment-1',
			jti: `dispatch-${bindingId}`,
			issuedAt: 2_000_000_000,
			expiresAt: 2_000_000_030,
			workspaceId: 'workspace-1',
			deploymentId: 'deployment-1',
			generationId: 'generation-1',
			generationNumber: 2,
			runtimeInstallationId: 'runtime-installation-1',
			mcpAppId: 'app-1',
			manifestDigest: `sha256:${'c'.repeat(64)}`,
			resourceManifestHash: 'd'.repeat(43),
			runtimeResourceInventoryHash: 'e'.repeat(43),
			runtimeApprovalReceiptHash: APPROVAL_RECEIPT_HASH,
			runtimeAuthorizationEpoch: 7,
			authorizationContext: 'room',
			roomId,
			authorizationBindingId: bindingId,
			bindingReceiptHash: bindingId === 'binding-1' ? 'f'.repeat(43) : 'g'.repeat(43),
			bindingEpoch: 1,
		}),
	};
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, canonicalize(child)]));
	}
	return value;
}

const canonical = (value: unknown): string => JSON.stringify(canonicalize(value));

function signManagedDispatch(body: unknown, bindingId: string, roomId: string): string {
	const now = Math.floor(Date.now() / 1_000);
	const header = Buffer.from(canonical({
		alg: 'ES256',
		kid: generationHubKid,
		privos_protocol: 3,
		typ: 'privos-hub-dispatch+jws',
	})).toString('base64url');
	const payload = Buffer.from(canonical({
		protocolVersion: 3,
		type: 'hub-dispatch-assertion',
		iss: 'urn:privos:hub:deployment-1',
		aud: 'privos-mcp-app',
		jti: crypto.randomUUID(),
		nonce: crypto.randomBytes(24).toString('base64url'),
		iat: now,
		exp: now + 30,
		workspaceId: 'workspace-1',
		mcpAppId: 'app-1',
		clusterAppId: 'cluster-app-1',
		htm: 'POST',
		htu: '/mcp',
		bodyDigest: sha256RuntimeDispatchBodyV3(body),
		runtimeApprovalReceiptHash: APPROVAL_RECEIPT_HASH,
		runtimeGrantEpoch: 7,
		authorizationContext: 'room',
		clusterId: 'cluster-1',
		deploymentId: 'deployment-1',
		generationId: 'generation-1',
		generationNumber: 2,
		runtimeInstallationId: 'runtime-installation-1',
		manifestDigest: `sha256:${'c'.repeat(64)}`,
		resourceManifestHash: 'd'.repeat(43),
		runtimeResourceInventoryHash: 'e'.repeat(43),
		roomId,
		authorizationBindingId: bindingId,
		bindingReceiptHash: crypto.createHash('sha256').update(bindingId).digest('base64url'),
		bindingEpoch: 1,
	})).toString('base64url');
	const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`, 'ascii'), {
		key: generationHubPair.privateKey,
		dsaEncoding: 'ieee-p1363',
	}).toString('base64url');
	return `${header}.${payload}.${signature}`;
}

async function managedRoomContext(
	client: WorkloadIdentityClient,
	bindingId = 'binding-1',
	roomId = 'room-1',
): Promise<ToolCallContext> {
	const seen: ToolCallContext[] = [];
	const app = express();
	app.use(createDirectRouter({
		descriptor: { id: 'app-1', name: 'Test app', version: '1.0.0' },
		workloadSecurity: 'required',
		workloadIdentityClient: client,
		handler: async (_rpc, context) => {
			seen.push(context);
			return { tools: [] };
		},
	}));
	const body = { jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/list', params: {} };
	await request(app).post('/mcp')
		.set('X-PrivOS-Dispatch-Assertion', signManagedDispatch(body, bindingId, roomId))
		.send(body)
		.expect(200);
	return seen[0]!;
}

describe('WorkloadIdentityClient', () => {
	it('keeps its DPoP key in memory, refreshes before expiry, and emits exact capability changes', async () => {
		let now = 2_000_000_000_000;
		const currentBinding = binding();
		let tokenNumber = 0;
		const proofs: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			const proof = new Headers(init?.headers).get('dpop');
			if (proof) proofs.push(JSON.parse(Buffer.from(proof.split('.')[1]!, 'base64url').toString('utf8')));
			if (url.endsWith('mcp-workload.ready')) return jsonResponse({ status: 'active' });
			if (url.endsWith('mcp-workload.token')) {
				tokenNumber += 1;
				return jsonResponse({ access_token: `token-${tokenNumber}-${'x'.repeat(32)}`, token_type: 'DPoP', expires_in: 300, scope: tokenNumber === 1 ? 'basic:information lists:read' : 'basic:information' });
			}
			throw new Error('unexpected request');
		});
		const client = new WorkloadIdentityClient({
			brokerRequest: brokerFactory({ binding: currentBinding, now: () => now }),
			fetch: fetchMock,
			now: () => now,
		});
		const changes: string[] = [];
		client.onCapabilitiesChanged((capabilities) => changes.push(`${capabilities.status}:${capabilities.grantEpoch}:${capabilities.scopes.join(',')}`));

		const first = await client.getEffectiveCapabilities();
		expect(first).toMatchObject({ status: 'active', grantEpoch: 1, scopes: ['basic:information', 'lists:read'] });
		expect(await client.getAccessToken()).toContain('token-1-');
		expect(tokenNumber).toBe(1);

		now += 271_000;
		currentBinding.grantEpoch = 2;
		await expect(client.getEffectiveCapabilities()).rejects.toMatchObject({ code: 'AUTHORIZATION_STALE' });
		const second = await client.getEffectiveCapabilities();
		expect(second).toMatchObject({ status: 'active', grantEpoch: 2, scopes: ['basic:information'] });
		expect(tokenNumber).toBe(2);
		expect(changes).toContain('active:2:basic:information');
		expect(new Set(proofs.map((proof) => proof.jti)).size).toBe(proofs.length);
		expect(proofs.every((proof) => proof.htm === 'POST')).toBe(true);
	});

	it('never retries a POST implicitly, retries a GET once, and evicts a rejected retry token', async () => {
		let apiCalls = 0;
		let tokenCalls = 0;
		const fetchMock = vi.fn(async (request: string | URL | Request) => {
			const url = String(request);
			if (url.endsWith('mcp-workload.ready')) return jsonResponse({ status: 'active' });
			if (url.endsWith('mcp-workload.token')) {
				tokenCalls += 1;
				return jsonResponse({ access_token: `token-${tokenCalls}-${'x'.repeat(32)}`, token_type: 'DPoP', expires_in: 300, scope: 'basic:information' });
			}
			apiCalls += 1;
			return new Response(null, { status: apiCalls <= 3 ? 401 : 200 });
		});
		const client = new WorkloadIdentityClient({ brokerRequest: brokerFactory({ binding: binding(), now: Date.now }), fetch: fetchMock });

		expect((await client.authorizedFetch('https://hub.example/api/v1/write', { method: 'POST' })).status).toBe(401);
		expect(apiCalls).toBe(1);
		expect((await client.authorizedFetch('https://hub.example/api/v1/read')).status).toBe(401);
		expect(apiCalls).toBe(3);
		expect((await client.authorizedFetch('https://hub.example/api/v1/read')).status).toBe(200);
		expect(apiCalls).toBe(4);
		expect(tokenCalls).toBe(4);
	});

	it('fails closed for another origin and maps permission denial to a stable degradation error', async () => {
		const fetchMock = vi.fn(async (request: string | URL | Request) => {
			const url = String(request);
			if (url.endsWith('mcp-workload.ready')) return jsonResponse({ status: 'active' });
			if (url.endsWith('mcp-workload.token')) return jsonResponse({ access_token: `token-${'x'.repeat(32)}`, token_type: 'DPoP', expires_in: 300, scope: 'basic:information' });
			return jsonResponse({ error: 'internal detail that must not escape' }, 403);
		});
		const client = new WorkloadIdentityClient({ brokerRequest: brokerFactory({ binding: binding(), now: Date.now }), fetch: fetchMock });

		await expect(client.authorizedFetch('https://attacker.example/collect')).rejects.toMatchObject({ code: 'TARGET_ORIGIN_INVALID' });
		await expect(client.authorizedRequest('https://hub.example/api/v1/files', { requiredScope: 'files:read' }))
			.rejects.toEqual(expect.objectContaining({ code: 'PERMISSION_DENIED', requiredScope: 'files:read' }));
		expect(() => client.requireCapability('files:read')).toThrow(WorkloadIdentityError);
	});

	it('does not serialize or inspect access tokens and private DPoP key material', async () => {
		const token = `sensitive-token-${'x'.repeat(32)}`;
		const fetchMock = vi.fn(async (request: string | URL | Request) => String(request).endsWith('mcp-workload.ready')
			? jsonResponse({ status: 'active' })
			: jsonResponse({ access_token: token, token_type: 'DPoP', expires_in: 300, scope: 'basic:information' }));
		const client = new WorkloadIdentityClient({ brokerRequest: brokerFactory({ binding: binding(), now: Date.now }), fetch: fetchMock });
		await client.getAccessToken();
		const serialized = JSON.stringify(client);
		const inspected = inspect(client);
		expect(serialized).not.toContain(token);
		expect(inspected).not.toContain(token);
		expect(serialized).not.toContain('"d"');
		expect(inspected).not.toContain('privateJwk');
	});

	it('uses a dedicated error type for permission-denied responses', () => {
		const error = new WorkloadPermissionDeniedError('files:write');
		expect(error).toMatchObject({ code: 'PERMISSION_DENIED', status: 403, requiredScope: 'files:write' });
		expect(error.message).not.toContain('token');
	});

	it('pairs against a node that attests an App Library generation', async () => {
		const fetchMock = vi.fn(async (request: string | URL | Request) => String(request).endsWith('mcp-workload.ready')
			? jsonResponse({ status: 'active' })
			: jsonResponse({ access_token: `token-${'x'.repeat(32)}`, token_type: 'DPoP', expires_in: 300, scope: 'basic:information' }));
		const client = new WorkloadIdentityClient({ brokerRequest: generationBrokerFactory(), fetch: fetchMock });

		await expect(client.getEffectiveCapabilities()).resolves.toMatchObject({
			status: 'active',
			installationId: 'runtime-installation-1',
			receiptHash: APPROVAL_RECEIPT_HASH,
			grantEpoch: 7,
			workspaceId: 'workspace-1',
			mcpAppId: 'app-1',
			replicaId: 'replica-1',
		});
	});

	it.each([
		['a digest-form approval receipt', { approvalReceiptHash: `sha256:${'a'.repeat(64)}` }],
		['a zero authorization epoch', { authorizationEpoch: 0 }],
		['a replica-shaped installation field', { runtimeInstallationId: undefined, installationId: 'installation-1' }],
	])('refuses a generation attestation with %s', async (_case, override) => {
		const client = new WorkloadIdentityClient({
			brokerRequest: generationBrokerFactory(override),
			fetch: vi.fn(async () => jsonResponse({ status: 'active' })),
		});

		await expect(client.getEffectiveCapabilities()).rejects.toMatchObject({ code: 'BROKER_RESPONSE_INVALID' });
	});

	it('binds room issuance, caches and coalesces per exact child, and isolates stale eviction', async () => {
		const issuanceBodies: Array<Record<string, unknown>> = [];
		const apiTokens: string[] = [];
		let staleBindingOne = false;
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (url.endsWith('mcp-workload.ready')) return jsonResponse({ status: 'active' });
			if (url.endsWith('mcp-workload.token')) {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				issuanceBodies.push(body);
				await Promise.resolve();
				return jsonResponse({
					access_token: `${String(body.authorizationBindingId)}-${issuanceBodies.length}-${'x'.repeat(32)}`,
					token_type: 'DPoP',
					expires_in: 300,
					scope: 'rooms:read',
				});
			}
			const token = new Headers(init?.headers).get('authorization') || '';
			apiTokens.push(token);
			if (staleBindingOne && token.includes('binding-1')) {
				staleBindingOne = false;
				return new Response(null, { status: 401 });
			}
			return new Response(null, { status: 200 });
		});
		const client = new WorkloadIdentityClient({ brokerRequest: generationBrokerFactory({}, HUB_ORIGIN), fetch: fetchMock });
		const roomOne = client.forRoom(await managedRoomContext(client, 'binding-1'));
		const roomTwo = client.forRoom(await managedRoomContext(client, 'binding-2'));
		expect((roomOne as any).getAccessToken).toBeUndefined();

		await Promise.all([
			roomOne.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' }),
			roomOne.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' }),
		]);
		expect(issuanceBodies.filter((body) => body.authorizationBindingId === 'binding-1')).toHaveLength(1);
		await roomTwo.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' });
		expect(issuanceBodies.map((body) => body.authorizationBindingId)).toEqual(['binding-1', 'binding-2']);
		expect(apiTokens[0]).not.toEqual(apiTokens[2]);

		staleBindingOne = true;
		await roomOne.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' });
		await roomTwo.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' });
		expect(issuanceBodies.map((body) => body.authorizationBindingId)).toEqual(['binding-1', 'binding-2', 'binding-1']);
	});

	it('rejects room and origin overrides and replays mutations only when explicitly idempotent and replayable', async () => {
		let apiCalls = 0;
		let tokenCalls = 0;
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (url.endsWith('mcp-workload.ready')) return jsonResponse({ status: 'active' });
			if (url.endsWith('mcp-workload.token')) {
				tokenCalls += 1;
				return jsonResponse({ access_token: `token-${apiCalls}-${'x'.repeat(32)}`, token_type: 'DPoP', expires_in: 300, scope: 'rooms:write' });
			}
			apiCalls += 1;
			return new Response(null, { status: apiCalls < 4 ? 401 : 200 });
		});
		const client = new WorkloadIdentityClient({ brokerRequest: generationBrokerFactory({}, HUB_ORIGIN), fetch: fetchMock });
		const room = client.forRoom(await managedRoomContext(client, 'binding-1'));
		await expect(room.authorizedFetch('https://hub.example/api/v1/write', { method: 'POST', requiredScope: 'rooms:write' }))
			.rejects.toMatchObject({ code: 'TARGET_ORIGIN_INVALID' });
		await expect(room.authorizedFetch('/api/v1/write', {
			method: 'POST', requiredScope: 'rooms:write', authorizationBindingId: 'binding-2',
		} as any)).rejects.toMatchObject({ code: 'TARGET_ORIGIN_INVALID' });
		await expect(room.authorizedFetch('/api/v1/write?%72oomId=room-2', {
			requiredScope: 'rooms:write',
		})).rejects.toMatchObject({ code: 'TARGET_ORIGIN_INVALID' });
		await expect(room.authorizedFetch('/api/v1/write', {
			method: 'POST',
			requiredScope: 'rooms:write',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ rows: [{ nested: { authorizationBindingId: 'binding-2' } }] }),
		})).rejects.toMatchObject({ code: 'TARGET_ORIGIN_INVALID' });
		await expect(room.authorizedFetch('/api/v1/write', {
			method: 'POST', requiredScope: 'rooms:write', body: new URLSearchParams({ roomId: 'room-2' }),
		})).rejects.toMatchObject({ code: 'TARGET_ORIGIN_INVALID' });
		const form = new FormData();
		form.set('authorizationBindingId', 'binding-2');
		await expect(room.authorizedFetch('/api/v1/write', {
			method: 'POST', requiredScope: 'rooms:write', body: form,
		})).rejects.toMatchObject({ code: 'TARGET_ORIGIN_INVALID' });
		await expect(room.authorizedFetch('/api/v1/write', {
			method: 'POST', requiredScope: 'rooms:write', headers: { 'content-type': 'application/json' }, body: '{',
		})).rejects.toMatchObject({ code: 'TARGET_ORIGIN_INVALID' });
		await expect(room.authorizedFetch('/api/v1/write', {
			method: 'POST', requiredScope: 'rooms:write', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'room%GGId=value',
		})).rejects.toMatchObject({ code: 'TARGET_ORIGIN_INVALID' });
		await expect(room.authorizedFetch('/api/v1/write', {
			method: 'POST', requiredScope: 'rooms:write', body: new ReadableStream(),
		})).rejects.toMatchObject({ code: 'TARGET_ORIGIN_INVALID' });
		expect(tokenCalls).toBe(0);
		expect(apiCalls).toBe(0);

		expect((await room.authorizedFetch('/api/v1/write', {
			method: 'POST',
			requiredScope: 'rooms:write',
			headers: { 'content-type': 'application/octet-stream' },
			body: Buffer.from('binary roomId authorizationBindingId bytes'),
		})).status).toBe(401);
		expect(apiCalls).toBe(1);
		expect((await room.authorizedFetch('/api/v1/write', {
			method: 'PATCH', requiredScope: 'rooms:write', retryMode: 'idempotent',
		})).status).toBe(401);
		expect(apiCalls).toBe(2);
		expect((await room.authorizedFetch('/api/v1/write', {
			method: 'PATCH', requiredScope: 'rooms:write', retryMode: 'idempotent', replayable: true,
		})).status).toBe(200);
		expect(apiCalls).toBe(4);
	});

	it('rejects every structurally fabricated room context synchronously', () => {
		const client = new WorkloadIdentityClient({ brokerRequest: generationBrokerFactory(), fetch: vi.fn() });
		expect(() => client.forRoom(fabricatedRoomContext('binding-1'))).toThrow(WorkloadIdentityError);
		expect(() => client.forRoom({ ...fabricatedRoomContext('binding-1'), actor: undefined })).toThrow(WorkloadIdentityError);
		expect(() => client.forRoom({ ...fabricatedRoomContext('binding-1'), roomId: 'room-2' })).toThrow(WorkloadIdentityError);
		expect(() => client.forRoom({
			...fabricatedRoomContext('binding-1'),
			runtimeAuthorization: { ...fabricatedRoomContext('binding-1').runtimeAuthorization!, authorizationContext: 'workspace' } as any,
		})).toThrow(WorkloadIdentityError);
	});

	it('keeps the exact-key token cache at 64 entries with deterministic expiry and LRU eviction', async () => {
		let now = Date.now();
		let tokenCalls = 0;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const target = String(input);
			if (target.endsWith('mcp-workload.ready')) return jsonResponse({ status: 'active' });
			if (target.endsWith('mcp-workload.token')) {
				tokenCalls += 1;
				return jsonResponse({
					access_token: `bounded-token-${tokenCalls}-${'x'.repeat(32)}`,
					token_type: 'DPoP',
					expires_in: 300,
					scope: 'rooms:read',
				});
			}
			return new Response(null, { status: 200 });
		});
		const client = new WorkloadIdentityClient({
			brokerRequest: generationBrokerFactory({}, HUB_ORIGIN, () => now),
			fetch: fetchMock,
			now: () => now,
		});
		const rooms = [];
		for (let index = 0; index < 65; index += 1) {
			rooms.push(client.forRoom(await managedRoomContext(client, `binding-${index}`)));
		}
		for (const room of rooms.slice(0, 64)) {
			await room.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' });
		}
		expect(tokenCalls).toBe(64);
		await rooms[0]!.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' });
		await rooms[64]!.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' });
		await rooms[0]!.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' });
		expect(tokenCalls).toBe(65);
		await rooms[1]!.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' });
		expect(tokenCalls).toBe(66);
		expect((client as any).tokens.size).toBe(64);

		now += 301_000;
		await rooms[0]!.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' });
		expect(tokenCalls).toBe(67);
		expect((client as any).tokens.size).toBe(1);
		expect(JSON.stringify(client)).not.toContain('bounded-token-');
	});

	it('keeps disposal terminal when pending token issuance settles successfully', async () => {
		let releaseTokenResponse: (() => void) | undefined;
		let tokenCalls = 0;
		let apiCalls = 0;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const target = String(input);
			if (target.endsWith('mcp-workload.ready')) return jsonResponse({ status: 'active' });
			if (target.endsWith('mcp-workload.token')) {
				tokenCalls += 1;
				return new Promise<Response>((resolve) => {
					releaseTokenResponse = () => resolve(jsonResponse({
						access_token: `post-dispose-token-${'x'.repeat(32)}`,
						token_type: 'DPoP',
						expires_in: 300,
						scope: 'basic:information',
					}));
				});
			}
			apiCalls += 1;
			return new Response(null, { status: 200 });
		});
		const client = new WorkloadIdentityClient({
			brokerRequest: generationBrokerFactory({}, HUB_ORIGIN),
			fetch: fetchMock,
		});
		await client.ensureReady();

		const pending = client.authorizedFetch('/api/v1/workspace');
		await vi.waitFor(() => expect(releaseTokenResponse).toBeTypeOf('function'));
		client.dispose();
		client.dispose();
		releaseTokenResponse!();

		await expect(pending).rejects.toMatchObject({ code: 'CLIENT_DISPOSED' });
		expect((client as any).tokens.size).toBe(0);
		expect((client as any).tokenIssuance.size).toBe(0);
		expect(client.peekEffectiveCapabilities().status).toBe('paired');
		expect(apiCalls).toBe(0);

		await expect(client.authorizedFetch('/api/v1/workspace')).rejects.toMatchObject({ code: 'CLIENT_DISPOSED' });
		expect(tokenCalls).toBe(1);
		expect(apiCalls).toBe(0);
	});

	it('coalesces same-key issuance, bounds 64 distinct active keys, and releases settled capacity', async () => {
		const releases: Array<() => void> = [];
		let tokenCalls = 0;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const target = String(input);
			if (target.endsWith('mcp-workload.ready')) return jsonResponse({ status: 'active' });
			if (target.endsWith('mcp-workload.token')) {
				tokenCalls += 1;
				const tokenNumber = tokenCalls;
				return new Promise<Response>((resolve) => releases.push(() => resolve(jsonResponse({
					access_token: `in-flight-token-${tokenNumber}-${'x'.repeat(32)}`,
					token_type: 'DPoP',
					expires_in: 300,
					scope: 'rooms:read',
				}))));
			}
			return new Response(null, { status: 200 });
		});
		const client = new WorkloadIdentityClient({
			brokerRequest: generationBrokerFactory({}, HUB_ORIGIN),
			fetch: fetchMock,
		});
		await client.ensureReady();
		const rooms = [];
		for (let index = 0; index < 65; index += 1) {
			rooms.push(client.forRoom(await managedRoomContext(client, `in-flight-binding-${index}`)));
		}
		const active = rooms.slice(0, 64).map((room) =>
			room.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' }));
		const duplicate = rooms[0]!.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' });
		await vi.waitFor(() => expect(tokenCalls).toBe(64));
		await expect(rooms[64]!.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' }))
			.rejects.toMatchObject({ code: 'AUTHORIZATION_CAPACITY_EXCEEDED', status: 503 });
		expect(tokenCalls).toBe(64);

		releases[0]!();
		await Promise.all([active[0], duplicate]);
		const afterSettlement = rooms[64]!.authorizedRequest('/api/v1/rooms/state', { requiredScope: 'rooms:read' });
		await vi.waitFor(() => expect(tokenCalls).toBe(65));
		releases[64]!();
		await afterSettlement;
		for (const release of releases.slice(1, 64)) release();
		await Promise.all(active.slice(1));
		expect((client as any).tokenIssuance.size).toBe(0);
	});

	it('fails workspace and room issuance when broker authorization rotates after key selection', async () => {
		for (const kind of ['workspace', 'room'] as const) {
			let authorizationEpoch = 7;
			let tokenCalls = 0;
			const fetchMock = vi.fn(async (input: string | URL | Request) => {
				const target = String(input);
				if (target.endsWith('mcp-workload.ready')) return jsonResponse({ status: 'active' });
				if (target.endsWith('mcp-workload.token')) {
					tokenCalls += 1;
					return jsonResponse({ access_token: `rotation-${'x'.repeat(32)}`, token_type: 'DPoP', expires_in: 300, scope: 'rooms:read' });
				}
				return new Response(null, { status: 200 });
			});
			const client = new WorkloadIdentityClient({
				brokerRequest: generationBrokerFactory(() => ({ authorizationEpoch }), HUB_ORIGIN),
				fetch: fetchMock,
			});
			await client.ensureReady();
			const pending = kind === 'workspace'
				? client.authorizedFetch('/api/v1/workspace')
				: client.forRoom(await managedRoomContext(client, 'rotation-binding')).authorizedRequest(
					'/api/v1/rooms/state',
					{ requiredScope: 'rooms:read' },
				);
			authorizationEpoch = 8;
			await expect(pending).rejects.toMatchObject({ code: 'AUTHORIZATION_STALE', status: 401 });
			expect(tokenCalls).toBe(0);
		}
	});

	it('evicts the actual 401 token key without deleting a newer rotated authorization', async () => {
		let authorizationEpoch = 7;
		let tokenCalls = 0;
		let releaseOld401: (() => void) | undefined;
		const apiTokens: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const target = String(input);
			if (target.endsWith('mcp-workload.ready')) return jsonResponse({ status: 'active' });
			if (target.endsWith('mcp-workload.token')) {
				tokenCalls += 1;
				const requestBody = JSON.parse(String(init?.body)) as { attestation: string };
				const payload = JSON.parse(Buffer.from(requestBody.attestation.split('.')[1]!, 'base64url').toString('utf8')) as { authorizationEpoch: number };
				return jsonResponse({
					access_token: `epoch-${payload.authorizationEpoch}-token-${tokenCalls}-${'x'.repeat(32)}`,
					token_type: 'DPoP',
					expires_in: 300,
					scope: 'basic:information',
				});
			}
			const authorization = new Headers(init?.headers).get('authorization') ?? '';
			apiTokens.push(authorization);
			if (authorization.includes('epoch-7-token')) {
				return new Promise<Response>((resolve) => {
					releaseOld401 = () => resolve(new Response(null, { status: 401 }));
				});
			}
			return new Response(null, { status: 200 });
		});
		const client = new WorkloadIdentityClient({
			brokerRequest: generationBrokerFactory(() => ({ authorizationEpoch }), HUB_ORIGIN),
			fetch: fetchMock,
		});
		expect(await client.getAccessToken()).toContain('epoch-7-token');
		const oldRequest = client.authorizedFetch('/api/v1/read');
		await vi.waitFor(() => expect(releaseOld401).toBeTypeOf('function'));

		authorizationEpoch = 8;
		await expect(client.getAccessToken({ forceRefresh: true }))
			.rejects.toMatchObject({ code: 'AUTHORIZATION_STALE', status: 401 });
		await expect(client.authorizedFetch('/api/v1/read')).resolves.toMatchObject({ status: 200 });
		expect(tokenCalls).toBe(2);
		releaseOld401!();
		await expect(oldRequest).rejects.toMatchObject({ code: 'AUTHORIZATION_STALE', status: 401 });

		await expect(client.authorizedFetch('/api/v1/read')).resolves.toMatchObject({ status: 200 });
		expect(tokenCalls).toBe(2);
		expect(apiTokens.at(-1)).toContain('epoch-8-token');
		expect(apiTokens.filter((token) => token.includes('epoch-7-token'))).toHaveLength(1);
	});
});
