import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	AGENT_BOT_CREDENTIAL_ENV_KEY,
	AGENT_BOT_USER_ID_ENV_KEY,
	getAgentBotCredentialState,
	readAgentBotCredential,
	resetAgentBotCredentialOutcomeForTests,
	setAdoptedAgentBotCredential,
} from '../../src/relay/agent-bot-credential.js';
import { createAgentBotHubClient } from '../../src/relay/hub-rest-as-bot-client.js';
import {
	createStandaloneRelayIdentityController,
	STANDALONE_AGENT_BOT_CREDENTIAL_METHOD,
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
const canonical = (value: unknown): string => JSON.stringify(canonicalize(value));
const tokenFingerprint = (token: string): string => crypto.createHash('sha256').update(token, 'utf8').digest('base64url');

function keyPairAndTrust() {
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
}): string {
	const header = { alg: 'ES256', kid: input.kid, privos_protocol: 3, typ: 'privos-hub-standalone-control+jws' };
	const payload = {
		protocolVersion: 3,
		type: input.type,
		iss: `hub:${input.deploymentId}`,
		aud: `mcp-runtime:${input.mcpAppId}`,
		jti: crypto.randomUUID(),
		nonce: crypto.randomBytes(24).toString('base64url'),
		iat: input.now,
		exp: input.now + 30,
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
	tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-bot-cred-'));
	filePath = path.join(tempDirectory, 'identity.json');
	delete process.env[AGENT_BOT_CREDENTIAL_ENV_KEY];
	delete process.env[AGENT_BOT_USER_ID_ENV_KEY];
	resetAgentBotCredentialOutcomeForTests();
});

afterEach(async () => {
	await fs.rm(tempDirectory, { recursive: true, force: true });
	resetAgentBotCredentialOutcomeForTests();
});

