import crypto, { type JsonWebKey } from 'node:crypto';

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import type { AppDescriptor } from '../../src/app-descriptor.js';
import { createDirectRouter } from '../../src/direct/express-router.js';
import type { ToolCallContext } from '../../src/context/tool-call-context.js';
import { WorkloadIdentityClient, type WorkloadBrokerResponse } from '../../src/workload/workload-identity.js';
import { sha256RuntimeDispatchBodyV3 } from '../../src/workload/dispatch-assertion.js';

const descriptor: AppDescriptor = { id: 'ai.privos.managed', name: 'Managed', version: '1.0.0' };
const generation = {
	clusterId: 'cluster-1',
	deploymentId: 'deployment-1',
	generationId: 'generation-1',
	generationNumber: 2,
	runtimeInstallationId: 'runtime-1',
	manifestDigest: `sha256:${'a'.repeat(64)}`,
	resourceManifestHash: 'B'.repeat(43),
	runtimeResourceInventoryHash: 'C'.repeat(43),
	approvalReceiptHash: 'D'.repeat(43),
	authorizationEpoch: 7,
};
const hubPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const hubPublicJwk = hubPair.publicKey.export({ format: 'jwk' });
const HUB_ORIGIN = 'https://hub.example';
const canonical = (value: unknown): string => JSON.stringify(canonicalize(value));

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

const hubKid = crypto.createHash('sha256').update(canonical({
	crv: hubPublicJwk.crv,
	kty: hubPublicJwk.kty,
	x: hubPublicJwk.x,
	y: hubPublicJwk.y,
})).digest('base64url');

function signEs256(header: Record<string, unknown>, payload: Record<string, unknown>): string {
	const encodedHeader = Buffer.from(canonical(header)).toString('base64url');
	const encodedPayload = Buffer.from(canonical(payload)).toString('base64url');
	const signature = crypto.sign('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'), {
		key: hubPair.privateKey,
		dsaEncoding: 'ieee-p1363',
	}).toString('base64url');
	return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function workloadClient(fetchImplementation?: typeof fetch): WorkloadIdentityClient {
	return new WorkloadIdentityClient({
		...(fetchImplementation ? { fetch: fetchImplementation } : {}),
		brokerRequest: async (requestBody: Record<string, unknown>): Promise<WorkloadBrokerResponse> => {
			const publicJwk = requestBody.publicJwk as JsonWebKey;
			const dpopJkt = crypto.createHash('sha256').update(canonical({
				crv: publicJwk.crv,
				kty: publicJwk.kty,
				x: publicJwk.x,
				y: publicJwk.y,
			})).digest('base64url');
			const now = Math.floor(Date.now() / 1_000);
			const attestation = `e30.${Buffer.from(JSON.stringify({
				protocolVersion: 3,
				type: 'node-workload-attestation',
				iat: now,
				exp: now + 45,
				nonce: requestBody.nonce,
				dpopJkt,
				workspaceId: 'workspace-1',
				mcpAppId: descriptor.id,
				replicaId: 'replica-1',
				...generation,
			})).toString('base64url')}.c2ln`;
			return {
				ok: true,
				attestation,
				hubOrigin: HUB_ORIGIN,
				hubKid,
				hubPublicJwk,
			};
		},
	});
}

function dispatchAssertion(
	body: unknown,
	context: 'room' | 'workspace' = 'room',
	extraClaims: Record<string, unknown> = {},
): string {
	const now = Math.floor(Date.now() / 1_000);
	return signEs256(
		{ alg: 'ES256', kid: hubKid, privos_protocol: 3, typ: 'privos-hub-dispatch+jws' },
		{
			protocolVersion: 3,
			type: 'hub-dispatch-assertion',
			iss: `urn:privos:hub:${generation.deploymentId}`,
			aud: 'privos-mcp-app',
			jti: crypto.randomUUID(),
			nonce: crypto.randomBytes(24).toString('base64url'),
			iat: now,
			exp: now + 30,
			workspaceId: 'workspace-1',
			mcpAppId: descriptor.id,
			clusterAppId: 'cluster-app-1',
			htm: 'POST',
			htu: '/mcp',
			bodyDigest: sha256RuntimeDispatchBodyV3(body),
			runtimeApprovalReceiptHash: generation.approvalReceiptHash,
			runtimeGrantEpoch: generation.authorizationEpoch,
			authorizationContext: context,
			clusterId: generation.clusterId,
			deploymentId: generation.deploymentId,
			generationId: generation.generationId,
			generationNumber: generation.generationNumber,
			runtimeInstallationId: generation.runtimeInstallationId,
			manifestDigest: generation.manifestDigest,
			resourceManifestHash: generation.resourceManifestHash,
			runtimeResourceInventoryHash: generation.runtimeResourceInventoryHash,
			...(context === 'room'
				? {
						roomId: 'room-1',
						authorizationBindingId: 'binding-1',
						bindingReceiptHash: 'E'.repeat(43),
						bindingEpoch: 3,
					}
				: {}),
			...extraClaims,
		},
	);
}

