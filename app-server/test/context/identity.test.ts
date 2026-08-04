import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import {
	assertActorAvailable,
	assertActorMatchesLegacyId,
	IdentityAssertionError,
} from '../../src/context/identity-assertions.js';
import type { ToolCallContext, VerifiedActor } from '../../src/context/tool-call-context.js';
import { AppServerRuntime } from '../../src/runtime.js';
import type { VerifiedRuntimeDispatchAssertionV3 } from '../../src/workload/dispatch-assertion.js';

const actor: VerifiedActor = {
	userId: 'u1',
	claims: { sub: 'u1' },
};

function ctx(partial: Partial<ToolCallContext>): ToolCallContext {
	return {
		transport: 'direct',
		identityState: 'missing',
		sessionScope: 'test',
		...partial,
	};
}

const runtimeAuthorizationBase = {
	protocolVersion: 3,
	type: 'hub-runtime-dispatch-assertion',
	iss: 'hub:deployment-1',
	aud: 'mcp-runtime:app.test',
	jti: 'dispatch-1',
	nonce: 'A'.repeat(32),
	iat: 2_000_000_000,
	exp: 2_000_000_030,
	workspaceId: 'workspace-1',
	deploymentId: 'deployment-1',
	mcpAppId: 'app.test',
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

function roomRuntimeAuthorization(): VerifiedRuntimeDispatchAssertionV3 {
	return Object.freeze({
		...runtimeAuthorizationBase,
		authorizationContext: 'room',
		roomId: 'room-1',
		authorizationBindingId: 'binding-1',
		bindingReceiptHash: 'F'.repeat(43),
		bindingGrantHash: 'G'.repeat(43),
		bindingEpoch: 1,
		bindingTokenVersion: 1,
	});
}

async function actorAuthHarness(roomId?: string) {
	const { privateKey, publicKey } = await generateKeyPair('RS256');
	const jwk = await exportJWK(publicKey);
	jwk.kid = 'actor-key';
	jwk.alg = 'RS256';
	jwk.use = 'sig';
	const token = await new SignJWT({ sub: 'user-1', ...(roomId ? { rid: roomId } : {}) })
		.setProtectedHeader({ alg: 'RS256', kid: 'actor-key' })
		.setIssuedAt()
		.setExpirationTime('5m')
		.setAudience('app.test')
		.sign(privateKey);
	const runtime = new AppServerRuntime({
		descriptor: { id: 'app.test', name: 'Test', version: '1.0.0' },
		handler: async () => ({}),
		auth: {
			jwksUrl: 'http://unused.invalid/jwks',
			audience: 'app.test',
			localJwks: { keys: [jwk] },
		},
	});
	return { runtime, token };
}

describe('identity assertions', () => {
	it('assertActorAvailable returns actor when verified', () => {
		expect(
			assertActorAvailable(ctx({ identityState: 'verified', actor }), 'enforce'),
		).toEqual(actor);
	});

	it('enforce rejects missing identity', () => {
		expect(() => assertActorAvailable(ctx({ identityState: 'missing' }), 'enforce')).toThrow(
			IdentityAssertionError,
		);
	});

	it('invalid never degrades to missing', () => {
		try {
			assertActorAvailable(ctx({ identityState: 'invalid' }), 'observe');
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(IdentityAssertionError);
			expect((err as IdentityAssertionError).code).toBe('IDENTITY_INVALID');
		}
	});

	it('assertActorMatchesLegacyId rejects mismatch in both modes (pure fn)', () => {
		expect(() => assertActorMatchesLegacyId(actor, 'other')).toThrow(/does not match/);
		expect(() => assertActorMatchesLegacyId(actor, 'u1')).not.toThrow();
		expect(() => assertActorMatchesLegacyId(actor, undefined)).not.toThrow();
	});

	it('helpers do not accept or inspect tool arguments objects', () => {
		// Compile-time / API shape check: only (actor, legacyId string).
		expect(assertActorMatchesLegacyId.length).toBe(2);
		expect(assertActorAvailable.length).toBe(2);
	});
});

describe('runtime authorization actor affinity', () => {
	it('keeps signed room authorization authoritative when actor room agrees', async () => {
		const { runtime, token } = await actorAuthHarness('room-1');
		const authorization = roomRuntimeAuthorization();
		const context = await runtime.buildContext({
			transport: 'relay',
			sessionScope: 'test',
			credentialResolution: {
				kind: 'present',
				credential: { token, source: 'relay-metadata' },
			},
			runtimeAuthorization: authorization,
		});
		expect(context).toMatchObject({
			identityState: 'verified',
			roomId: 'room-1',
			actor: { userId: 'user-1', roomId: 'room-1' },
			runtimeAuthorization: authorization,
		});
	});

	it('rejects a missing or different actor room for signed room work', async () => {
		for (const actorRoom of [undefined, 'room-2']) {
			const { runtime, token } = await actorAuthHarness(actorRoom);
			await expect(runtime.buildContext({
				transport: 'direct',
				sessionScope: 'test',
				credentialResolution: {
					kind: 'present',
					credential: { token, source: 'direct-header' },
				},
				runtimeAuthorization: roomRuntimeAuthorization(),
			})).rejects.toThrow('dispatch_assertion_binding_mismatch');
		}
	});

	it('rejects room-bound actor credentials on workspace authorization', async () => {
		const { runtime, token } = await actorAuthHarness('room-1');
		const workspaceAuthorization = Object.freeze({
			...runtimeAuthorizationBase,
			authorizationContext: 'workspace',
		}) as VerifiedRuntimeDispatchAssertionV3;
		await expect(runtime.buildContext({
			transport: 'direct',
			sessionScope: 'test',
			credentialResolution: {
				kind: 'present',
				credential: { token, source: 'direct-header' },
			},
			runtimeAuthorization: workspaceAuthorization,
		})).rejects.toThrow('dispatch_assertion_binding_mismatch');
	});
});
