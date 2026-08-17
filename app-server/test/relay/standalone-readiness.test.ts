import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sha256CanonicalJson } from '../../src/manifest-tools.js';
import { checkManifestDigestDrift, createStandaloneReadinessCheck } from '../../src/relay/standalone-readiness.js';
import { saveStandaloneIdentity, standaloneHubFingerprint, type StandaloneIdentityV2 } from '../../src/relay/standalone-identity.js';
import type { RuntimeDispatchTrustV3 } from '../../src/workload/dispatch-assertion.js';

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

function validManifest(): Record<string, unknown> {
	return {
		schemaVersion: 2,
		kind: 'mcp-app',
		name: 'demo-app',
		version: '1.0.0',
		title: 'Demo App',
		description: 'A demo app.',
		permissions: [
			{
				scope: 'tools:call',
				requirement: 'required',
				context: 'workspace',
				executionContext: 'both',
				feature: 'demo.tool',
				reason: 'Needed to call the demo tool.',
			},
		],
	};
}

function trustFixture(manifestDigest: string): RuntimeDispatchTrustV3 {
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const publicJwk = pair.publicKey.export({ format: 'jwk' }) as { crv: string; kty: string; x: string; y: string };
	const hubPublicJwk = { crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y };
	const hubKid = crypto.createHash('sha256').update(canonical(hubPublicJwk), 'utf8').digest('base64url');
	return {
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
			manifestDigest,
			resourceManifestHash: 'B'.repeat(43),
			runtimeResourceInventoryHash: 'C'.repeat(43),
			runtimeApprovalReceiptHash: 'D'.repeat(43),
			runtimeAuthorizationEpoch: 1,
		},
	};
}

describe('checkManifestDigestDrift', () => {
	it('reports no drift when the local manifest matches the pinned digest', () => {
		const manifest = validManifest();
		const result = checkManifestDigestDrift(manifest, sha256CanonicalJson(manifest));
		expect(result.drift).toBe(false);
		expect(result.lintValid).toBe(true);
	});

	it('reports drift when the local manifest changed since pairing', () => {
		const manifest = validManifest();
		const staleDigest = sha256CanonicalJson({ ...manifest, version: '0.9.0' });
		const result = checkManifestDigestDrift(manifest, staleDigest);
		expect(result.drift).toBe(true);
	});

	it('reports lint failure for a structurally invalid manifest', () => {
		const result = checkManifestDigestDrift({ kind: 'mcp-app' }, `sha256:${'0'.repeat(64)}`);
		expect(result.lintValid).toBe(false);
		expect(result.lintErrors.length).toBeGreaterThan(0);
	});
});

describe('createStandaloneReadinessCheck', () => {
	let tempDirectory: string;
	let filePath: string;

	beforeEach(async () => {
		tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-readiness-'));
		filePath = path.join(tempDirectory, 'identity.json');
	});

	afterEach(async () => {
		await fs.rm(tempDirectory, { recursive: true, force: true });
	});

	it('is ready when identity is loaded, relay is authenticated, and the manifest matches the pinned digest', async () => {
		const manifest = validManifest();
		const trust = trustFixture(sha256CanonicalJson(manifest));
		const identity: StandaloneIdentityV2 = {
			pairingVersion: 2,
			relayUrl: 'https://hub.example',
			clientId: 'client-1',
			clientSecret: 'secret-1',
			trust,
			fingerprint: standaloneHubFingerprint(trust.hubKid),
			pairedAt: Date.now(),
		};
		await saveStandaloneIdentity(identity, { filePath });

		const check = createStandaloneReadinessCheck({
			filePath,
			isRelayAuthenticated: () => true,
			resolveManifest: () => manifest,
		});
		const result = await check();
		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ ok: true, status: 'ready', mode: 'standalone-production' });
	});

	it('reports IDENTITY_NOT_LOADED when the identity file is missing', async () => {
		const check = createStandaloneReadinessCheck({
			filePath,
			isRelayAuthenticated: () => true,
			resolveManifest: () => validManifest(),
		});
		const result = await check();
		expect(result.ok).toBe(false);
		expect(result.status).toBe(503);
		expect(result.body.reason).toBe('IDENTITY_NOT_LOADED');
	});

	it('reports RELAY_NOT_AUTHENTICATED when the relay connection is down', async () => {
		const manifest = validManifest();
		const trust = trustFixture(sha256CanonicalJson(manifest));
		await saveStandaloneIdentity(
			{
				pairingVersion: 2,
				relayUrl: 'https://hub.example',
				clientId: 'client-1',
				clientSecret: 'secret-1',
				trust,
				fingerprint: standaloneHubFingerprint(trust.hubKid),
				pairedAt: Date.now(),
			},
			{ filePath },
		);
		const check = createStandaloneReadinessCheck({
			filePath,
			isRelayAuthenticated: () => false,
			resolveManifest: () => manifest,
		});
		const result = await check();
		expect(result.body.reason).toBe('RELAY_NOT_AUTHENTICATED');
	});

	it('reports MANIFEST_DRIFT when the local manifest no longer matches the digest pinned at pairing', async () => {
		const manifest = validManifest();
		const trust = trustFixture(sha256CanonicalJson({ ...manifest, version: '0.9.0' }));
		await saveStandaloneIdentity(
			{
				pairingVersion: 2,
				relayUrl: 'https://hub.example',
				clientId: 'client-1',
				clientSecret: 'secret-1',
				trust,
				fingerprint: standaloneHubFingerprint(trust.hubKid),
				pairedAt: Date.now(),
			},
			{ filePath },
		);
		const check = createStandaloneReadinessCheck({
			filePath,
			isRelayAuthenticated: () => true,
			resolveManifest: () => manifest,
		});
		const result = await check();
		expect(result.body.reason).toBe('MANIFEST_DRIFT');
	});

	it('reports MANIFEST_LINT_INVALID when the local manifest is structurally invalid', async () => {
		const manifest = validManifest();
		const trust = trustFixture(sha256CanonicalJson(manifest));
		await saveStandaloneIdentity(
			{
				pairingVersion: 2,
				relayUrl: 'https://hub.example',
				clientId: 'client-1',
				clientSecret: 'secret-1',
				trust,
				fingerprint: standaloneHubFingerprint(trust.hubKid),
				pairedAt: Date.now(),
			},
			{ filePath },
		);
		const check = createStandaloneReadinessCheck({
			filePath,
			isRelayAuthenticated: () => true,
			resolveManifest: () => ({ kind: 'mcp-app' }),
		});
		const result = await check();
		expect(result.body.reason).toBe('MANIFEST_LINT_INVALID');
	});
});
