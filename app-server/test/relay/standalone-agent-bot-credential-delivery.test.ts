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
} from '../../src/relay/agent-bot-credential.js';
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
	it('persists a valid signed credential into the identity file and adopts it in-process (hot)', async () => {
		const { privateKey, trust } = keyPairAndTrust();
		await saveStandaloneIdentity(identityFixture(trust), { filePath });
		const loaded = loadStandaloneIdentity({ filePath });
		const now = 2_000_000_000;
		const controller = createStandaloneRelayIdentityController(loaded, { now: () => now });

		// Before delivery: no credential is readable.
		expect(readAgentBotCredential()).toBeNull();
		expect(getAgentBotCredentialState()).toBe('absent');

		const assertion = signControlAssertion({
			privateKey,
			kid: trust.hubKid,
			type: 'standalone-agent-bot-credential',
			deploymentId: trust.affinity.deploymentId,
			mcpAppId: trust.affinity.mcpAppId,
			data: { botUserId: 'bot-user-99', token: 'delivered-token-not-a-real-secret' },
			now,
		});

		const outcome = await controller.handleControlNotification(STANDALONE_AGENT_BOT_CREDENTIAL_METHOD, { assertion });
		expect(outcome).toBe('handled');

		// Hot: usable immediately, no restart.
		expect(readAgentBotCredential()).toEqual({ botUserId: 'bot-user-99', token: 'delivered-token-not-a-real-secret' });
		expect(getAgentBotCredentialState()).toBe('live');

		// Durable: persisted into the identity file for the next boot.
		const persisted = loadStandaloneIdentity({ filePath });
		expect(persisted.identity.agentBotCredential).toEqual({ botUserId: 'bot-user-99', token: 'delivered-token-not-a-real-secret' });
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
			data: { botUserId: 'bot-user-99', token: 'delivered-token-not-a-real-secret' },
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
			data: { botUserId: 'bot-user-99' }, // missing token
			now,
		});

		await expect(controller.handleControlNotification(STANDALONE_AGENT_BOT_CREDENTIAL_METHOD, { assertion })).rejects.toThrow();
	});
});
