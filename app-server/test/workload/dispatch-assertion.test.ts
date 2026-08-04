import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
	BoundedRuntimeDispatchReplayConsumerV3,
	assertRuntimeDispatchRelayAffinityV3,
	assertRuntimeDispatchTrustConfigurationV3,
	extractRuntimeDispatchRelayEnvelopeV3,
	isUnsignedRuntimeReadinessRpcV3,
	parseRuntimeDispatchTrustV3Json,
	sha256RuntimeDispatchBodyV3,
	verifyDispatchAssertion,
	verifyRuntimeDispatchAssertionV3,
	type RuntimeDispatchSecurityV3,
	type RuntimeDispatchTrustV3,
} from '../../src/workload/dispatch-assertion.js';
import type { WorkloadBrokerContext } from '../../src/workload/workload-identity.js';

const RUNTIME_V3_NOW = 1_785_816_000;
const RUNTIME_V3_PUBLIC_JWK = {
	kty: 'EC',
	crv: 'P-256',
	x: 'QnQhvyhIzIERjpS3t5rHEiNULLmV_ABrViKZRO32IQE',
	y: 'c4BDW1f1M7vJfiqYgLe537irq5Y6OvZ-ay9d-mYMYLw',
};
const RUNTIME_V3_TRUST: RuntimeDispatchTrustV3 = {
	hubKid: 'Cw2abzT4NR_Pi3PZCD7Y-NnTH3UKcA-Xdu3wHLwTZVI',
	hubPublicJwk: RUNTIME_V3_PUBLIC_JWK,
	affinity: {
		workspaceId: 'workspace-1',
		deploymentId: 'deployment-1',
		mcpAppId: 'mcp-app-1',
		executionMode: 'SELF_HOSTED_LOCAL',
		generationId: 'generation-1',
		generationNumber: 1,
		runtimeInstallationId: 'installation-1',
		manifestDigest: `sha256:${'a'.repeat(64)}`,
		resourceManifestHash: 'B'.repeat(43),
		runtimeResourceInventoryHash: 'C'.repeat(43),
		runtimeApprovalReceiptHash: 'D'.repeat(43),
		runtimeAuthorizationEpoch: 1,
	},
};
const ROOM_LOGICAL_RPC = {
	jsonrpc: '2.0',
	id: 7,
	method: 'tools/call',
	params: {
		_meta: { traceId: 'trace-1' },
		arguments: { message: 'hello' },
		name: 'echo',
	},
};
const ROOM_COMPACT = 'eyJhbGciOiJFUzI1NiIsImtpZCI6IkN3MmFielQ0TlJfUGkzUFpDRDdZLU5uVEgzVUtjQS1YZHUzd0hMd1RaVkkiLCJwcml2b3NfcHJvdG9jb2wiOjMsInR5cCI6InByaXZvcy1odWItcnVudGltZS1kaXNwYXRjaCtqd3MifQ.eyJhdWQiOiJtY3AtcnVudGltZTptY3AtYXBwLTEiLCJhdXRob3JpemF0aW9uQmluZGluZ0lkIjoiYmluZGluZy0xIiwiYXV0aG9yaXphdGlvbkNvbnRleHQiOiJyb29tIiwiYmluZGluZ0Vwb2NoIjoxLCJiaW5kaW5nR3JhbnRIYXNoIjoiSEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISCIsImJpbmRpbmdSZWNlaXB0SGFzaCI6IkdHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0ciLCJiaW5kaW5nVG9rZW5WZXJzaW9uIjoxLCJib2R5RGlnZXN0IjoicVBEbk5VNXJCNTJWRFZyN0RDTjUxRFVjdldKUEdjS2JlT0xNUmpWNFdBQSIsImRlcGxveW1lbnRJZCI6ImRlcGxveW1lbnQtMSIsImV4ZWN1dGlvbk1vZGUiOiJTRUxGX0hPU1RFRF9MT0NBTCIsImV4cCI6MTc4NTgxNjAzMCwiZ2VuZXJhdGlvbklkIjoiZ2VuZXJhdGlvbi0xIiwiZ2VuZXJhdGlvbk51bWJlciI6MSwiaHRtIjoiUE9TVCIsImh0dSI6Ii9tY3AiLCJpYXQiOjE3ODU4MTYwMDAsImlzcyI6Imh1YjpkZXBsb3ltZW50LTEiLCJqdGkiOiJkaXNwYXRjaC1yb29tLTEiLCJtYW5pZmVzdERpZ2VzdCI6InNoYTI1NjphYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhIiwibWNwQXBwSWQiOiJtY3AtYXBwLTEiLCJub25jZSI6IkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGIiwicHJvdG9jb2xWZXJzaW9uIjozLCJyZXNvdXJjZU1hbmlmZXN0SGFzaCI6IkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkIiLCJyb29tSWQiOiJyb29tLTEiLCJydW50aW1lQXBwcm92YWxSZWNlaXB0SGFzaCI6IkREREREREREREREREREREREREREREREREREREREREREREREREREREREREQiLCJydW50aW1lQXV0aG9yaXphdGlvbkVwb2NoIjoxLCJydW50aW1lSW5zdGFsbGF0aW9uSWQiOiJpbnN0YWxsYXRpb24tMSIsInJ1bnRpbWVSZXNvdXJjZUludmVudG9yeUhhc2giOiJDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDIiwidHlwZSI6Imh1Yi1ydW50aW1lLWRpc3BhdGNoLWFzc2VydGlvbiIsIndvcmtzcGFjZUlkIjoid29ya3NwYWNlLTEifQ.cwVEFG73EiWnTxNe5zIFrKi08KU8-2C6dB4h78ny7laprCXnXM3NmG-pSY-WnTmupU2c-Q6OaTsNEKzhHw9qvg';

