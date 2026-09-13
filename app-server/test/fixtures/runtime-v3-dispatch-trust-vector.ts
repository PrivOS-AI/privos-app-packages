/**
 * Real output of the cluster's `dispatchTrustEnv` (privos-cluster,
 * `src/local-runtime/runtime-service.ts`), captured once by building a real
 * ENSURE_READY / ACTIVATE request pair — ajv-validated through the cluster's
 * own `abi-schema.ts` — and calling the real (un-exported) function through a
 * throwaway same-directory copy that only added the `export` keyword; the
 * function itself was never reimplemented. `RUNTIME_V3_PREACTIVATION_TRUST` is
 * the trust `dispatchTrustEnv` emits before ACTIVATE (`activation: null`);
 * `RUNTIME_V3_ACTIVE_TRUST` is the same call with a matching ACTIVATE request.
 *
 * The paired EC private key is a fixture-only test signing key generated
 * alongside the trust vector in that same throwaway run — never a production
 * Hub key — so tests can mint a JWS this exact `hubKid`/`hubPublicJwk` pair
 * verifies, the same way the Hub signs `hub-runtime-dispatch-assertion`.
 */
import crypto, { type JsonWebKey } from 'node:crypto';

import { sha256RuntimeDispatchBodyV3, type RuntimeDispatchTrustV3 } from '../../src/workload/dispatch-assertion.js';

export const RUNTIME_V3_HUB_PRIVATE_JWK: JsonWebKey = Object.freeze({
	kty: 'EC',
	crv: 'P-256',
	x: 'ZPiYobFxz8tXC_1H-KIVZcu_zP4W52vhfjdIKI003lw',
	y: 'zIB4PbU69ZbzBZzBM3E5lTFU30MB-eILxY203DmLriY',
	d: 'uR4bl9X_-YHKwvsRnQKXiWK5wcz1RB5LwH9-HCYpVCs',
});

const RUNTIME_V3_HUB_PUBLIC_JWK = Object.freeze({
	crv: 'P-256',
	kty: 'EC',
	x: 'ZPiYobFxz8tXC_1H-KIVZcu_zP4W52vhfjdIKI003lw',
	y: 'zIB4PbU69ZbzBZzBM3E5lTFU30MB-eILxY203DmLriY',
});

export const RUNTIME_V3_PREACTIVATION_TRUST: RuntimeDispatchTrustV3 = Object.freeze({
	hubKid: 'iCf-GJjnzCyK8t5Jvau2tme3r_wGgsrjC4EWAH99DqA',
	hubPublicJwk: RUNTIME_V3_HUB_PUBLIC_JWK,
	affinity: Object.freeze({
		deploymentId: 'deployment-fixture-0001',
		executionMode: 'SELF_HOSTED_LOCAL' as const,
		generationId: 'generation-fixture-0001',
		generationNumber: 1,
		manifestDigest: 'sha256:05b3abf2579a5eb66403cd78be557fd860633a1fe2103c7642030defe32c657f',
		mcpAppId: 'demo-mcp-app',
		resourceManifestHash: 'Z_Rh5zBST9IyE5PPqxfPfX_9pPQTwEVwDvkSZJw31lY',
		runtimeInstallationId: 'installation-fixture-0001',
		workspaceId: 'workspace-fixture-0001',
	}),
});

export const RUNTIME_V3_ACTIVE_TRUST: RuntimeDispatchTrustV3 = Object.freeze({
	hubKid: RUNTIME_V3_PREACTIVATION_TRUST.hubKid,
	hubPublicJwk: RUNTIME_V3_HUB_PUBLIC_JWK,
	affinity: Object.freeze({
		...RUNTIME_V3_PREACTIVATION_TRUST.affinity,
		runtimeApprovalReceiptHash: 'PbDbTKMhKkKxQvoStVuZRxWVevep_ACfYYjin2XDU20',
		runtimeAuthorizationEpoch: 1,
		runtimeResourceInventoryHash: '3NH8pBTy88OOsHZlaUO6o8g9bjbhPtvl7-zoj9KyFNk',
	}),
});

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

/** Mints a runtime-v3 dispatch assertion the fixture's trust verifies — exactly the shape the Hub signs. */
export function signRuntimeV3DispatchAssertion(input: {
	trust: RuntimeDispatchTrustV3;
	body: unknown;
	now: number;
}): string {
	const payload = {
		protocolVersion: 3,
		type: 'hub-runtime-dispatch-assertion',
		iss: `hub:${input.trust.affinity.deploymentId}`,
		aud: `mcp-runtime:${input.trust.affinity.mcpAppId}`,
		jti: crypto.randomUUID(),
		nonce: crypto.randomBytes(24).toString('base64url'),
		iat: input.now,
		exp: input.now + 30,
		...input.trust.affinity,
		authorizationContext: 'workspace' as const,
		htm: 'POST' as const,
		htu: '/mcp' as const,
		bodyDigest: sha256RuntimeDispatchBodyV3(input.body),
	};
	const encodedHeader = Buffer.from(
		canonical({ alg: 'ES256', kid: input.trust.hubKid, privos_protocol: 3, typ: 'privos-hub-runtime-dispatch+jws' }),
	).toString('base64url');
	const encodedPayload = Buffer.from(canonical(payload)).toString('base64url');
	const signature = crypto
		.sign('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'), {
			key: crypto.createPrivateKey({ key: RUNTIME_V3_HUB_PRIVATE_JWK, format: 'jwk' }),
			dsaEncoding: 'ieee-p1363',
		})
		.toString('base64url');
	return `${encodedHeader}.${encodedPayload}.${signature}`;
}
