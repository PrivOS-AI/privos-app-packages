import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pairAndAwaitApproval } from '../../src/relay/relay-client.js';
import { loadStandaloneIdentity, standaloneHubFingerprint } from '../../src/relay/standalone-identity.js';
import type { RuntimeDispatchTrustV3 } from '../../src/workload/dispatch-assertion.js';

function buildTrust(): RuntimeDispatchTrustV3 {
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const jwk = pair.publicKey.export({ format: 'jwk' }) as { crv: string; kty: string; x: string; y: string };
	const hubPublicJwk = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
	const hubKid = crypto.createHash('sha256').update(JSON.stringify(hubPublicJwk), 'utf8').digest('base64url');
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
		},
	};
}

/** WS that answers the register handshake with `awaitingApproval`, then closes. */
class RegisterThenAwaitWs extends EventEmitter {
	static OPEN = 1;
	static instances: RegisterThenAwaitWs[] = [];
	readyState = RegisterThenAwaitWs.OPEN;
	constructor(readonly url: string) {
		super();
		RegisterThenAwaitWs.instances.push(this);
		queueMicrotask(() => {
			this.emit('open');
			this.emit(
				'message',
				Buffer.from(
					JSON.stringify({
						result: {
							paired: true,
							clientId: 'client-1',
							clientSecret: 'secret-1',
							relayUrl: 'https://hub.example',
							appId: 'mcp-app-1',
							awaitingApproval: true,
						},
					}),
				),
			);
		});
	}
	send() {}
	close() {
		this.readyState = 3;
		this.emit('close', 1000);
	}
	pong() {}
}

let tempDir: string;
let identityFile: string;

beforeEach(async () => {
	RegisterThenAwaitWs.instances = [];
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-await-'));
	identityFile = path.join(tempDir, 'identity.json');
});
afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

const PAIR_URL = 'wss://hub.example/api/v1/mcp-apps.relay?pair=token-abcdef0123456789';

describe('pairAndAwaitApproval', () => {
	it('registers, polls until approved, then writes the identity file', async () => {
		const trust = buildTrust();
		const fingerprint = standaloneHubFingerprint(trust.hubKid);
		const pollUrls: string[] = [];
		let polls = 0;
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			pollUrls.push(String(url));
			expect(JSON.parse(String(init?.body))).toEqual({ pairToken: 'token-abcdef0123456789' });
			polls += 1;
			const body =
				polls < 3
					? { success: true, status: 'pending' }
					: {
							success: true,
							status: 'approved',
							paired: true,
							clientId: 'client-1',
							clientSecret: 'secret-1',
							// The Hub answers with the wss relay endpoint; the SDK must normalize it to
							// the bare https origin before persisting — JWKS-origin validation and the
							// wss re-derivation both require a bare http(s) origin.
							relayUrl: 'wss://hub.example/api/v1/mcp-apps.relay',
							appId: 'mcp-app-1',
							trust,
							fingerprint,
						};
			return new Response(JSON.stringify(body), { status: 200 });
		}) as typeof fetch;

		const result = await pairAndAwaitApproval(
			PAIR_URL,
			{ name: 'App', version: '1.0.0', manifest: {} },
			RegisterThenAwaitWs as never,
			{ fetchImpl, identityFilePath: identityFile, approvalTimeoutMs: 30_000, pollIntervalMs: 5, onFingerprint: () => {} },
		);

		expect(result.pairingVersion).toBe(2);
		expect(result.identityFilePath).toBe(identityFile);
		expect(polls).toBe(3);
		expect(pollUrls[0]).toBe('https://hub.example/api/v1/mcp-apps.standalone.pair-poll');
		const persisted = loadStandaloneIdentity({ filePath: identityFile });
		expect(persisted.identity.mcpAppId).toBe('mcp-app-1');
		expect(persisted.fingerprint).toBe(fingerprint);
		// Regression: the wss relay endpoint the Hub returned must be normalized to
		// the bare https origin so serveApp's JWKS-origin validation accepts it.
		expect(persisted.identity.relayUrl).toBe('https://hub.example');
	});

	it('throws when the Hub rejects the pairing (app removed)', async () => {
		const fetchImpl = (async () => new Response(JSON.stringify({ success: true, status: 'rejected' }), { status: 200 })) as typeof fetch;
		await expect(
			pairAndAwaitApproval(PAIR_URL, { name: 'App', version: '1.0.0', manifest: {} }, RegisterThenAwaitWs as never, {
				fetchImpl,
				identityFilePath: identityFile,
			}),
		).rejects.toThrow(/rejected/i);
	});

	it('throws when the pairing token expires before approval', async () => {
		const fetchImpl = (async () => new Response(JSON.stringify({ success: true, status: 'expired' }), { status: 200 })) as typeof fetch;
		await expect(
			pairAndAwaitApproval(PAIR_URL, { name: 'App', version: '1.0.0', manifest: {} }, RegisterThenAwaitWs as never, {
				fetchImpl,
				identityFilePath: identityFile,
			}),
		).rejects.toThrow(/expired/i);
	});
});