function appHarness(seen: ToolCallContext[], client = workloadClient()) {
	const app = express();
	app.use(createDirectRouter({
		descriptor,
		workloadSecurity: 'required',
		workloadIdentityClient: client,
		auth: {
			jwksUrl: 'https://attacker.invalid/jwks',
			audience: 'wrong-audience',
			issuer: 'https://attacker.invalid',
			localJwks: { keys: [] },
		},
		handler: async (_rpc, context) => {
			seen.push(context);
			return { tools: [] };
		},
	}));
	return app;
}

describe('managed Cluster v3 canonical Direct ingress', () => {
	it('admits an actorless managed room dispatch and derives the room workload client from the assertion', async () => {
		const seen: ToolCallContext[] = [];
		const client = workloadClient();
		const app = appHarness(seen, client);
		const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
		await request(app).post('/mcp')
			.set('X-PrivOS-Dispatch-Assertion', dispatchAssertion(body))
			.send(body)
			.expect(200);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			identityState: 'missing',
			roomId: 'room-1',
			runtimeAuthorization: { authorizationBindingId: 'binding-1', authorizationContext: 'room' },
		});
		expect(seen[0]).not.toHaveProperty('actor');
		expect(Object.isFrozen(seen[0]!.runtimeAuthorization)).toBe(true);
		expect(Object.isFrozen(seen[0])).toBe(true);
		expect((client.forRoom(seen[0]!) as any).getAccessToken).toBeUndefined();
	});

	it('surfaces only a signed optional actor as frozen immediate attribution', async () => {
		const seen: ToolCallContext[] = [];
		const client = workloadClient();
		const body = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
		await request(appHarness(seen, client)).post('/mcp')
			.set('X-PrivOS-Dispatch-Assertion', dispatchAssertion(body, 'room', {
				actor: { subject: 'user-1', username: 'alice', roomId: 'room-1' },
			}))
			.send(body)
			.expect(200);
		expect(seen[0]).toMatchObject({
			identityState: 'verified',
			actor: { userId: 'user-1', username: 'alice', roomId: 'room-1' },
		});
		expect(Object.isFrozen(seen[0]!.actor)).toBe(true);
		expect(Object.isFrozen(seen[0]!.actor!.claims)).toBe(true);
		expect(() => client.forRoom(seen[0]!)).not.toThrow();
	});

	it('accepts only the exact owning-client context capability minted by managed ingress', async () => {
		const seen: ToolCallContext[] = [];
		const fetchMock = vi.fn<typeof fetch>();
		const client = workloadClient(fetchMock);
		const body = { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} };
		await request(appHarness(seen, client)).post('/mcp')
			.set('X-PrivOS-Dispatch-Assertion', dispatchAssertion(body))
			.send(body)
			.expect(200);
		const authentic = seen[0]!;
		const fabricated = Object.fromEntries(Object.entries(authentic)) as unknown as ToolCallContext;
		const deepEqual = structuredClone(authentic);
		const spreadClone = { ...authentic };
		const prototypeCopy = Object.assign(Object.create(Object.getPrototypeOf(authentic)), authentic) as ToolCallContext;
		const substituted = {
			...authentic,
			runtimeAuthorization: Object.freeze({
				...authentic.runtimeAuthorization!,
				authorizationBindingId: 'binding-2',
				bindingReceiptHash: 'F'.repeat(43),
			}),
		};

		expect(() => client.forRoom(authentic)).not.toThrow();
		for (const candidate of [fabricated, deepEqual, spreadClone, prototypeCopy, substituted]) {
			expect(() => client.forRoom(candidate as ToolCallContext)).toThrowError(/authentic managed-ingress room context/i);
		}
		expect(() => workloadClient().forRoom(authentic)).toThrowError(/authentic managed-ingress room context/i);
		expect(Reflect.set(authentic.runtimeAuthorization!, 'authorizationBindingId', 'binding-2')).toBe(false);
		expect(
			authentic.runtimeAuthorization && 'authorizationBindingId' in authentic.runtimeAuthorization
				? authentic.runtimeAuthorization.authorizationBindingId
				: undefined,
		).toBe('binding-1');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		['a missing actor subject', { actor: { username: 'alice' } }],
		['an unknown actor key', { actor: { subject: 'user-1', role: 'admin' } }],
		['an unknown assertion claim', { callerCredential: 'bearer' }],
	])('rejects %s before the handler', async (_case, claims) => {
		const body = { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} };
		const seen: ToolCallContext[] = [];
		await request(appHarness(seen)).post('/mcp')
			.set('X-PrivOS-Dispatch-Assertion', dispatchAssertion(body, 'room', claims))
			.send(body)
			.expect(403);
		expect(seen).toHaveLength(0);
	});

	it('rejects an obsolete separate caller channel and ambiguous assertions', async () => {
		const seen: ToolCallContext[] = [];
		const body = { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} };
		await request(appHarness(seen)).post('/mcp')
			.set('X-PrivOS-Dispatch-Assertion', dispatchAssertion(body))
			.set('Authorization', 'Bearer retired-caller-token')
			.set('X-MCP-User-Id', 'user-1')
			.send(body)
			.expect(403);
		expect(seen).toHaveLength(0);

		await request(appHarness(seen)).post('/mcp')
			.set('X-PrivOS-Dispatch-Assertion', dispatchAssertion(body))
			.set('X-PrivOS-MCP-Dispatch-Assertion', 'other.header.signature')
			.send(body)
			.expect(403);
		expect(seen).toHaveLength(0);
	});
});