function runtimeV3Security(
	trust: RuntimeDispatchTrustV3 = RUNTIME_V3_TRUST,
): RuntimeDispatchSecurityV3 {
	return {
		mode: 'required',
		trust,
		now: () => RUNTIME_V3_NOW,
		replayConsumer: new BoundedRuntimeDispatchReplayConsumerV3(),
	};
}

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

describe('protocol-v3 runtime dispatch assertions', () => {
	it('verifies the frozen ES256 room vector and reconstructs the exact logical RPC', async () => {
		const transportRpc = {
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: {
				_meta: {
					traceId: 'trace-1',
					privosAuthorization: {
						assertion: ROOM_COMPACT,
						runtimeInstallationId: 'installation-1',
						authorizationBindingId: 'binding-1',
					},
					privosUser: {
						userToken: 'signed-user-token-vector',
						userId: 'user-1',
						roomId: 'room-1',
					},
				},
				arguments: { message: 'hello' },
				name: 'echo',
			},
		};
		const envelope = extractRuntimeDispatchRelayEnvelopeV3(transportRpc);
		expect(envelope.logicalRpc).toEqual(ROOM_LOGICAL_RPC);
		expect(envelope.userMetadata).toEqual({
			userToken: 'signed-user-token-vector',
			userId: 'user-1',
			roomId: 'room-1',
		});
		const emptyMeta = extractRuntimeDispatchRelayEnvelopeV3({
			jsonrpc: '2.0',
			id: 8,
			method: 'tools/list',
			params: {
				_meta: {
					privosAuthorization: {
						assertion: ROOM_COMPACT,
						runtimeInstallationId: 'installation-1',
						authorizationBindingId: 'binding-1',
					},
					privosUser: { userId: 'user-1' },
				},
			},
		});
		expect(emptyMeta.logicalRpc).toEqual({
			jsonrpc: '2.0', id: 8, method: 'tools/list', params: {},
		});

		const verified = await verifyRuntimeDispatchAssertionV3({
			compact: envelope.authorization.assertion,
			body: envelope.logicalRpc,
			security: runtimeV3Security(),
		});
		expect(verified).toMatchObject({
			authorizationContext: 'room',
			workspaceId: 'workspace-1',
			runtimeInstallationId: 'installation-1',
			roomId: 'room-1',
			authorizationBindingId: 'binding-1',
		});
		expect(Object.isFrozen(verified)).toBe(true);
		expect(() => assertRuntimeDispatchRelayAffinityV3(envelope.authorization, verified)).not.toThrow();
	});

	it('rejects body tamper, wrapper-affinity mismatch, and replay', async () => {
		await expect(verifyRuntimeDispatchAssertionV3({
			compact: ROOM_COMPACT,
			body: {
				...ROOM_LOGICAL_RPC,
				params: { ...ROOM_LOGICAL_RPC.params, arguments: { message: 'tampered' } },
			},
			security: runtimeV3Security(),
		})).rejects.toThrow('dispatch_assertion_body_mismatch');

		const verified = await verifyRuntimeDispatchAssertionV3({
			compact: ROOM_COMPACT,
			body: ROOM_LOGICAL_RPC,
			security: runtimeV3Security(),
		});
		expect(() => assertRuntimeDispatchRelayAffinityV3({
			assertion: ROOM_COMPACT,
			runtimeInstallationId: 'wrong-installation',
			authorizationBindingId: 'binding-1',
		}, verified)).toThrow('dispatch_assertion_binding_mismatch');
		expect(() => assertRuntimeDispatchRelayAffinityV3({
			assertion: ROOM_COMPACT,
			runtimeInstallationId: 'installation-1',
			authorizationBindingId: 'wrong-binding',
		}, verified)).toThrow('dispatch_assertion_binding_mismatch');

		const security = runtimeV3Security();
		await expect(verifyRuntimeDispatchAssertionV3({
			compact: ROOM_COMPACT,
			body: ROOM_LOGICAL_RPC,
			security,
		})).resolves.toMatchObject({ jti: 'dispatch-room-1' });
		await expect(verifyRuntimeDispatchAssertionV3({
			compact: ROOM_COMPACT,
			body: ROOM_LOGICAL_RPC,
			security,
		})).rejects.toThrow('dispatch_assertion_replayed');
	});

	it('resolves trust independently and enforces every supplied affinity expectation', async () => {
		let resolverHint: unknown;
		const security: RuntimeDispatchSecurityV3 = {
			...runtimeV3Security(),
			trust: (hint) => {
				resolverHint = hint;
				return RUNTIME_V3_TRUST;
			},
		};
		await expect(verifyRuntimeDispatchAssertionV3({
			compact: ROOM_COMPACT,
			body: ROOM_LOGICAL_RPC,
			security,
		})).resolves.toMatchObject({ authorizationContext: 'room' });
		expect(resolverHint).toEqual({
			kid: RUNTIME_V3_TRUST.hubKid,
			workspaceId: 'workspace-1',
			deploymentId: 'deployment-1',
			mcpAppId: 'mcp-app-1',
			executionMode: 'SELF_HOSTED_LOCAL',
			generationId: 'generation-1',
			generationNumber: 1,
			runtimeInstallationId: 'installation-1',
			authorizationContext: 'room',
			roomId: 'room-1',
			authorizationBindingId: 'binding-1',
		});

		await expect(verifyRuntimeDispatchAssertionV3({
			compact: ROOM_COMPACT,
			body: ROOM_LOGICAL_RPC,
			security: runtimeV3Security({
				...RUNTIME_V3_TRUST,
				affinity: { ...RUNTIME_V3_TRUST.affinity, runtimeAuthorizationEpoch: 2 },
			}),
		})).rejects.toThrow('dispatch_assertion_binding_mismatch');
	});

	it('accepts stable pre-start affinity and strictly parses optional post-readiness expectations', async () => {
		const {
			runtimeResourceInventoryHash: _inventory,
			runtimeApprovalReceiptHash: _approval,
			runtimeAuthorizationEpoch: _epoch,
			...stableAffinity
		} = RUNTIME_V3_TRUST.affinity;
		const localPreStartTrust: RuntimeDispatchTrustV3 = {
			...RUNTIME_V3_TRUST,
			affinity: stableAffinity,
		};
		await expect(verifyRuntimeDispatchAssertionV3({
			compact: ROOM_COMPACT,
			body: ROOM_LOGICAL_RPC,
			security: runtimeV3Security(localPreStartTrust),
		})).resolves.toMatchObject({ runtimeResourceInventoryHash: 'C'.repeat(43) });

		const parsed = parseRuntimeDispatchTrustV3Json(JSON.stringify(localPreStartTrust));
		expect(parsed).toEqual(localPreStartTrust);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.hubPublicJwk)).toBe(true);
		expect(Object.isFrozen(parsed.affinity)).toBe(true);
		expect(() => assertRuntimeDispatchTrustConfigurationV3(parsed)).not.toThrow();
		expect(() => parseRuntimeDispatchTrustV3Json('{invalid')).toThrow('runtime_dispatch_trust_invalid');
		expect(() => assertRuntimeDispatchTrustConfigurationV3({
			...localPreStartTrust,
			unexpected: true,
		})).toThrow('runtime_dispatch_trust_invalid');
		expect(() => assertRuntimeDispatchTrustConfigurationV3({
			...localPreStartTrust,
			affinity: { ...stableAffinity, runtimeAuthorizationEpoch: 0 },
		})).toThrow('runtime_dispatch_trust_invalid');
		expect(() => assertRuntimeDispatchTrustConfigurationV3({
			...localPreStartTrust,
			hubPublicJwk: { ...localPreStartTrust.hubPublicJwk, x: 'A'.repeat(43) },
		})).toThrow('runtime_dispatch_trust_invalid');
		expect(() => assertRuntimeDispatchTrustConfigurationV3({
			...localPreStartTrust,
			hubPublicJwk: { ...localPreStartTrust.hubPublicJwk, x: `${String(localPreStartTrust.hubPublicJwk.x).slice(0, -1)}F` },
		})).toThrow('runtime_dispatch_trust_invalid');
	});

	it('uses bounded fail-closed replay storage with atomic consume semantics', () => {
		const replay = new BoundedRuntimeDispatchReplayConsumerV3(1);
		const first = {
			issuer: 'hub:deployment-1',
			jti: 'jti-1',
			nonce: 'A'.repeat(32),
			expiresAt: 110,
			now: 100,
		};
		expect(replay.consume(first)).toBe(true);
		expect(replay.consume(first)).toBe(false);
		expect(replay.consume({ ...first, jti: 'jti-2' })).toBe(false);
		expect(() => replay.consume({
			...first,
			jti: 'jti-2',
			nonce: 'B'.repeat(32),
		})).toThrow('dispatch_assertion_replay_store_full');
		expect(replay.consume({
			...first,
			jti: 'jti-2',
			nonce: 'B'.repeat(32),
			now: 110,
			expiresAt: 120,
		})).toBe(true);
	});

	it('allows only the three frozen unsigned discovery bodies when explicitly enabled', () => {
		const security: RuntimeDispatchSecurityV3 = {
			...runtimeV3Security(),
			unsignedReadiness: 'initialize-and-tools-list',
		};
		const initialize = {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-03-26',
				capabilities: {
					extensions: {
						'io.modelcontextprotocol/ui': {
							mimeTypes: ['text/html;profile=mcp-app'],
						},
					},
				},
				clientInfo: { name: 'privos-hub', version: '1.0.0' },
			},
		};
		const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
		const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
		expect(isUnsignedRuntimeReadinessRpcV3(initialize, security)).toBe(true);
		expect(sha256RuntimeDispatchBodyV3(initialize)).toBe('5OnyDva0GJB4oavqcHxFFmmAipO2kbMJOitaXImVixM');
		expect(isUnsignedRuntimeReadinessRpcV3(initialized, security)).toBe(true);
		expect(isUnsignedRuntimeReadinessRpcV3(toolsList, security)).toBe(true);
		expect(isUnsignedRuntimeReadinessRpcV3(initialize, runtimeV3Security())).toBe(false);

		const denied = [
			{ ...initialize, id: 2 },
			{ ...initialize, result: {} },
			{ ...initialize, params: { ...initialize.params, _meta: {} } },
			{ ...initialize, params: { ...initialize.params, clientInfo: { name: 'other', version: '1.0.0' } } },
			{ ...initialized, id: 1 },
			{ ...initialized, params: {} },
			{ ...toolsList, id: 1 },
			{ ...toolsList, params: { _meta: {} } },
			{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
			{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} },
			{ jsonrpc: '2.0', id: 3, method: 'resources/read', params: {} },
			{ jsonrpc: '2.0', id: 3, method: 'custom/readiness', params: {} },
		];
		for (const body of denied) expect(isUnsignedRuntimeReadinessRpcV3(body, security)).toBe(false);
	});
});
