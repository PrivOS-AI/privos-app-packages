import crypto, { type JsonWebKey } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	createPinnedPortalJwksResolverV3,
	createPublisherRuntimeTrustProvisioningRouterV3,
	SingleProcessFilePublisherRuntimeTrustStoreV3,
	type PublisherRuntimeTrustProvisioningRequestV3,
} from '../../src/workload/publisher-runtime-trust.js';
import type { RuntimeDispatchTrustV3 } from '../../src/workload/dispatch-assertion.js';

const provisioningUrl = 'https://publisher.example/.well-known/privos/runtime-trust/v3';
const portalPair = crypto.generateKeyPairSync('ed25519');
const portalPrivate = portalPair.privateKey.export({ format: 'jwk' });
const portalPublic = portalPair.publicKey.export({ format: 'jwk' });
(portalPublic as JsonWebKey).kid = 'portal-ed25519-key-1';
const hubPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const hubPrivate = hubPair.privateKey.export({ format: 'jwk' });
const hubPublic = hubPair.publicKey.export({ format: 'jwk' });
const hubKid = hash({ crv: hubPublic.crv, kty: hubPublic.kty, x: hubPublic.x, y: hubPublic.y });
const now = 2_000_000_000;

let tempDirectory: string;

beforeEach(async () => { tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'publisher-trust-v3-')); });
afterEach(async () => { await fs.rm(tempDirectory, { recursive: true, force: true }); });

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
	return JSON.stringify(value);
}

function hash(value: unknown): string {
	return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('base64url');
}

