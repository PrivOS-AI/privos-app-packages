import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { verifyDispatchAssertion } from '../../src/workload/dispatch-assertion.js';
import type { WorkloadBrokerContext } from '../../src/workload/workload-identity.js';

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalize(child)]),
		);
	}
	return value;
}

describe('workload dispatch assertions', () => {
	it('verifies exact binding and rejects replay/tamper', () => {
		const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
		const privateJwk = pair.privateKey.export({ format: 'jwk' });
		const publicJwk = pair.publicKey.export({ format: 'jwk' });
		const kid = crypto.createHash('sha256').update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y })).digest('base64url');
		const context: WorkloadBrokerContext = {
			hubOrigin: 'https://hub.example',
			hubKid: kid,
			hubPublicJwk: publicJwk,
			binding: {
				workspaceId: 'workspace-1', installationId: 'install-1', mcpAppId: 'app-1',
				replicaId: '62f8f1ce-2a12-45f4-a389-3bd5f0409bd4', receiptHash: `sha256:${'a'.repeat(64)}`, grantEpoch: 2,
			},
		};
		const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
		const now = 2_000_000_000;
		const payload = {
			type: 'hub-dispatch-assertion', aud: 'privos-mcp-app', jti: crypto.randomUUID(), iat: now, exp: now + 30,
			workspaceId: 'workspace-1', installationId: 'install-1', mcpAppId: 'app-1', clusterAppId: crypto.randomUUID(),
			replicaId: context.binding.replicaId, htm: 'POST', htu: '/mcp',
			bodyDigest: `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex')}`,
			receiptHash: context.binding.receiptHash, grantEpoch: 2,
			actor: { subject: 'user-1', username: 'alice', roomId: 'room-1' },
		};
		const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'privos-hub-dispatch+jws', kid })).toString('base64url');
		const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
		const signingInput = Buffer.from(`${header}.${encodedPayload}`);
		const signature = crypto.sign('sha256', signingInput, {
			key: crypto.createPrivateKey({ key: privateJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
		}).toString('base64url');
		const compact = `${header}.${encodedPayload}.${signature}`;

		expect(verifyDispatchAssertion({ compact, body, context, now })).toMatchObject({
			actor: { subject: 'user-1', username: 'alice', roomId: 'room-1' },
		});
		expect(() => verifyDispatchAssertion({ compact, body, context, now })).toThrow('dispatch_assertion_replayed');
		expect(() => verifyDispatchAssertion({ compact: compact.replace(/.$/, 'A'), body, context, now })).toThrow();
	});
});
