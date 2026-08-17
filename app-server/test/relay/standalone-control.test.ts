import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	createStandaloneRelayIdentityController,
	STANDALONE_CAPABILITIES_CHANGED_METHOD,
	STANDALONE_SECRET_ROTATE_METHOD,
	STANDALONE_TRUST_ROTATE_METHOD,
} from '../../src/relay/standalone-control.js';
import {
	loadStandaloneIdentity,
	saveStandaloneIdentity,
	standaloneHubFingerprint,
	type StandaloneIdentityV2,
} from '../../src/relay/standalone-identity.js';
import type { RuntimeDispatchTrustV3 } from '../../src/workload/dispatch-assertion.js';

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

function keyPairAndTrust(overrides: Partial<RuntimeDispatchTrustV3['affinity']> = {}) {
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
	exp?: number;
	jti?: string;
	nonce?: string;
}): string {
	const header = { alg: 'ES256', kid: input.kid, privos_protocol: 3, typ: 'privos-hub-standalone-control+jws' };
	const payload = {
		protocolVersion: 3,
		type: input.type,
		iss: `hub:${input.deploymentId}`,
		aud: `mcp-runtime:${input.mcpAppId}`,
		jti: input.jti ?? crypto.randomUUID(),
		nonce: input.nonce ?? crypto.randomBytes(24).toString('base64url'),
		iat: input.now,
		exp: input.exp ?? input.now + 30,
		data: input.data,
	};
	const encodedHeader = Buffer.from(canonical(header)).toString('base64url');
	const encodedPayload = Buffer.from(canonical(payload)).toString('base64url');
	const signature = crypto
		.sign('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'), { key: input.privateKey, dsaEncoding: 'ieee-p1363' })
		.toString('base64url');
	return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function identityFixture(trust: RuntimeDispatchTrustV3): StandaloneIdentityV2 {
	return {
		pairingVersion: 2,
		relayUrl: 'https://hub.example',
		clientId: 'client-1',
		clientSecret: 'secret-1',
		trust,
		fingerprint: standaloneHubFingerprint(trust.hubKid),
		mcpAppId: trust.affinity.mcpAppId,
		pairedAt: Date.now(),
	};
}

let tempDirectory: string;
let filePath: string;

beforeEach(async () => {
	tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-control-'));
	filePath = path.join(tempDirectory, 'identity.json');
});

afterEach(async () => {
	await fs.rm(tempDirectory, { recursive: true, force: true });
});

describe('secret rotation', () => {
	it('applies a valid signed secret-rotate, persisting atomically and updating live credentials', async () => {
		const { privateKey, trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const loaded = loadStandaloneIdentity({ filePath });
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loaded, { now: () => now });

		const assertion = signControlAssertion({
			privateKey,
			kid: trust.hubKid,
			type: 'standalone-secret-rotate',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: { clientId: 'client-2', clientSecret: 'secret-2' },
			now,
		});

		const outcome = await controller.handleControlNotification(STANDALONE_SECRET_ROTATE_METHOD, { assertion });
		expect(outcome).toBe('handled');
		expect(controller.getCredentials()).toMatchObject({ clientId: 'client-2', clientSecret: 'secret-2' });

		const persisted = loadStandaloneIdentity({ filePath });
		expect(persisted.relay).toEqual({ privosUrl: 'https://hub.example', clientId: 'client-2', clientSecret: 'secret-2' });
	});

	it('rejects a secret-rotate signed by a key that is not the currently pinned kid (cold-app refusal)', async () => {
		const { trust } = keyPairAndTrust();
		const foreign = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const loaded = loadStandaloneIdentity({ filePath });
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loaded, { now: () => now });

		const assertion = signControlAssertion({
			privateKey: foreign.privateKey,
			kid: foreign.trust.hubKid,
			type: 'standalone-secret-rotate',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: { clientId: 'client-2', clientSecret: 'secret-2' },
			now,
		});

		await expect(controller.handleControlNotification(STANDALONE_SECRET_ROTATE_METHOD, { assertion })).rejects.toThrow();
		expect(controller.getCredentials()).toMatchObject({ clientId: 'client-1', clientSecret: 'secret-1' });
	});

	it('rejects a replayed secret-rotate assertion', async () => {
		const { privateKey, trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const loaded = loadStandaloneIdentity({ filePath });
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loaded, { now: () => now });
		const jti = 'jti-replay';
		const nonce = 'nonce-replay';
		const assertion = signControlAssertion({
			privateKey,
			kid: trust.hubKid,
			type: 'standalone-secret-rotate',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: { clientId: 'client-2', clientSecret: 'secret-2' },
			now,
			jti,
			nonce,
		});
		await controller.handleControlNotification(STANDALONE_SECRET_ROTATE_METHOD, { assertion });
		await expect(controller.handleControlNotification(STANDALONE_SECRET_ROTATE_METHOD, { assertion })).rejects.toThrow();
	});

	it('rejects an expired secret-rotate assertion', async () => {
		const { privateKey, trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const loaded = loadStandaloneIdentity({ filePath });
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loaded, { now: () => now });
		const assertion = signControlAssertion({
			privateKey,
			kid: trust.hubKid,
			type: 'standalone-secret-rotate',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: { clientId: 'client-2', clientSecret: 'secret-2' },
			now: now - 60,
			exp: now - 30,
		});
		await expect(controller.handleControlNotification(STANDALONE_SECRET_ROTATE_METHOD, { assertion })).rejects.toThrow();
	});
});