function compact(payload: unknown, type: string, key: JsonWebKey, algorithm: 'EdDSA' | 'ES256', kid: string): string {
	const header = { alg: algorithm, kid, privos_protocol: 3, typ: `privos-${type}+jws` };
	const encodedHeader = Buffer.from(canonical(header)).toString('base64url');
	const encodedPayload = Buffer.from(canonical(payload)).toString('base64url');
	const signature = crypto.sign(
		algorithm === 'EdDSA' ? null : 'sha256',
		Buffer.from(`${encodedHeader}.${encodedPayload}`),
		algorithm === 'EdDSA'
			? crypto.createPrivateKey({ key, format: 'jwk' })
			: { key: crypto.createPrivateKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
	).toString('base64url');
	return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function artifacts() {
	const affinity = {
		workspaceId: 'workspace-1', deploymentId: 'deployment-1', machineClientId: 'machine-1', instanceThumbprint: hubKid,
		listingId: 'listing-1', versionId: 'version-1', offerId: 'offer-1', executionMode: 'PUBLISHER_HOSTED',
		availabilityTier: 'single', price: { creatorAmountCents: 0, currency: 'USD', runtimeCostApplies: false, runtimeCostCapCents: null },
		dataPolicyHash: 'A'.repeat(43), manifestDigest: `sha256:${'b'.repeat(64)}`, imageDigest: null, localArtifactDigest: null,
		permissionContractHash: 'C'.repeat(43), approvedPermissionCeiling: [], permissionCeilingHash: hash([]),
	};
	const approval = {
		protocolVersion: 3, type: 'cloud-approval', issuer: 'portal:marketplace-broker', audience: 'hub:deployment-1',
		kid: portalPublic.kid, jti: 'approval-jti-000000000000001', iat: now - 10, exp: now + 300,
		payload: {
			proposalHash: 'E'.repeat(43), affinity,
			approvedBy: { opaqueUserRef: 'owner-1', role: 'OWNER', approvedAt: now - 10 },
			commercial: { entitlementId: 'entitlement-1', entitlementState: 'ACTIVE', validUntil: null, seatAllowance: 1 },
			portalPolicyVersion: 1,
		},
	};
	const execution = {
		protocolVersion: 3, type: 'execution-grant', issuer: approval.issuer, audience: 'installation:installation-1',
		kid: portalPublic.kid, jti: 'execution-jti-00000000000001', iat: now - 9, exp: now + 300,
		payload: {
			deploymentAppId: 'deployment-app-1', generationId: 'generation-1', generationNumber: 1,
			installationId: 'installation-1', workspaceId: affinity.workspaceId, deploymentId: affinity.deploymentId,
			listingId: affinity.listingId, versionId: affinity.versionId, manifestDigest: affinity.manifestDigest,
			permissionCeilingHash: affinity.permissionCeilingHash, approvalJti: approval.jti,
			entitlementId: approval.payload.commercial.entitlementId, entitlementSeatId: 'seat-1',
			runtimeCredentialId: 'credential-1', authorizationEpoch: 1, provisioningNonce: 'provisioning-nonce-1',
		},
	};
	const resourceManifest = [{
		resourceClass: 'privos-publisher-connector', dataClass: 'APP_PRIVATE', ownershipScope: 'INSTALLATION_GENERATION',
		resourceId: 'publisher-connector-1', expectedCount: 1, purgeAdapter: 'publisher-connector',
		absenceAdapter: 'publisher-connector-absence',
	}];
	const resourceManifestTemplate = [{
		resourceClass: 'privos-publisher-connector', dataClass: 'APP_PRIVATE', ownershipScope: 'INSTALLATION_GENERATION',
		resourceKey: 'publisher-connector', expectedCount: 1, purgeAdapter: 'publisher-connector',
		absenceAdapter: 'publisher-connector-absence',
	}];
	const descriptor = {
		protocolVersion: 3, type: 'runtime-deployment-descriptor', issuer: approval.issuer, audience: execution.audience,
		kid: portalPublic.kid, jti: 'descriptor-jti-0000000000001', iat: now - 9, exp: now + 300,
		payload: {
			executionGrantJti: execution.jti, deploymentAppId: execution.payload.deploymentAppId,
			generationId: execution.payload.generationId, generationNumber: execution.payload.generationNumber,
			installationId: execution.payload.installationId, workspaceId: affinity.workspaceId, deploymentId: affinity.deploymentId,
			listingId: affinity.listingId, versionId: affinity.versionId, executionMode: 'PUBLISHER_HOSTED', availabilityTier: 'single',
			versionDigest: `sha256:${'a'.repeat(64)}`, manifestDigest: affinity.manifestDigest, imageDigest: null,
			localArtifactDigest: null, imageRepository: null,
			manifest: { name: 'app-1', version: '1.0.0', serverUrl: 'https://publisher.example/mcp', runtimeTrustProvisioningUrl: provisioningUrl },
			resourceManifestTemplate, resourceManifestTemplateHash: hash(resourceManifestTemplate), resourceManifest,
			resourceManifestHash: hash(resourceManifest), releaseAttestationJws: null, releaseAttestationHash: null,
		},
	};
	return {
		approval,
		execution,
		descriptor,
		approvalJws: compact(approval, 'cloud-approval', portalPrivate, 'EdDSA', String(portalPublic.kid)),
		executionJws: compact(execution, 'execution-grant', portalPrivate, 'EdDSA', String(portalPublic.kid)),
		descriptorJws: compact(descriptor, 'runtime-deployment-descriptor', portalPrivate, 'EdDSA', String(portalPublic.kid)),
	};
}

function trust(active = false): RuntimeDispatchTrustV3 {
	return {
		hubKid,
		hubPublicJwk: { kty: 'EC', crv: 'P-256', x: hubPublic.x, y: hubPublic.y },
		affinity: {
			workspaceId: 'workspace-1', deploymentId: 'deployment-1', mcpAppId: 'app-1', executionMode: 'PUBLISHER_HOSTED',
			generationId: 'generation-1', generationNumber: 1, runtimeInstallationId: 'installation-1',
			manifestDigest: `sha256:${'b'.repeat(64)}`, resourceManifestHash: hash(artifacts().descriptor.payload.resourceManifest),
			...(active ? {
				runtimeResourceInventoryHash: 'I'.repeat(43),
				runtimeApprovalReceiptHash: hash(artifacts().approval),
				runtimeAuthorizationEpoch: 1,
			} : {}),
		},
	};
}

let proofSequence = 0;
function provisionBody(operation: 'PREPARE' | 'ACTIVATE', proofNow = now): PublisherRuntimeTrustProvisioningRequestV3 {
	const chain = artifacts();
	const withoutProof = {
		protocol_version: 3 as const,
		operation,
		runtime_dispatch_trust: trust(operation === 'ACTIVATE'),
		cloud_approval_jws: chain.approvalJws,
		execution_grant_jws: chain.executionJws,
		deployment_descriptor_jws: chain.descriptorJws,
	};
	proofSequence += 1;
	const proof = {
		protocolVersion: 3, type: 'publisher-runtime-trust-provisioning-proof', iss: 'hub:deployment-1', aud: 'mcp-runtime:app-1',
		jti: `proof-jti-${proofSequence}-0000000000000001`, nonce: `proof-nonce-${proofSequence}-0000000000001`,
		iat: proofNow, exp: proofNow + 30, htm: 'PUT', htu: provisioningUrl, bodyDigest: hash(withoutProof),
	};
	return { ...withoutProof, hub_proof_jws: compact(proof, 'publisher-runtime-trust-provision', hubPrivate, 'ES256', hubKid) };
}

function setup(nowProvider: () => number = () => now, fileName = 'trust.json') {
	const store = new SingleProcessFilePublisherRuntimeTrustStoreV3({
		filePath: path.join(tempDirectory, fileName), deploymentMode: 'single-process',
	});
	const app = express();
	app.use(createPublisherRuntimeTrustProvisioningRouterV3({
		provisioningUrl, mcpAppId: 'app-1', now: nowProvider, store,
		portalJwksResolver: async ({ issuer, kid }) => {
			if (issuer !== 'portal:marketplace-broker' || kid !== portalPublic.kid) throw new Error('untrusted portal');
			return { publicJwk: portalPublic };
		},
	}));
	return { app, store };
}

const putCanonical = (app: express.Express, body: unknown, target = new URL(provisioningUrl).pathname) =>
	request(app).put(target).type('application/json').send(canonical(body));

describe('publisher runtime trust provisioning v3', () => {
	it('durably performs PREPARE then ACTIVE and resolves only full active trust', async () => {
		const { app, store } = setup();
		const preparedResponse = await putCanonical(app, provisionBody('PREPARE'));
		expect(preparedResponse.status).toBe(200);
		expect(preparedResponse.body.state).toBe('PREPARED');
		expect(preparedResponse.body.provisioning_evidence_hash).toBe(hash({
			protocol_version: 3, runtime_installation_id: 'installation-1', generation_id: 'generation-1', generation_number: 1,
			state: 'PREPARED', runtime_dispatch_trust_hash: hash(trust(false)), prepared_at: now,
		}));
		expect(await store.resolveDispatchTrust({
			kid: hubKid, workspaceId: 'workspace-1', deploymentId: 'deployment-1', mcpAppId: 'app-1',
			executionMode: 'PUBLISHER_HOSTED', generationId: 'generation-1', generationNumber: 1,
			runtimeInstallationId: 'installation-1', authorizationContext: 'workspace', preactivationReadiness: true,
		})).toEqual(trust(false));
		await expect(store.resolveDispatchTrust({
			kid: hubKid, workspaceId: 'workspace-1', deploymentId: 'deployment-1', mcpAppId: 'app-1',
			executionMode: 'PUBLISHER_HOSTED', generationId: 'generation-1', generationNumber: 1,
			runtimeInstallationId: 'installation-1', authorizationContext: 'workspace',
		})).rejects.toThrow('publisher_runtime_trust_not_active');
		await expect(store.loadActive({
			kid: hubKid, workspaceId: 'workspace-1', deploymentId: 'deployment-1', mcpAppId: 'app-1',
			executionMode: 'PUBLISHER_HOSTED', generationId: 'generation-1', generationNumber: 1,
			runtimeInstallationId: 'installation-1', authorizationContext: 'workspace',
		})).rejects.toThrow('publisher_runtime_trust_not_active');

		const activeResponse = await putCanonical(app, provisionBody('ACTIVATE'));
		expect(activeResponse.status).toBe(200);
		expect(activeResponse.body.state).toBe('ACTIVE');
		expect(activeResponse.body.prepared_at).toBe(now);
		const active = await store.loadActive({
			kid: hubKid, workspaceId: 'workspace-1', deploymentId: 'deployment-1', mcpAppId: 'app-1',
			executionMode: 'PUBLISHER_HOSTED', generationId: 'generation-1', generationNumber: 1,
			runtimeInstallationId: 'installation-1', authorizationContext: 'workspace',
		});
		expect(active).toEqual(trust(true));
		await store.close();
		const reloaded = new SingleProcessFilePublisherRuntimeTrustStoreV3({
			filePath: path.join(tempDirectory, 'trust.json'), deploymentMode: 'single-process',
		});
		expect(await reloaded.loadActive({
			kid: hubKid, workspaceId: 'workspace-1', deploymentId: 'deployment-1', mcpAppId: 'app-1',
			executionMode: 'PUBLISHER_HOSTED', generationId: 'generation-1', generationNumber: 1,
			runtimeInstallationId: 'installation-1', authorizationContext: 'workspace',
		})).toEqual(trust(true));
	});

	it('is idempotent for fresh proof of an exact body and rejects changed dynamic trust', async () => {
		const { app } = setup();
		expect((await putCanonical(app, provisionBody('PREPARE'))).status).toBe(200);
		const first = await putCanonical(app, provisionBody('ACTIVATE'));
		const retried = await putCanonical(app, provisionBody('ACTIVATE'));
		expect(retried.status).toBe(200);
		expect(retried.body).toEqual(first.body);
		const changed = provisionBody('ACTIVATE') as any;
		changed.runtime_dispatch_trust.affinity.runtimeAuthorizationEpoch = 2;
		expect((await putCanonical(app, changed)).status).toBe(400);
	});

	it('fails closed for missing preparation, changed Portal chain, query use, and proof replay mutation', async () => {
		const { app } = setup();
		expect((await putCanonical(app, provisionBody('ACTIVATE'))).status).toBe(409);
		const invalidChain = provisionBody('PREPARE') as any;
		const approvalParts = invalidChain.cloud_approval_jws.split('.');
		approvalParts[2] = `${approvalParts[2][0] === 'A' ? 'B' : 'A'}${approvalParts[2].slice(1)}`;
		invalidChain.cloud_approval_jws = approvalParts.join('.');
		expect((await putCanonical(app, invalidChain)).status).toBe(401);
		expect((await putCanonical(app, provisionBody('PREPARE'), `${new URL(provisioningUrl).pathname}?x=1`)).status).toBe(400);
		const original = provisionBody('PREPARE') as any;
		expect((await putCanonical(app, original)).status).toBe(200);
		original.runtime_dispatch_trust.affinity.manifestDigest = `sha256:${'f'.repeat(64)}`;
		expect((await putCanonical(app, original)).status).toBe(400);
	});

	it('atomically persists dispatch JTI and nonce replay state', async () => {
		const { store } = setup();
		const replay = { issuer: 'hub:deployment-1', jti: 'jti-1', nonce: 'nonce-1', expiresAt: now + 30, now };
		expect(await store.consume(replay)).toBe(true);
		expect(await store.consume(replay)).toBe(false);
		expect(await store.consume({ ...replay, jti: 'jti-2' })).toBe(false);
	});

	it('rejects noncanonical or duplicate JSON and ambiguous provisioning paths', async () => {
		const { app, store } = setup();
		const body = provisionBody('PREPARE');
		expect((await request(app).put(new URL(provisioningUrl).pathname).send(body)).status).toBe(400);
		const encoded = canonical(body);
		const duplicate = encoded.replace('{', '{"protocol_version":3,');
		expect((await request(app).put(new URL(provisioningUrl).pathname).type('application/json').send(duplicate)).status).toBe(400);
		for (const invalid of [
			'https://publisher.example/a//b',
			'https://publisher.example/a/%2e%2e/b',
			'https://publisher.example/a/../b',
			'https://publisher.example/.well-known/privos/runtime-trust/v3/',
		]) {
				expect(() => createPublisherRuntimeTrustProvisioningRouterV3({
				provisioningUrl: invalid, mcpAppId: 'app-1', store,
				portalJwksResolver: async () => ({ publicJwk: portalPublic }),
			})).toThrow('publisher_runtime_trust_configuration_invalid');
		}
		expect(() => new SingleProcessFilePublisherRuntimeTrustStoreV3({
			filePath: path.join(tempDirectory, 'trust.json'), deploymentMode: 'single-process',
		})).toThrow('publisher_runtime_trust_store_already_in_use');
	});

	it('allows exact PREPARE and ACTIVATE recovery after Portal envelopes expire', async () => {
		let current = now;
		const { app } = setup(() => current);
		const prepared = await putCanonical(app, provisionBody('PREPARE', current));
		expect(prepared.status).toBe(200);
		current = now + 400;
		const recovered = await putCanonical(app, provisionBody('PREPARE', current));
		expect(recovered.status).toBe(200);
		expect(recovered.body).toEqual(prepared.body);
		expect((await putCanonical(app, provisionBody('ACTIVATE', current))).status).toBe(200);

		const fresh = setup(() => current, 'fresh.json');
		expect((await putCanonical(fresh.app, provisionBody('PREPARE', current))).status).toBe(400);
	});

	it('bounds pinned Portal JWKS connect and streaming response bytes', async () => {
		const resolveWith = (fetchImpl: typeof fetch, timeoutMs = 100) => createPinnedPortalJwksResolverV3({
			issuer: 'portal:marketplace-broker',
			jwksUrl: 'https://portal.privos.io/approval-jwks',
			fetchImpl,
			timeoutMs,
		});
		const input = { issuer: 'portal:marketplace-broker', kid: String(portalPublic.kid), type: 'cloud-approval' as const };
		const valid = resolveWith(async (_url, init) => {
			expect(init?.redirect).toBe('error');
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return new Response(JSON.stringify({ keys: [portalPublic] }), {
				status: 200, headers: { 'content-type': 'application/json' },
			});
		});
		expect((await valid(input)).publicJwk).toEqual(portalPublic);

		const declaredOversize = resolveWith(async () => new Response('{}', {
			status: 200,
			headers: { 'content-type': 'application/json', 'content-length': '256001' },
		}));
		await expect(declaredOversize(input)).rejects.toThrow('publisher_portal_jwks_fetch_failed');

		const chunkedOversize = resolveWith(async () => new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(200_000));
				controller.enqueue(new Uint8Array(60_001));
				controller.close();
			},
		}), { status: 200, headers: { 'content-type': 'application/json' } }));
		await expect(chunkedOversize(input)).rejects.toThrow('publisher_portal_jwks_fetch_failed');

		const hung = resolveWith(async (_url, init) => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new Error('jwks-aborted')), { once: true });
		}), 5);
		await expect(hung(input)).rejects.toThrow('jwks-aborted');
	});

	it('rejects a hash-matching but non-normalized permission ceiling', async () => {
		const { app } = setup();
		const body = provisionBody('PREPARE') as any;
		const chain = artifacts();
		const invalidApproval = structuredClone(chain.approval) as any;
		invalidApproval.payload.affinity.approvedPermissionCeiling = ['lists:read', 'basic:information'];
		invalidApproval.payload.affinity.permissionCeilingHash = hash(invalidApproval.payload.affinity.approvedPermissionCeiling);
		body.cloud_approval_jws = compact(invalidApproval, 'cloud-approval', portalPrivate, 'EdDSA', String(portalPublic.kid));
		const invalidExecution = structuredClone(chain.execution) as any;
		invalidExecution.payload.permissionCeilingHash = invalidApproval.payload.affinity.permissionCeilingHash;
		body.execution_grant_jws = compact(invalidExecution, 'execution-grant', portalPrivate, 'EdDSA', String(portalPublic.kid));
		const withoutProof = { ...body };
		delete withoutProof.hub_proof_jws;
		proofSequence += 1;
		const proof = {
			protocolVersion: 3, type: 'publisher-runtime-trust-provisioning-proof', iss: 'hub:deployment-1', aud: 'mcp-runtime:app-1',
			jti: `scope-proof-jti-${proofSequence}`, nonce: `scope-proof-nonce-${proofSequence}-000000000000000000`,
			iat: now, exp: now + 30, htm: 'PUT', htu: provisioningUrl, bodyDigest: hash(withoutProof),
		};
		body.hub_proof_jws = compact(proof, 'publisher-runtime-trust-provision', hubPrivate, 'ES256', hubKid);
		expect((await putCanonical(app, body)).status).toBe(400);
	});
});
