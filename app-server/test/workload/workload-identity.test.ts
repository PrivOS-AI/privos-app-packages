import crypto, { type JsonWebKey } from 'node:crypto';
import { inspect } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
	WorkloadIdentityClient,
	WorkloadIdentityError,
	WorkloadPermissionDeniedError,
	type WorkloadBinding,
	type WorkloadBrokerResponse,
} from '../../src/workload/workload-identity.js';

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

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
		const second = await client.getEffectiveCapabilities();
		expect(second).toMatchObject({ status: 'active', grantEpoch: 2, scopes: ['basic:information'] });
		expect(tokenNumber).toBe(2);
		expect(changes).toContain('active:2:basic:information');
		expect(new Set(proofs.map((proof) => proof.jti)).size).toBe(proofs.length);
		expect(proofs.every((proof) => proof.htm === 'POST')).toBe(true);
	});

	it('never retries a POST implicitly and retries a sender-constrained GET once', async () => {
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
			return new Response(null, { status: apiCalls === 1 || apiCalls === 2 ? 401 : 200 });
		});
		const client = new WorkloadIdentityClient({ brokerRequest: brokerFactory({ binding: binding(), now: Date.now }), fetch: fetchMock });

		expect((await client.authorizedFetch('https://hub.example/api/v1/write', { method: 'POST' })).status).toBe(401);
		expect(apiCalls).toBe(1);
		expect((await client.authorizedFetch('https://hub.example/api/v1/read')).status).toBe(200);
		expect(apiCalls).toBe(3);
		expect(tokenCalls).toBe(3);
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
});