describe('trust rotation', () => {
	it('applies a re-key trust-rotate, updating live trust, fingerprint, and the persisted file', async () => {
		const { privateKey, trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const loaded = loadStandaloneIdentity({ filePath });
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loaded, { now: () => now });

		const rekeyed = keyPairAndTrust({
			generationId: 'generation-2',
			generationNumber: 2,
			manifestDigest: `sha256:${'b'.repeat(64)}`,
		});
		const assertion = signControlAssertion({
			privateKey,
			kid: trust.hubKid, // signed by the OLD (currently trusted) key
			type: 'standalone-trust-rotate',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: { trust: rekeyed.trust },
			now,
		});

		const outcome = await controller.handleControlNotification(STANDALONE_TRUST_ROTATE_METHOD, { assertion });
		expect(outcome).toBe('handled');
		expect(controller.getTrust()).toEqual(rekeyed.trust);

		const persisted = loadStandaloneIdentity({ filePath });
		expect(persisted.trust).toEqual(rekeyed.trust);
		expect(persisted.fingerprint).toBe(standaloneHubFingerprint(rekeyed.trust.hubKid));
	});

	it('refuses a trust-rotate that would change the installation identity', async () => {
		const { privateKey, trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const loaded = loadStandaloneIdentity({ filePath });
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loaded, { now: () => now });

		const wrongInstallation = keyPairAndTrust({ runtimeInstallationId: 'installation-2' });
		const assertion = signControlAssertion({
			privateKey,
			kid: trust.hubKid,
			type: 'standalone-trust-rotate',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: { trust: wrongInstallation.trust },
			now,
		});

		await expect(controller.handleControlNotification(STANDALONE_TRUST_ROTATE_METHOD, { assertion })).rejects.toThrow();
		expect(controller.getTrust()).toEqual(trust);
	});

	it('a cold app (never applied the rotation) refuses dispatch/control signed by the new kid', async () => {
		const { trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const loaded = loadStandaloneIdentity({ filePath });
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loaded, { now: () => now });

		const rekeyed = keyPairAndTrust();
		const assertionFromNewKey = signControlAssertion({
			privateKey: rekeyed.privateKey,
			kid: rekeyed.trust.hubKid, // the app never accepted this kid
			type: 'standalone-secret-rotate',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: { clientId: 'client-2', clientSecret: 'secret-2' },
			now,
		});
		await expect(
			controller.handleControlNotification(STANDALONE_SECRET_ROTATE_METHOD, { assertion: assertionFromNewKey }),
		).rejects.toThrow();
		expect(controller.getTrust()).toEqual(trust);
	});
});

describe('capabilities push', () => {
	it('applies a signed capabilities-changed and notifies listeners', async () => {
		const { privateKey, trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const loaded = loadStandaloneIdentity({ filePath });
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loaded, { now: () => now });
		const seen: unknown[] = [];
		controller.onCapabilitiesChanged((capabilities) => seen.push(capabilities));

		const assertion = signControlAssertion({
			privateKey,
			kid: trust.hubKid,
			type: 'standalone-capabilities-changed',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: { scopes: ['tools:call', 'resources:read'], grantEpoch: 2 },
			now,
		});
		await controller.handleControlNotification(STANDALONE_CAPABILITIES_CHANGED_METHOD, { assertion });

		expect(controller.peekEffectiveCapabilities()).toMatchObject({
			scopes: ['resources:read', 'tools:call'],
			grantEpoch: 2,
		});
		expect(seen).toHaveLength(1);
	});

	it('never regresses to a stale (lower) grant epoch', async () => {
		const { privateKey, trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const loaded = loadStandaloneIdentity({ filePath });
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loaded, { now: () => now });

		const bump = (grantEpoch: number, jti: string) =>
			controller.handleControlNotification(STANDALONE_CAPABILITIES_CHANGED_METHOD, {
				assertion: signControlAssertion({
					privateKey,
					kid: trust.hubKid,
					type: 'standalone-capabilities-changed',
					deploymentId: trust.affinity.deploymentId,
					mcpAppId: trust.affinity.mcpAppId,
					data: { scopes: ['tools:call'], grantEpoch },
					now,
					jti,
				}),
			});

		await bump(3, 'jti-1');
		await bump(1, 'jti-2');
		expect(controller.peekEffectiveCapabilities().grantEpoch).toBe(3);
	});
});

describe('unrelated methods', () => {
	it('ignores a non-control method', async () => {
		const { trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const loaded = loadStandaloneIdentity({ filePath });
		const controller = createStandaloneRelayIdentityController(loaded);
		await expect(controller.handleControlNotification('tools/call', {})).resolves.toBe('ignored');
	});
});
