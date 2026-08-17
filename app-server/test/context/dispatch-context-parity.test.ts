/**
 * Proves that cluster-routed, Direct HTTP, and Relay dispatch all normalize
 * onto the same `ToolCallContext.runtimeAuthorization` surface (workspaceId,
 * mcpAppId, authorizationContext, roomId) so application handler code never
 * has to branch on transport. Each transport signs its own assertion format
 * (cluster: `verifyClusterDispatchAssertionV3`; Direct/Relay:
 * `verifyRuntimeDispatchAssertionV3`) — the fixtures describe the SAME
 * workspace/app/room affinity so field-by-field equality is meaningful.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { AppServerRuntime } from '../../src/runtime.js';
import {
	sha256RuntimeDispatchBodyV3,
	verifyClusterDispatchAssertionV3,
	verifyRuntimeDispatchAssertionV3,
	type RuntimeDispatchSecurityV3,
	type RuntimeDispatchTrustV3,
} from '../../src/workload/dispatch-assertion.js';
import type { WorkloadBrokerContext } from '../../src/workload/workload-identity.js';

const NOW = 2_200_000_000;
const WORKSPACE_ID = 'workspace-parity';
const DEPLOYMENT_ID = 'deployment-parity';
const MCP_APP_ID = 'mcp-app-parity';
const GENERATION_ID = 'generation-parity';
const RUNTIME_INSTALLATION_ID = 'installation-parity';
const MANIFEST_DIGEST = `sha256:${'a'.repeat(64)}`;
const RESOURCE_MANIFEST_HASH = 'B'.repeat(43);
const RUNTIME_RESOURCE_INVENTORY_HASH = 'C'.repeat(43);
const RUNTIME_APPROVAL_RECEIPT_HASH = 'D'.repeat(43);
const ROOM_ID = 'room-parity';
const AUTHORIZATION_BINDING_ID = 'binding-parity';
const BODY = { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'demo.tool' } };

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

function signCompact(header: Record<string, unknown>, payload: Record<string, unknown>, privateKey: crypto.KeyObject): string {
	const encodedHeader = Buffer.from(canonical(header)).toString('base64url');
	const encodedPayload = Buffer.from(canonical(payload)).toString('base64url');
	const signature = crypto
		.sign('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'), { key: privateKey, dsaEncoding: 'ieee-p1363' })
		.toString('base64url');
	return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function directRelayTrust(): { privateKey: crypto.KeyObject; trust: RuntimeDispatchTrustV3 } {
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
				workspaceId: WORKSPACE_ID,
				deploymentId: DEPLOYMENT_ID,
				mcpAppId: MCP_APP_ID,
				executionMode: 'PUBLISHER_HOSTED',
				generationId: GENERATION_ID,
				generationNumber: 1,
				runtimeInstallationId: RUNTIME_INSTALLATION_ID,
				manifestDigest: MANIFEST_DIGEST,
				resourceManifestHash: RESOURCE_MANIFEST_HASH,
				runtimeResourceInventoryHash: RUNTIME_RESOURCE_INVENTORY_HASH,
				runtimeApprovalReceiptHash: RUNTIME_APPROVAL_RECEIPT_HASH,
				runtimeAuthorizationEpoch: 1,
			},
		},
	};
}

function directOrRelayRoomAssertion(): { compact: string; security: RuntimeDispatchSecurityV3 } {
	const { privateKey, trust } = directRelayTrust();
	const payload = {
		protocolVersion: 3,
		type: 'hub-runtime-dispatch-assertion',
		iss: `hub:${DEPLOYMENT_ID}`,
		aud: `mcp-runtime:${MCP_APP_ID}`,
		jti: crypto.randomUUID(),
		nonce: crypto.randomBytes(24).toString('base64url'),
		iat: NOW,
		exp: NOW + 30,
		...trust.affinity,
		authorizationContext: 'room',
		roomId: ROOM_ID,
		authorizationBindingId: AUTHORIZATION_BINDING_ID,
		bindingReceiptHash: 'E'.repeat(43),
		bindingGrantHash: 'F'.repeat(43),
		bindingEpoch: 1,
		bindingTokenVersion: 1,
		htm: 'POST',
		htu: '/mcp',
		bodyDigest: sha256RuntimeDispatchBodyV3(BODY),
	};
	const header = { alg: 'ES256', kid: trust.hubKid, privos_protocol: 3, typ: 'privos-hub-runtime-dispatch+jws' };
	const compact = signCompact(header, payload, privateKey);
	return {
		compact,
		security: { mode: 'required', trust, now: () => NOW },
	};
}

function clusterRoomAssertion(): { compact: string; context: WorkloadBrokerContext } {
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const publicJwk = pair.publicKey.export({ format: 'jwk' }) as { crv: string; kty: string; x: string; y: string };
	const hubKid = crypto.createHash('sha256').update(canonical(publicJwk), 'utf8').digest('base64url');
	const generation = {
		clusterId: 'cluster-parity',
		deploymentId: DEPLOYMENT_ID,
		generationId: GENERATION_ID,
		generationNumber: 1,
		manifestDigest: MANIFEST_DIGEST,
		resourceManifestHash: RESOURCE_MANIFEST_HASH,
		runtimeResourceInventoryHash: RUNTIME_RESOURCE_INVENTORY_HASH,
	};
	const context: WorkloadBrokerContext = {
		hubOrigin: 'https://hub.example',
		hubKid,
		hubPublicJwk: publicJwk,
		binding: {
			workspaceId: WORKSPACE_ID,
			installationId: RUNTIME_INSTALLATION_ID,
			mcpAppId: MCP_APP_ID,
			replicaId: 'replica-parity',
			receiptHash: RUNTIME_APPROVAL_RECEIPT_HASH,
			grantEpoch: 1,
			generation,
		},
	};
	const payload = {
		protocolVersion: 3,
		type: 'hub-dispatch-assertion',
		iss: `urn:privos:hub:${DEPLOYMENT_ID}`,
		aud: 'privos-mcp-app',
		jti: crypto.randomUUID(),
		nonce: 'G'.repeat(32),
		iat: NOW,
		exp: NOW + 30,
		clusterId: generation.clusterId,
		workspaceId: WORKSPACE_ID,
		deploymentId: DEPLOYMENT_ID,
		generationId: GENERATION_ID,
		generationNumber: 1,
		runtimeInstallationId: RUNTIME_INSTALLATION_ID,
		mcpAppId: MCP_APP_ID,
		clusterAppId: 'cluster-app-parity',
		htm: 'POST',
		htu: '/mcp',
		bodyDigest: sha256RuntimeDispatchBodyV3(BODY),
		manifestDigest: MANIFEST_DIGEST,
		resourceManifestHash: RESOURCE_MANIFEST_HASH,
		runtimeResourceInventoryHash: RUNTIME_RESOURCE_INVENTORY_HASH,
		runtimeApprovalReceiptHash: RUNTIME_APPROVAL_RECEIPT_HASH,
		runtimeGrantEpoch: 1,
		authorizationContext: 'room',
		roomId: ROOM_ID,
		authorizationBindingId: AUTHORIZATION_BINDING_ID,
		bindingReceiptHash: 'F'.repeat(43),
		bindingEpoch: 1,
	};
	const header = { alg: 'ES256', kid: hubKid, privos_protocol: 3, typ: 'privos-hub-dispatch+jws' };
	const compact = signCompact(header, payload, pair.privateKey);
	return { compact, context };
}

const runtime = new AppServerRuntime({
	descriptor: { id: MCP_APP_ID, name: 'Parity', version: '1.0.0' },
	handler: async () => ({ ok: true }),
});

describe('dispatch context parity across transports', () => {
	it('cluster, direct, and relay all normalize the same room dispatch onto ToolCallContext.runtimeAuthorization', async () => {
		// Direct and Relay reuse the SAME verified assertion — the point is that
		// `buildContext` normalizes it identically regardless of which transport
		// boundary it arrived through (`verifyRuntimeDispatchAssertionV3` itself
		// is transport-blind; only the caller differs).
		const { compact: directRelayCompact, security } = directOrRelayRoomAssertion();
		const directVerified = await verifyRuntimeDispatchAssertionV3({ compact: directRelayCompact, body: BODY, security });
		const relayVerified = directVerified;
		const { compact: clusterCompact, context: clusterContext } = clusterRoomAssertion();
		const clusterVerified = verifyClusterDispatchAssertionV3({ compact: clusterCompact, body: BODY, context: clusterContext, now: NOW });

		const directContext = await runtime.buildContext({
			transport: 'direct',
			sessionScope: 'direct-scope',
			runtimeAuthorization: directVerified,
		});
		const relayContext = await runtime.buildContext({
			transport: 'relay',
			sessionScope: 'relay-scope',
			runtimeAuthorization: relayVerified,
		});
		const clusterRoutedContext = await runtime.buildContext({
			transport: 'direct',
			sessionScope: 'cluster-scope',
			runtimeAuthorization: clusterVerified,
		});

		for (const context of [directContext, relayContext, clusterRoutedContext]) {
			expect(context.roomId).toBe(ROOM_ID);
			expect(context.appId).toBe(MCP_APP_ID);
			expect(context.runtimeAuthorization).toMatchObject({
				workspaceId: WORKSPACE_ID,
				mcpAppId: MCP_APP_ID,
				generationId: GENERATION_ID,
				runtimeInstallationId: RUNTIME_INSTALLATION_ID,
				manifestDigest: MANIFEST_DIGEST,
				authorizationContext: 'room',
				roomId: ROOM_ID,
				authorizationBindingId: AUTHORIZATION_BINDING_ID,
			});
			expect(Object.isFrozen(context.runtimeAuthorization)).toBe(true);
		}

		expect(directContext.transport).toBe('direct');
		expect(relayContext.transport).toBe('relay');
		expect(clusterRoutedContext.transport).toBe('direct');
	});
});