describe('agent-bot credential delivery over the standalone control channel', () => {
	it('persists a newer valid signed credential before returning its secret-free receipt and hot-adopting it', async () => {
		const { privateKey, trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const loaded = loadStandaloneIdentity({ filePath });
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loaded, { now: () => now });
		const token = 'test-credential-v1';

		// Before delivery: no credential is readable.
		expect(readAgentBotCredential()).toBeNull();
		expect(getAgentBotCredentialState()).toBe('absent');

		const assertion = signControlAssertion({
			privateKey,
			kid: trust.hubKid,
			type: 'standalone-agent-bot-credential',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: {
				botUserId: 'bot-user-99',
				token,
				runtimeInstallationId: trust.affinity.runtimeInstallationId,
				deliveryVersion: 1,
			},
			now,
		});

		const outcome = await controller.handleControlNotification(STANDALONE_AGENT_BOT_CREDENTIAL_METHOD, { assertion });
		expect(outcome).toEqual({
			mcpAppId: trust.affinity.mcpAppId,
			runtimeInstallationId: trust.affinity.runtimeInstallationId,
			deliveryVersion: 1,
		});
		expect(JSON.stringify(outcome)).not.toContain(token);

		// Hot: usable immediately, no restart.
		expect(readAgentBotCredential()?.botUserId).toBe('bot-user-99');
		expect(tokenFingerprint(readAgentBotCredential()!.token)).toBe(tokenFingerprint(token));
		expect(getAgentBotCredentialState()).toBe('live');

		// Durable: persisted into the identity file for the next boot.
		const persisted = loadStandaloneIdentity({ filePath });
		expect(persisted.identity.agentBotCredential?.botUserId).toBe('bot-user-99');
		expect(persisted.identity.agentBotCredential?.deliveryVersion).toBe(1);
		expect(tokenFingerprint(persisted.identity.agentBotCredential!.token)).toBe(tokenFingerprint(token));

		// Restart: boot seeding selects the durable credential for installation-bot
		// Hub calls before another control-channel delivery arrives.
		resetAgentBotCredentialOutcomeForTests();
		const restartedCredential = loadStandaloneIdentity({ filePath }).identity.agentBotCredential;
		expect(restartedCredential?.deliveryVersion).toBe(1);
		setAdoptedAgentBotCredential(restartedCredential!);
		const requests: Array<Record<string, string>> = [];
		const hubClient = createAgentBotHubClient({
			resolveHubOrigin: async () => 'https://hub.example',
			fetchImplementation: (async (_url: string, init?: RequestInit) => {
				requests.push((init?.headers as Record<string, string>) ?? {});
				return new Response('{}', { status: 200 });
			}) as typeof fetch,
		});
		await hubClient.authorizedFetch('/api/v1/me', { method: 'GET', requiredScope: 'files:read', retryMode: 'safe-methods' });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.['x-user-id']).toBe('bot-user-99');
		expect(tokenFingerprint(requests[0]?.['x-auth-token'] ?? '')).toBe(tokenFingerprint(token));
	});

	it('rejects a credential signed by a key that is not the pinned kid (cold-app refusal)', async () => {
		const { trust } = keyPairAndTrust();
		const foreign = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const loaded = loadStandaloneIdentity({ filePath });
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loaded, { now: () => now });

		const assertion = signControlAssertion({
			privateKey: foreign.privateKey,
			kid: foreign.trust.hubKid,
			type: 'standalone-agent-bot-credential',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: {
				botUserId: 'bot-user-99',
				token: 'test-foreign-credential',
				runtimeInstallationId: trust.affinity.runtimeInstallationId,
				deliveryVersion: 1,
			},
			now,
		});

		await expect(controller.handleControlNotification(STANDALONE_AGENT_BOT_CREDENTIAL_METHOD, { assertion })).rejects.toThrow();
		expect(readAgentBotCredential()).toBeNull();
		expect(loadStandaloneIdentity({ filePath }).identity.agentBotCredential).toBeUndefined();
	});

	it('rejects a credential with a malformed data payload', async () => {
		const { privateKey, trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const loaded = loadStandaloneIdentity({ filePath });
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loaded, { now: () => now });

		const assertion = signControlAssertion({
			privateKey,
			kid: trust.hubKid,
			type: 'standalone-agent-bot-credential',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: { botUserId: 'bot-user-99', token: 'test-malformed', runtimeInstallationId: trust.affinity.runtimeInstallationId },
			now,
		});

		await expect(controller.handleControlNotification(STANDALONE_AGENT_BOT_CREDENTIAL_METHOD, { assertion })).rejects.toThrow();
	});

	it('refuses a signed credential for a different runtime installation without adoption or a receipt', async () => {
		const { privateKey, trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const controller = createStandaloneRelayIdentityController(loadStandaloneIdentity({ filePath }), { now: () => 2_000_000_000 });
		const assertion = signControlAssertion({
			privateKey,
			kid: trust.hubKid,
			type: 'standalone-agent-bot-credential',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: { botUserId: 'bot-user-99', token: 'test-wrong-installation', runtimeInstallationId: 'installation-other', deliveryVersion: 1 },
			now: 2_000_000_000,
		});

		await expect(controller.handleControlNotification(STANDALONE_AGENT_BOT_CREDENTIAL_METHOD, { assertion })).rejects.toThrow();
		expect(readAgentBotCredential()).toBeNull();
		expect(loadStandaloneIdentity({ filePath }).identity.agentBotCredential).toBeUndefined();
	});

	it('keeps a newer persisted version when a stale or conflicting delivery arrives and acknowledges an exact duplicate idempotently', async () => {
		const { privateKey, trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loadStandaloneIdentity({ filePath }), { now: () => now });
		const deliver = (deliveryVersion: number, token: string) =>
			controller.handleControlNotification(STANDALONE_AGENT_BOT_CREDENTIAL_METHOD, {
				assertion: signControlAssertion({
					privateKey,
					kid: trust.hubKid,
					type: 'standalone-agent-bot-credential',
					deploymentId: trust.affinity.deploymentId,
					mcpAppId: trust.affinity.mcpAppId,
					data: { botUserId: 'bot-user-99', token, runtimeInstallationId: trust.affinity.runtimeInstallationId, deliveryVersion },
					now,
				}),
			});

		expect(await deliver(2, 'test-credential-v2')).toEqual({
			mcpAppId: trust.affinity.mcpAppId,
			runtimeInstallationId: trust.affinity.runtimeInstallationId,
			deliveryVersion: 2,
		});
		await expect(deliver(1, 'test-credential-v1')).rejects.toThrow();
		await expect(deliver(2, 'test-substituted-credential-v2')).rejects.toThrow();
		expect(await deliver(2, 'test-credential-v2')).toEqual({
			mcpAppId: trust.affinity.mcpAppId,
			runtimeInstallationId: trust.affinity.runtimeInstallationId,
			deliveryVersion: 2,
		});

		const persisted = loadStandaloneIdentity({ filePath }).identity.agentBotCredential;
		expect(persisted?.deliveryVersion).toBe(2);
		expect(tokenFingerprint(persisted!.token)).toBe(tokenFingerprint('test-credential-v2'));
	});

	it('does not adopt or acknowledge a credential when the identity file cannot be atomically rotated', async () => {
		const { privateKey, trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const controller = createStandaloneRelayIdentityController(loadStandaloneIdentity({ filePath }), { now: () => 2_000_000_000 });
		await fs.chmod(filePath, 0o400);
		const assertion = signControlAssertion({
			privateKey,
			kid: trust.hubKid,
			type: 'standalone-agent-bot-credential',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: {
				botUserId: 'bot-user-99',
				token: 'test-persistence-failure',
				runtimeInstallationId: trust.affinity.runtimeInstallationId,
				deliveryVersion: 1,
			},
			now: 2_000_000_000,
		});

		await expect(controller.handleControlNotification(STANDALONE_AGENT_BOT_CREDENTIAL_METHOD, { assertion })).rejects.toThrow();
		expect(readAgentBotCredential()).toBeNull();
		await fs.chmod(filePath, 0o600);
		expect(loadStandaloneIdentity({ filePath }).identity.agentBotCredential).toBeUndefined();
	});
});
