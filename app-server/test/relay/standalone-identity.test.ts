import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	loadStandaloneIdentity,
	rotateStandaloneIdentity,
	saveStandaloneIdentity,
	standaloneHubFingerprint,
	standaloneIdentityFileExists,
	StandaloneIdentityError,
	type StandaloneIdentityV2,
} from '../../src/relay/standalone-identity.js';
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

function trustFixture(overrides: Partial<RuntimeDispatchTrustV3['affinity']> = {}): RuntimeDispatchTrustV3 {
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
			manifestDigest: `sha256:${'a'.repeat(64)}`,
			resourceManifestHash: 'B'.repeat(43),
			runtimeResourceInventoryHash: 'C'.repeat(43),
			runtimeApprovalReceiptHash: 'D'.repeat(43),
			runtimeAuthorizationEpoch: 1,
			...overrides,
		},
	};
}

function identityFixture(trust = trustFixture()): StandaloneIdentityV2 {
	return {
		pairingVersion: 2,
		relayUrl: 'https://hub.example',
		clientId: 'client-1',
		clientSecret: 'secret-1',
		trust,
		fingerprint: standaloneHubFingerprint(trust.hubKid),
		mcpAppId: 'mcp-app-1',
		pairedAt: Date.now(),
	};
}

let tempDirectory: string;
let filePath: string;

beforeEach(async () => {
	tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-identity-'));
	filePath = path.join(tempDirectory, 'privos-standalone-identity.json');
});

afterEach(async () => {
	await fs.rm(tempDirectory, { recursive: true, force: true });
});

describe('saveStandaloneIdentity / loadStandaloneIdentity', () => {
	it('round-trips a valid identity at mode 0600', async () => {
		const identity = identityFixture();
		const written = await saveStandaloneIdentity(identity, { filePath });
		expect(written).toBe(filePath);
		const stat = await fs.stat(filePath);
		expect((stat.mode & 0o777).toString(8)).toBe('600');

		const loaded = loadStandaloneIdentity({ filePath });
		expect(loaded.relay).toEqual({ privosUrl: identity.relayUrl, clientId: identity.clientId, clientSecret: identity.clientSecret });
		expect(loaded.trust).toEqual(identity.trust);
		expect(loaded.fingerprint).toBe(identity.fingerprint);
		expect(standaloneIdentityFileExists({ filePath })).toBe(true);
	});

	it('refuses to overwrite an existing identity file (wx create-only)', async () => {
		await saveStandaloneIdentity(identityFixture(), { filePath });
		await expect(saveStandaloneIdentity(identityFixture(), { filePath })).rejects.toMatchObject({
			code: 'IDENTITY_FILE_ALREADY_EXISTS',
		});
	});

	it('refuses a missing file with an actionable reason', () => {
		expect(standaloneIdentityFileExists({ filePath })).toBe(false);
		expect(() => loadStandaloneIdentity({ filePath })).toThrowError(StandaloneIdentityError);
		try {
			loadStandaloneIdentity({ filePath });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(StandaloneIdentityError);
			expect((error as StandaloneIdentityError).code).toBe('IDENTITY_FILE_MISSING');
		}
	});

	it('refuses a world-readable identity file (tampered mode)', async () => {
		await saveStandaloneIdentity(identityFixture(), { filePath });
		await fs.chmod(filePath, 0o644);
		try {
			loadStandaloneIdentity({ filePath });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(StandaloneIdentityError);
			expect((error as StandaloneIdentityError).code).toBe('IDENTITY_FILE_MODE_INVALID');
		}
	});

	it('refuses unparseable content even at the correct mode', async () => {
		await fs.writeFile(filePath, 'not json', { mode: 0o600 });
		try {
			loadStandaloneIdentity({ filePath });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(StandaloneIdentityError);
			expect((error as StandaloneIdentityError).code).toBe('IDENTITY_FILE_UNPARSEABLE');
		}
	});

	it('refuses a structurally invalid identity (missing required field)', async () => {
		const identity = identityFixture();
		const { clientSecret: _clientSecret, ...withoutSecret } = identity;
		await fs.writeFile(filePath, JSON.stringify(withoutSecret), { mode: 0o600 });
		try {
			loadStandaloneIdentity({ filePath });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(StandaloneIdentityError);
			expect((error as StandaloneIdentityError).code).toBe('IDENTITY_FILE_INVALID');
		}
	});

	it('refuses a fingerprint that does not match the pinned hub key', async () => {
		const identity = { ...identityFixture(), fingerprint: 'SHA256:wrong' };
		await fs.writeFile(filePath, JSON.stringify(identity), { mode: 0o600 });
		try {
			loadStandaloneIdentity({ filePath });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(StandaloneIdentityError);
			expect((error as StandaloneIdentityError).code).toBe('IDENTITY_FILE_INVALID');
		}
	});

	it('refuses a trust object with extra JWK members', async () => {
		const trust = trustFixture();
		const identity = identityFixture(trust);
		const tampered = {
			...identity,
			trust: { ...trust, hubPublicJwk: { ...trust.hubPublicJwk, alg: 'ES256' } },
		};
		await fs.writeFile(filePath, JSON.stringify(tampered), { mode: 0o600 });
		expect(() => loadStandaloneIdentity({ filePath })).toThrowError(StandaloneIdentityError);
	});
});

describe('rotateStandaloneIdentity', () => {
	it('atomically rewrites the file and preserves mode 0600', async () => {
		await saveStandaloneIdentity(identityFixture(), { filePath });
		const rotated = await rotateStandaloneIdentity(
			(current) => ({ ...current, clientSecret: 'rotated-secret', rotatedAt: 123 }),
			{ filePath },
		);
		expect(rotated.relay.clientSecret).toBe('rotated-secret');
		expect(rotated.identity.rotatedAt).toBe(123);
		const stat = await fs.stat(filePath);
		expect((stat.mode & 0o777).toString(8)).toBe('600');
		// No leftover temp files.
		const entries = await fs.readdir(tempDirectory);
		expect(entries).toEqual(['privos-standalone-identity.json']);
	});

	it('re-validates the mutated identity before writing', async () => {
		await saveStandaloneIdentity(identityFixture(), { filePath });
		await expect(
			rotateStandaloneIdentity((current) => ({ ...current, clientSecret: '' }), { filePath }),
		).rejects.toBeInstanceOf(StandaloneIdentityError);
		// Original content must be untouched after a rejected rotation.
		const loaded = loadStandaloneIdentity({ filePath });
		expect(loaded.relay.clientSecret).toBe('secret-1');
	});
});
