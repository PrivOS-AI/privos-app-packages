import crypto, { type JsonWebKey } from 'node:crypto';
import * as fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import express, { Router, type Request, type Response } from 'express';

import type {
	RuntimeDispatchReplayConsumerV3,
	RuntimeDispatchReplayInputV3,
	RuntimeDispatchTrustHintV3,
	RuntimeDispatchTrustV3,
} from './dispatch-assertion.js';
import { assertRuntimeDispatchTrustConfigurationV3 } from './dispatch-assertion.js';

const HASH = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMPACT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_COMPACT_BYTES = 20_000;
const MAX_PROVISIONING_BODY_BYTES = 80_000;

type JsonRecord = Record<string, unknown>;

export type PublisherRuntimeTrustOperationV3 = 'PREPARE' | 'ACTIVATE';

export type PublisherRuntimeTrustProvisioningRequestV3 = Readonly<{
	protocol_version: 3;
	operation: PublisherRuntimeTrustOperationV3;
	runtime_dispatch_trust: RuntimeDispatchTrustV3;
	cloud_approval_jws: string;
	execution_grant_jws: string;
	deployment_descriptor_jws: string;
	hub_proof_jws: string;
}>;

export type PublisherRuntimeTrustPreparedEvidenceV3 = Readonly<{
	protocol_version: 3;
	runtime_installation_id: string;
	generation_id: string;
	generation_number: number;
	state: 'PREPARED';
	runtime_dispatch_trust_hash: string;
	prepared_at: number;
	provisioning_evidence_hash: string;
}>;

export type PublisherRuntimeTrustActiveEvidenceV3 = Readonly<{
	protocol_version: 3;
	runtime_installation_id: string;
	generation_id: string;
	generation_number: number;
	state: 'ACTIVE';
	runtime_dispatch_trust_hash: string;
	prepared_at: number;
	activated_at: number;
	provisioning_evidence_hash: string;
}>;

export type PublisherRuntimeTrustEvidenceV3 =
	| PublisherRuntimeTrustPreparedEvidenceV3
	| PublisherRuntimeTrustActiveEvidenceV3;

export type PublisherPortalJwksResolutionV3 = Readonly<{
	/** The resolver must reject issuers outside its operator-pinned Portal origin. */
	publicJwk: JsonWebKey;
}>;

export type PublisherPortalJwksResolverV3 = (input: Readonly<{
	issuer: string;
	kid: string;
	type: 'cloud-approval' | 'execution-grant' | 'runtime-deployment-descriptor';
}>) => PublisherPortalJwksResolutionV3 | Promise<PublisherPortalJwksResolutionV3>;

/** Builds a resolver pinned to one operator-configured Portal issuer and JWKS URL. */
export function createPinnedPortalJwksResolverV3(options: Readonly<{
	issuer: string;
	jwksUrl: string;
	cacheSeconds?: number;
	timeoutMs?: number;
	/** Test/embedded-runtime hook. Production should use the platform fetch. */
	fetchImpl?: typeof fetch;
}>): PublisherPortalJwksResolverV3 {
	if (!id(options.issuer)) throw new Error('publisher_portal_jwks_configuration_invalid');
	let target: URL;
	try { target = new URL(options.jwksUrl); } catch { throw new Error('publisher_portal_jwks_configuration_invalid'); }
	if (target.protocol !== 'https:' || !target.hostname || target.username || target.password || target.search || target.hash ||
		target.toString() !== options.jwksUrl) throw new Error('publisher_portal_jwks_configuration_invalid');
	const cacheSeconds = options.cacheSeconds ?? 300;
	if (!Number.isSafeInteger(cacheSeconds) || cacheSeconds < 1 || cacheSeconds > 3600) {
		throw new Error('publisher_portal_jwks_configuration_invalid');
	}
	const timeoutMs = options.timeoutMs ?? 10_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
		throw new Error('publisher_portal_jwks_configuration_invalid');
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	let cached: { expiresAt: number; keys: JsonWebKey[] } | undefined;
	return async ({ issuer, kid }) => {
		if (issuer !== options.issuer || !id(kid)) throw new Error('publisher_portal_jwks_issuer_invalid');
		const now = Math.floor(Date.now() / 1000);
		if (!cached || cached.expiresAt <= now) {
			const response = await fetchImpl(options.jwksUrl, {
				method: 'GET',
				headers: { Accept: 'application/json' },
				redirect: 'error',
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
				throw new Error('publisher_portal_jwks_fetch_failed');
			}
			const declaredLength = response.headers.get('content-length');
			if (declaredLength !== null && (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > 256_000)) {
				throw new Error('publisher_portal_jwks_fetch_failed');
			}
			if (!response.body) throw new Error('publisher_portal_jwks_fetch_failed');
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let byteLength = 0;
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					byteLength += chunk.value.byteLength;
					if (byteLength > 256_000) {
						await reader.cancel('publisher Portal JWKS response exceeded byte limit');
						throw new Error('publisher_portal_jwks_fetch_failed');
					}
					chunks.push(chunk.value);
				}
			} finally {
				reader.releaseLock();
			}
			const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), byteLength).toString('utf8');
			let document: unknown;
			try { document = JSON.parse(raw) as unknown; } catch { throw new Error('publisher_portal_jwks_fetch_failed'); }
			if (!isRecord(document) || !exactKeys(document, ['keys']) || !Array.isArray(document.keys) || document.keys.length > 100) {
				throw new Error('publisher_portal_jwks_fetch_failed');
			}
			cached = { expiresAt: now + cacheSeconds, keys: document.keys as JsonWebKey[] };
		}
		const matches = cached.keys.filter((key) => key && key.kid === kid && key.kty === 'OKP' && key.crv === 'Ed25519' &&
			key.use !== 'enc' && (!key.alg || key.alg === 'EdDSA') && !key.d && typeof key.x === 'string');
		if (matches.length !== 1) throw new Error('publisher_portal_jwks_key_invalid');
		return { publicJwk: matches[0]! };
	};
}

type VerifiedPortalArtifact = Readonly<{
	header: JsonRecord & { kid: string };
	envelope: JsonRecord & {
		protocolVersion: 3;
		type: string;
		issuer: string;
		audience: string;
		kid: string;
		jti: string;
		iat: number;
		exp: number;
		payload: JsonRecord;
	};
}>;

type PublisherTrustRecordV3 = {
	key: string;
	provisioningUrl: string;
	mcpAppId: string;
	portalArtifactsHash: string;
	prepareBodyDigest: string;
	preparedTrust: RuntimeDispatchTrustV3;
	preparedEvidence: PublisherRuntimeTrustPreparedEvidenceV3;
	activateBodyDigest?: string;
	activeTrust?: RuntimeDispatchTrustV3;
	activeEvidence?: PublisherRuntimeTrustActiveEvidenceV3;
};

type DurableStateV3 = {
	protocolVersion: 3;
	records: Record<string, PublisherTrustRecordV3>;
	provisioningJtis: Record<string, { bodyDigest: string; expiresAt: number }>;
	provisioningNonces: Record<string, { bodyDigest: string; expiresAt: number }>;
	dispatchJtis: Record<string, number>;
	dispatchNonces: Record<string, number>;
};

export type PublisherRuntimeTrustStoreMutationV3 = Readonly<{
	operation: PublisherRuntimeTrustOperationV3;
	provisioningUrl: string;
	mcpAppId: string;
	trust: RuntimeDispatchTrustV3;
	portalArtifactsHash: string;
	portalArtifactsExpired: boolean;
	bodyDigest: string;
	proof: Readonly<{ issuer: string; jti: string; nonce: string; expiresAt: number }>;
	now: number;
}>;

export interface PublisherRuntimeTrustDurableStoreV3 extends RuntimeDispatchReplayConsumerV3 {
	/**
	 * Atomically consumes proof replay state and compare-and-sets PREPARED/ACTIVE.
	 * Expired Portal artifacts are valid only for an exact existing generation;
	 * an implementation must reject a fresh expired PREPARE.
	 */
	apply(input: PublisherRuntimeTrustStoreMutationV3): Promise<PublisherRuntimeTrustEvidenceV3>;
	/** Returns only exact ACTIVE trust. PREPARED state is never dispatch-authorizing. */
	loadActive(hint: RuntimeDispatchTrustHintV3): Promise<RuntimeDispatchTrustV3>;
	/** PREPARED trust is exposed only for the three exact, signed readiness RPCs. */
	resolveDispatchTrust(hint: RuntimeDispatchTrustHintV3): Promise<RuntimeDispatchTrustV3>;
}

function isRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

function canonicalHash(value: unknown): string {
	return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('base64url');
}

function id(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 1;
}

function assertAbsoluteProvisioningUrl(value: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error('publisher_runtime_trust_configuration_invalid');
	}
	if (
		parsed.protocol !== 'https:' ||
		!parsed.hostname ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		parsed.toString() !== value ||
		parsed.pathname === '/' ||
		parsed.pathname.endsWith('/') ||
		parsed.pathname.includes('%') ||
		parsed.pathname.includes('//') ||
		parsed.pathname.split('/').slice(1).some((segment) =>
			!segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment))
	) {
		throw new Error('publisher_runtime_trust_configuration_invalid');
	}
	return parsed;
}

function decodeCanonicalSegment(segment: string): { value: JsonRecord; bytes: Buffer } {
	let bytes: Buffer;
	let value: unknown;
	try {
		bytes = Buffer.from(segment, 'base64url');
		if (bytes.toString('base64url') !== segment) throw new Error('non-canonical base64url');
		value = JSON.parse(bytes.toString('utf8')) as unknown;
	} catch {
		throw new Error('publisher_runtime_trust_artifact_invalid');
	}
	if (!isRecord(value) || canonical(value) !== bytes.toString('utf8')) {
		throw new Error('publisher_runtime_trust_artifact_invalid');
	}
	return { value, bytes };
}

function compactParts(compact: string): {
	encodedHeader: string;
	encodedPayload: string;
	header: JsonRecord;
	payload: JsonRecord;
	signature: Buffer;
} {
	if (compact.length < 32 || compact.length > MAX_COMPACT_BYTES || !COMPACT.test(compact)) {
		throw new Error('publisher_runtime_trust_artifact_invalid');
	}
	const [encodedHeader, encodedPayload, encodedSignature] = compact.split('.');
	const header = decodeCanonicalSegment(encodedHeader!);
	const payload = decodeCanonicalSegment(encodedPayload!);
	const signature = Buffer.from(encodedSignature!, 'base64url');
	if (signature.toString('base64url') !== encodedSignature) throw new Error('publisher_runtime_trust_artifact_invalid');
	return { encodedHeader: encodedHeader!, encodedPayload: encodedPayload!, header: header.value, payload: payload.value, signature };
}

const ENVELOPE_KEYS = ['audience', 'exp', 'iat', 'issuer', 'jti', 'kid', 'payload', 'protocolVersion', 'type'] as const;

async function verifyPortalArtifact(
	compact: string,
	type: 'cloud-approval' | 'execution-grant' | 'runtime-deployment-descriptor',
	resolver: PublisherPortalJwksResolverV3,
	now: number,
	clockSkewSeconds: number,
	allowExpired: boolean,
): Promise<VerifiedPortalArtifact> {
	const parsed = compactParts(compact);
	const expectedTyp = `privos-${type}+jws`;
	if (
		!exactKeys(parsed.header, ['alg', 'kid', 'privos_protocol', 'typ']) ||
		parsed.header.alg !== 'EdDSA' ||
		parsed.header.typ !== expectedTyp ||
		parsed.header.privos_protocol !== 3 ||
		!id(parsed.header.kid) ||
		!exactKeys(parsed.payload, ENVELOPE_KEYS) ||
		parsed.payload.protocolVersion !== 3 ||
		parsed.payload.type !== type ||
		!id(parsed.payload.issuer) ||
		!id(parsed.payload.audience) ||
		parsed.payload.kid !== parsed.header.kid ||
		!id(parsed.payload.jti) ||
		!positiveInteger(parsed.payload.iat) ||
		!positiveInteger(parsed.payload.exp) ||
		parsed.payload.exp <= parsed.payload.iat ||
		parsed.payload.iat > now + clockSkewSeconds ||
		(!allowExpired && parsed.payload.exp <= now) ||
		!isRecord(parsed.payload.payload)
	) {
		throw new Error('publisher_runtime_trust_artifact_invalid');
	}
	const resolved = await resolver({
		issuer: parsed.payload.issuer,
		kid: parsed.header.kid,
		type,
	});
	try {
		if (
			!resolved ||
			!resolved.publicJwk ||
			resolved.publicJwk.kty !== 'OKP' ||
			resolved.publicJwk.crv !== 'Ed25519' ||
			resolved.publicJwk.d ||
			typeof resolved.publicJwk.x !== 'string' ||
			!crypto.verify(
				null,
				Buffer.from(`${parsed.encodedHeader}.${parsed.encodedPayload}`, 'utf8'),
				crypto.createPublicKey({ key: resolved.publicJwk, format: 'jwk' }),
				parsed.signature,
			)
		) {
			throw new Error('invalid');
		}
	} catch {
		throw new Error('publisher_runtime_trust_artifact_signature_invalid');
	}
	return {
		header: parsed.header as JsonRecord & { kid: string },
		envelope: parsed.payload as VerifiedPortalArtifact['envelope'],
	};
}

const ACQUISITION_AFFINITY_KEYS = [
	'approvedPermissionCeiling',
	'availabilityTier',
	'dataPolicyHash',
	'deploymentId',
	'executionMode',
	'imageDigest',
	'instanceThumbprint',
	'listingId',
	'localArtifactDigest',
	'machineClientId',
	'manifestDigest',
	'offerId',
	'permissionCeilingHash',
	'permissionContractHash',
	'price',
	'versionId',
	'workspaceId',
] as const;

function assertAcquisitionAffinity(value: unknown): asserts value is JsonRecord {
	const approvedPermissionCeiling = isRecord(value) && Array.isArray(value.approvedPermissionCeiling)
		? value.approvedPermissionCeiling
		: undefined;
	const normalizedScopes = approvedPermissionCeiling
		? [...approvedPermissionCeiling].sort((left, right) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0)
		: [];
	if (
		!isRecord(value) ||
		!exactKeys(value, ACQUISITION_AFFINITY_KEYS) ||
		!id(value.workspaceId) ||
		!id(value.deploymentId) ||
		!id(value.machineClientId) ||
		!HASH.test(String(value.instanceThumbprint)) ||
		!id(value.listingId) ||
		!id(value.versionId) ||
		!id(value.offerId) ||
		value.executionMode !== 'PUBLISHER_HOSTED' ||
		!['single', 'ha'].includes(String(value.availabilityTier)) ||
		!HASH.test(String(value.dataPolicyHash)) ||
		!DIGEST.test(String(value.manifestDigest)) ||
		value.imageDigest !== null ||
		value.localArtifactDigest !== null ||
		!HASH.test(String(value.permissionContractHash)) ||
		!approvedPermissionCeiling ||
		approvedPermissionCeiling.some((scope) => typeof scope !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$/.test(scope)) ||
		new Set(approvedPermissionCeiling).size !== approvedPermissionCeiling.length ||
		normalizedScopes.some((scope, index) => scope !== approvedPermissionCeiling[index]) ||
		!HASH.test(String(value.permissionCeilingHash)) ||
		canonicalHash(approvedPermissionCeiling) !== value.permissionCeilingHash ||
		!isRecord(value.price) ||
		!exactKeys(value.price, ['creatorAmountCents', 'currency', 'runtimeCostApplies', 'runtimeCostCapCents']) ||
		!Number.isSafeInteger(value.price.creatorAmountCents) || Number(value.price.creatorAmountCents) < 0 ||
		!/^\p{Lu}{3}$/u.test(String(value.price.currency)) ||
		typeof value.price.runtimeCostApplies !== 'boolean' ||
		(value.price.runtimeCostCapCents !== null &&
			(!Number.isSafeInteger(value.price.runtimeCostCapCents) || Number(value.price.runtimeCostCapCents) < 0))
	) {
		throw new Error('publisher_runtime_trust_portal_chain_invalid');
	}
}

const EXECUTION_KEYS = [
	'approvalJti',
	'authorizationEpoch',
	'deploymentAppId',
	'entitlementId',
	'entitlementSeatId',
	'generationId',
	'generationNumber',
	'installationId',
	'listingId',
	'manifestDigest',
	'permissionCeilingHash',
	'provisioningNonce',
	'runtimeCredentialId',
	'versionId',
	'workspaceId',
	'deploymentId',
] as const;

const DESCRIPTOR_KEYS = [
	'availabilityTier',
	'deploymentAppId',
	'executionGrantJti',
	'executionMode',
	'generationId',
	'generationNumber',
	'imageDigest',
	'imageRepository',
	'installationId',
	'listingId',
	'localArtifactDigest',
	'manifest',
	'manifestDigest',
	'releaseAttestationHash',
	'releaseAttestationJws',
	'resourceManifest',
	'resourceManifestHash',
	'resourceManifestTemplate',
	'resourceManifestTemplateHash',
	'versionDigest',
	'versionId',
	'workspaceId',
	'deploymentId',
] as const;

function assertResourceManifest(value: unknown, template: boolean): asserts value is JsonRecord[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 1024) {
		throw new Error('publisher_runtime_trust_portal_chain_invalid');
	}
	for (const item of value) {
		if (!isRecord(item)) throw new Error('publisher_runtime_trust_portal_chain_invalid');
		const optionalReference = !template && item.referenceCount !== undefined ? ['referenceCount'] : [];
		const keys = template
			? ['absenceAdapter', 'dataClass', 'expectedCount', 'ownershipScope', 'purgeAdapter', 'resourceClass', 'resourceKey']
			: ['absenceAdapter', 'dataClass', 'expectedCount', 'ownershipScope', 'purgeAdapter', 'resourceClass', 'resourceId', ...optionalReference];
		const identity = template ? item.resourceKey : item.resourceId;
		if (
			!exactKeys(item, keys) ||
			!id(item.resourceClass) ||
			!['APP_PRIVATE', 'HUB_NATIVE_USER_OWNED', 'PUBLISHER_EXTERNAL'].includes(String(item.dataClass)) ||
			!['ROOM_BINDING', 'INSTALLATION_GENERATION', 'DEPLOYMENT_SHARED', 'PLATFORM_SHARED'].includes(String(item.ownershipScope)) ||
			!id(identity) ||
			!Number.isSafeInteger(item.expectedCount) || Number(item.expectedCount) < 0 ||
			!id(item.purgeAdapter) || !id(item.absenceAdapter) ||
			(item.referenceCount !== undefined && (!Number.isSafeInteger(item.referenceCount) || Number(item.referenceCount) < 0))
		) throw new Error('publisher_runtime_trust_portal_chain_invalid');
	}
}

function assertPortalChain(input: {
	approval: VerifiedPortalArtifact;
	execution: VerifiedPortalArtifact;
	descriptor: VerifiedPortalArtifact;
	trust: RuntimeDispatchTrustV3;
	mcpAppId: string;
	provisioningUrl: string;
}): void {
	const approval = input.approval.envelope;
	const execution = input.execution.envelope;
	const descriptor = input.descriptor.envelope;
	const ap = approval.payload;
	const ep = execution.payload;
	const dp = descriptor.payload;
	if (
		!exactKeys(ap, ['approvedBy', 'affinity', 'commercial', 'portalPolicyVersion', 'proposalHash']) ||
		!HASH.test(String(ap.proposalHash)) ||
		!isRecord(ap.approvedBy) ||
		!exactKeys(ap.approvedBy, ['approvedAt', 'opaqueUserRef', 'role']) ||
		!id(ap.approvedBy.opaqueUserRef) ||
		ap.approvedBy.role !== 'OWNER' ||
		!positiveInteger(ap.approvedBy.approvedAt) ||
		!isRecord(ap.commercial) ||
		!exactKeys(ap.commercial, ['entitlementId', 'entitlementState', 'seatAllowance', 'validUntil']) ||
		!id(ap.commercial.entitlementId) ||
		!['ACTIVE', 'PENDING_PAYMENT'].includes(String(ap.commercial.entitlementState)) ||
		!positiveInteger(ap.commercial.seatAllowance) ||
		(ap.commercial.validUntil !== null && !positiveInteger(ap.commercial.validUntil)) ||
		!positiveInteger(ap.portalPolicyVersion)
	) throw new Error('publisher_runtime_trust_portal_chain_invalid');
	assertAcquisitionAffinity(ap.affinity);
	const approvalAffinity = ap.affinity;
	assertResourceManifest(dp.resourceManifest, false);
	assertResourceManifest(dp.resourceManifestTemplate, true);
	if (
		!exactKeys(ep, EXECUTION_KEYS) ||
		!exactKeys(dp, DESCRIPTOR_KEYS) ||
		approval.issuer !== execution.issuer ||
		approval.issuer !== descriptor.issuer ||
		approval.audience !== `hub:${String(ep.deploymentId)}` ||
		execution.audience !== `installation:${String(ep.installationId)}` ||
		descriptor.audience !== execution.audience ||
		ep.approvalJti !== approval.jti ||
		dp.executionGrantJti !== execution.jti ||
		!positiveInteger(ep.authorizationEpoch) ||
		!positiveInteger(ep.generationNumber) ||
		!positiveInteger(dp.generationNumber) ||
		!isRecord(dp.manifest) ||
		!Array.isArray(dp.resourceManifest) ||
		!Array.isArray(dp.resourceManifestTemplate) ||
		canonicalHash(dp.resourceManifest) !== dp.resourceManifestHash ||
		canonicalHash(dp.resourceManifestTemplate) !== dp.resourceManifestTemplateHash ||
		dp.executionMode !== 'PUBLISHER_HOSTED' ||
		dp.imageDigest !== null ||
		dp.localArtifactDigest !== null ||
		dp.imageRepository !== null ||
		dp.releaseAttestationJws !== null ||
		dp.releaseAttestationHash !== null ||
		dp.availabilityTier !== approvalAffinity.availabilityTier ||
		ep.entitlementId !== ap.commercial.entitlementId ||
		ep.permissionCeilingHash !== ap.affinity.permissionCeilingHash ||
		!id(ep.deploymentAppId) || !id(ep.generationId) || !id(ep.installationId) ||
		!id(ep.workspaceId) || !id(ep.deploymentId) || !id(ep.listingId) || !id(ep.versionId) ||
		!DIGEST.test(String(ep.manifestDigest)) || !HASH.test(String(ep.permissionCeilingHash)) ||
		!id(ep.entitlementSeatId) || !id(ep.runtimeCredentialId) || !id(ep.provisioningNonce) ||
		!DIGEST.test(String(dp.versionDigest)) || !DIGEST.test(String(dp.manifestDigest)) ||
		!HASH.test(String(dp.resourceManifestHash)) || !HASH.test(String(dp.resourceManifestTemplateHash))
	) throw new Error('publisher_runtime_trust_portal_chain_invalid');
	const commonKeys = ['workspaceId', 'deploymentId', 'listingId', 'versionId', 'manifestDigest'] as const;
	if (
		commonKeys.some((key) => ep[key] !== approvalAffinity[key] || dp[key] !== ep[key]) ||
		dp.deploymentAppId !== ep.deploymentAppId ||
		dp.generationId !== ep.generationId ||
		dp.generationNumber !== ep.generationNumber ||
		dp.installationId !== ep.installationId ||
		(dp.manifest as JsonRecord).name !== input.mcpAppId ||
		(dp.manifest as JsonRecord).runtimeTrustProvisioningUrl !== input.provisioningUrl ||
		approvalAffinity.instanceThumbprint !== input.trust.hubKid
	) throw new Error('publisher_runtime_trust_portal_chain_invalid');
	const affinity = input.trust.affinity;
	if (
		affinity.executionMode !== 'PUBLISHER_HOSTED' ||
		affinity.workspaceId !== ep.workspaceId ||
		affinity.deploymentId !== ep.deploymentId ||
		affinity.mcpAppId !== input.mcpAppId ||
		affinity.generationId !== ep.generationId ||
		affinity.generationNumber !== ep.generationNumber ||
		affinity.runtimeInstallationId !== ep.installationId ||
		affinity.manifestDigest !== ep.manifestDigest ||
		affinity.resourceManifestHash !== dp.resourceManifestHash
	) throw new Error('publisher_runtime_trust_portal_chain_invalid');
}

function verifyHubProof(input: {
	compact: string;
	bodyWithoutProof: Omit<PublisherRuntimeTrustProvisioningRequestV3, 'hub_proof_jws'>;
	trust: RuntimeDispatchTrustV3;
	provisioningUrl: string;
	mcpAppId: string;
	now: number;
	clockSkewSeconds: number;
}): { issuer: string; jti: string; nonce: string; expiresAt: number; bodyDigest: string } {
	const parsed = compactParts(input.compact);
	const payload = parsed.payload;
	const bodyDigest = canonicalHash(input.bodyWithoutProof);
	if (
		!exactKeys(parsed.header, ['alg', 'kid', 'privos_protocol', 'typ']) ||
		parsed.header.alg !== 'ES256' ||
		parsed.header.kid !== input.trust.hubKid ||
		parsed.header.privos_protocol !== 3 ||
		parsed.header.typ !== 'privos-publisher-runtime-trust-provision+jws' ||
		!exactKeys(payload, ['aud', 'bodyDigest', 'exp', 'htm', 'htu', 'iat', 'iss', 'jti', 'nonce', 'protocolVersion', 'type']) ||
		payload.protocolVersion !== 3 ||
		payload.type !== 'publisher-runtime-trust-provisioning-proof' ||
		payload.iss !== `hub:${input.trust.affinity.deploymentId}` ||
		payload.aud !== `mcp-runtime:${input.mcpAppId}` ||
		!id(payload.jti) || !id(payload.nonce) ||
		!positiveInteger(payload.iat) || !positiveInteger(payload.exp) ||
		payload.exp <= payload.iat || Number(payload.exp) - Number(payload.iat) > 30 ||
		Number(payload.iat) > input.now + input.clockSkewSeconds || Number(payload.exp) <= input.now ||
		payload.htm !== 'PUT' || payload.htu !== input.provisioningUrl || payload.bodyDigest !== bodyDigest
	) throw new Error('publisher_runtime_trust_hub_proof_invalid');
	try {
		if (!crypto.verify(
			'sha256',
			Buffer.from(`${parsed.encodedHeader}.${parsed.encodedPayload}`, 'utf8'),
			{ key: crypto.createPublicKey({ key: input.trust.hubPublicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
			parsed.signature,
		)) throw new Error('invalid');
	} catch {
		throw new Error('publisher_runtime_trust_hub_proof_invalid');
	}
	return {
		issuer: String(payload.iss),
		jti: String(payload.jti),
		nonce: String(payload.nonce),
		expiresAt: Number(payload.exp),
		bodyDigest,
	};
}

function recordKey(trust: RuntimeDispatchTrustV3): string {
	return JSON.stringify([
		trust.affinity.workspaceId,
		trust.affinity.deploymentId,
		trust.affinity.mcpAppId,
		trust.affinity.generationId,
		trust.affinity.generationNumber,
		trust.affinity.runtimeInstallationId,
	]);
}

function preparedEvidence(trust: RuntimeDispatchTrustV3, now: number): PublisherRuntimeTrustPreparedEvidenceV3 {
	const withoutHash = {
		protocol_version: 3 as const,
		runtime_installation_id: trust.affinity.runtimeInstallationId,
		generation_id: trust.affinity.generationId,
		generation_number: trust.affinity.generationNumber,
		state: 'PREPARED' as const,
		runtime_dispatch_trust_hash: canonicalHash(trust),
		prepared_at: now,
	};
	return Object.freeze({ ...withoutHash, provisioning_evidence_hash: canonicalHash(withoutHash) });
}

function activeEvidence(
	trust: RuntimeDispatchTrustV3,
	prepared: PublisherRuntimeTrustPreparedEvidenceV3,
	now: number,
): PublisherRuntimeTrustActiveEvidenceV3 {
	const withoutHash = {
		protocol_version: 3 as const,
		runtime_installation_id: trust.affinity.runtimeInstallationId,
		generation_id: trust.affinity.generationId,
		generation_number: trust.affinity.generationNumber,
		state: 'ACTIVE' as const,
		runtime_dispatch_trust_hash: canonicalHash(trust),
		prepared_at: prepared.prepared_at,
		activated_at: now,
	};
	return Object.freeze({ ...withoutHash, provisioning_evidence_hash: canonicalHash(withoutHash) });
}

function emptyState(): DurableStateV3 {
	return {
		protocolVersion: 3,
		records: {},
		provisioningJtis: {},
		provisioningNonces: {},
		dispatchJtis: {},
		dispatchNonces: {},
	};
}

/**
 * Crash-safe atomic file store for exactly one Node process. It deliberately
 * rejects every other deployment mode: multiple replicas require an external
 * transactional store implementing PublisherRuntimeTrustDurableStoreV3.
 */
export class SingleProcessFilePublisherRuntimeTrustStoreV3 implements PublisherRuntimeTrustDurableStoreV3 {
	private queue: Promise<void> = Promise.resolve();
	private readonly lockPath: string;
	private readonly lockNonce = crypto.randomUUID();
	private lockFd: number;
	private readonly exitCleanup: () => void;

	constructor(private readonly options: Readonly<{ filePath: string; deploymentMode: 'single-process' }>) {
		if (options.deploymentMode !== 'single-process' || !path.isAbsolute(options.filePath)) {
			throw new Error('publisher_runtime_trust_store_configuration_invalid');
		}
		const directory = path.dirname(options.filePath);
		fsSync.mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.assertSafeDirectorySync(directory);
		this.lockPath = `${options.filePath}.lock`;
		this.lockFd = this.acquireProcessLockSync();
		this.exitCleanup = () => this.releaseProcessLockSync();
		process.once('exit', this.exitCleanup);
	}

	private assertSafeDirectorySync(directory: string): void {
		const stat = fsSync.lstatSync(directory);
		const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
		const gid = typeof process.getgid === 'function' ? process.getgid() : stat.gid;
		if (!stat.isDirectory() || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o777) !== 0o700 ||
			fsSync.realpathSync(directory) !== directory) {
			throw new Error('publisher_runtime_trust_store_permissions_invalid');
		}
	}

	private acquireProcessLockSync(): number {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				const fd = fsSync.openSync(this.lockPath, 'wx', 0o600);
				fsSync.writeFileSync(fd, `${canonical({ nonce: this.lockNonce, pid: process.pid })}\n`, 'utf8');
				fsSync.fsyncSync(fd);
				return fd;
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
				let ownerPid = -1;
				try {
					const lock = JSON.parse(fsSync.readFileSync(this.lockPath, 'utf8')) as { pid?: unknown };
					if (Number.isSafeInteger(lock.pid) && Number(lock.pid) > 0) ownerPid = Number(lock.pid);
				} catch {
					throw new Error('publisher_runtime_trust_store_lock_invalid');
				}
				if (ownerPid < 1) throw new Error('publisher_runtime_trust_store_lock_invalid');
				try {
					process.kill(ownerPid, 0);
					throw new Error('publisher_runtime_trust_store_already_in_use');
				} catch (probe: unknown) {
					if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
				}
				try {
					const stalePath = `${this.lockPath}.stale.${crypto.randomUUID()}`;
					fsSync.renameSync(this.lockPath, stalePath);
					fsSync.unlinkSync(stalePath);
				} catch (renameError: unknown) {
					if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
				}
			}
		}
		throw new Error('publisher_runtime_trust_store_lock_invalid');
	}

	private releaseProcessLockSync(): void {
		if (this.lockFd < 0) return;
		try { fsSync.closeSync(this.lockFd); } catch { /* fail closed on the next open */ }
		this.lockFd = -1;
		try {
			const current = JSON.parse(fsSync.readFileSync(this.lockPath, 'utf8')) as { nonce?: unknown; pid?: unknown };
			if (current.nonce === this.lockNonce && current.pid === process.pid) fsSync.unlinkSync(this.lockPath);
		} catch { /* a missing or changed lock must never be removed */ }
	}

	async close(): Promise<void> {
		await this.queue;
		process.removeListener('exit', this.exitCleanup);
		this.releaseProcessLockSync();
	}

	private async exclusive<T>(callback: (state: DurableStateV3) => Promise<{ result: T; dirty: boolean }> | { result: T; dirty: boolean }): Promise<T> {
		let release!: () => void;
		const previous = this.queue;
		this.queue = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		try {
			let state = emptyState();
			try {
				const stat = await fs.lstat(this.options.filePath);
				const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
				const gid = typeof process.getgid === 'function' ? process.getgid() : stat.gid;
				if (!stat.isFile() || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o777) !== 0o600 ||
					(await fs.realpath(this.options.filePath)) !== this.options.filePath) {
					throw new Error('publisher_runtime_trust_store_permissions_invalid');
				}
				const parsed = JSON.parse(await fs.readFile(this.options.filePath, 'utf8')) as unknown;
				if (!isRecord(parsed) || parsed.protocolVersion !== 3 || !isRecord(parsed.records) ||
					!isRecord(parsed.provisioningJtis) || !isRecord(parsed.provisioningNonces) ||
					!isRecord(parsed.dispatchJtis) || !isRecord(parsed.dispatchNonces)) {
					throw new Error('publisher_runtime_trust_store_corrupt');
				}
				state = parsed as unknown as DurableStateV3;
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
			}
			const outcome = await callback(state);
			if (outcome.dirty) await this.persist(state);
			return outcome.result;
		} finally {
			release();
		}
	}

	private async persist(state: DurableStateV3): Promise<void> {
		const directory = path.dirname(this.options.filePath);
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		this.assertSafeDirectorySync(directory);
		const temporary = `${this.options.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
		const handle = await fs.open(temporary, 'wx', 0o600);
		try {
			await handle.writeFile(`${canonical(state)}\n`, 'utf8');
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await fs.rename(temporary, this.options.filePath);
			await fs.chmod(this.options.filePath, 0o600);
			const directoryHandle = await fs.open(directory, 'r');
			try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
		} catch (error) {
			await fs.rm(temporary, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	async apply(input: PublisherRuntimeTrustStoreMutationV3): Promise<PublisherRuntimeTrustEvidenceV3> {
		return this.exclusive((state) => {
			for (const [key, value] of Object.entries(state.provisioningJtis)) if (value.expiresAt <= input.now) delete state.provisioningJtis[key];
			for (const [key, value] of Object.entries(state.provisioningNonces)) if (value.expiresAt <= input.now) delete state.provisioningNonces[key];
			const jtiKey = JSON.stringify([input.proof.issuer, input.proof.jti]);
			const nonceKey = JSON.stringify([input.proof.issuer, input.proof.nonce]);
			const priorJti = state.provisioningJtis[jtiKey];
			const priorNonce = state.provisioningNonces[nonceKey];
			if ((priorJti && priorJti.bodyDigest !== input.bodyDigest) || (priorNonce && priorNonce.bodyDigest !== input.bodyDigest)) {
				throw new Error('publisher_runtime_trust_replay_conflict');
			}
			const key = recordKey(input.trust);
			const existing = state.records[key];
			let evidence: PublisherRuntimeTrustEvidenceV3;
			if (input.operation === 'PREPARE') {
				if (input.trust.affinity.runtimeResourceInventoryHash !== undefined ||
					input.trust.affinity.runtimeApprovalReceiptHash !== undefined ||
					input.trust.affinity.runtimeAuthorizationEpoch !== undefined) {
					throw new Error('publisher_runtime_trust_transition_conflict');
				}
				if (input.portalArtifactsExpired && !existing) {
					throw new Error('publisher_runtime_trust_artifact_invalid');
				}
				if (existing) {
					if (existing.prepareBodyDigest !== input.bodyDigest || existing.portalArtifactsHash !== input.portalArtifactsHash ||
						existing.provisioningUrl !== input.provisioningUrl || canonical(existing.preparedTrust) !== canonical(input.trust)) {
						throw new Error('publisher_runtime_trust_transition_conflict');
					}
					evidence = existing.preparedEvidence;
				} else {
					const prepared = preparedEvidence(input.trust, input.now);
					state.records[key] = {
						key,
						provisioningUrl: input.provisioningUrl,
						mcpAppId: input.mcpAppId,
						portalArtifactsHash: input.portalArtifactsHash,
						prepareBodyDigest: input.bodyDigest,
						preparedTrust: input.trust,
						preparedEvidence: prepared,
					};
					evidence = prepared;
				}
			} else {
				if (!existing || canonical(existing.preparedTrust.hubPublicJwk) !== canonical(input.trust.hubPublicJwk) ||
					existing.preparedTrust.hubKid !== input.trust.hubKid || existing.portalArtifactsHash !== input.portalArtifactsHash ||
					existing.provisioningUrl !== input.provisioningUrl || !HASH.test(String(input.trust.affinity.runtimeResourceInventoryHash)) ||
					!HASH.test(String(input.trust.affinity.runtimeApprovalReceiptHash)) ||
					!positiveInteger(input.trust.affinity.runtimeAuthorizationEpoch)) {
					throw new Error('publisher_runtime_trust_transition_conflict');
				}
				const stableTrust = {
					...input.trust,
					affinity: Object.fromEntries(Object.entries(input.trust.affinity).filter(([key]) =>
						!['runtimeResourceInventoryHash', 'runtimeApprovalReceiptHash', 'runtimeAuthorizationEpoch'].includes(key))),
				} as RuntimeDispatchTrustV3;
				if (canonical(stableTrust) !== canonical(existing.preparedTrust)) throw new Error('publisher_runtime_trust_transition_conflict');
				if (existing.activeEvidence) {
					if (existing.activateBodyDigest !== input.bodyDigest || canonical(existing.activeTrust) !== canonical(input.trust)) {
						throw new Error('publisher_runtime_trust_transition_conflict');
					}
					evidence = existing.activeEvidence;
				} else {
					const active = activeEvidence(input.trust, existing.preparedEvidence, input.now);
					existing.activateBodyDigest = input.bodyDigest;
					existing.activeTrust = input.trust;
					existing.activeEvidence = active;
					evidence = active;
				}
			}
			state.provisioningJtis[jtiKey] = { bodyDigest: input.bodyDigest, expiresAt: input.proof.expiresAt };
			state.provisioningNonces[nonceKey] = { bodyDigest: input.bodyDigest, expiresAt: input.proof.expiresAt };
			return { result: evidence, dirty: true };
		});
	}

	async loadActive(hint: RuntimeDispatchTrustHintV3): Promise<RuntimeDispatchTrustV3> {
		return this.exclusive((state) => {
			const key = JSON.stringify([
				hint.workspaceId, hint.deploymentId, hint.mcpAppId, hint.generationId,
				hint.generationNumber, hint.runtimeInstallationId,
			]);
			const record = state.records[key];
			if (!record?.activeTrust || record.activeTrust.hubKid !== hint.kid || record.activeTrust.affinity.executionMode !== hint.executionMode) {
				throw new Error('publisher_runtime_trust_not_active');
			}
			return { result: Object.freeze(record.activeTrust), dirty: false };
		});
	}

	async resolveDispatchTrust(hint: RuntimeDispatchTrustHintV3): Promise<RuntimeDispatchTrustV3> {
		return this.exclusive((state) => {
			const key = JSON.stringify([
				hint.workspaceId, hint.deploymentId, hint.mcpAppId, hint.generationId,
				hint.generationNumber, hint.runtimeInstallationId,
			]);
			const record = state.records[key];
			if (!record || record.preparedTrust.hubKid !== hint.kid || record.preparedTrust.affinity.executionMode !== hint.executionMode) {
				throw new Error('publisher_runtime_trust_not_found');
			}
			if (record.activeTrust) return { result: Object.freeze(record.activeTrust), dirty: false };
			if (hint.preactivationReadiness === true) return { result: Object.freeze(record.preparedTrust), dirty: false };
			throw new Error('publisher_runtime_trust_not_active');
		});
	}

	async consume(input: RuntimeDispatchReplayInputV3): Promise<boolean> {
		return this.exclusive((state) => {
			for (const [key, expiresAt] of Object.entries(state.dispatchJtis)) if (expiresAt <= input.now) delete state.dispatchJtis[key];
			for (const [key, expiresAt] of Object.entries(state.dispatchNonces)) if (expiresAt <= input.now) delete state.dispatchNonces[key];
			const jtiKey = JSON.stringify([input.issuer, input.jti]);
			const nonceKey = JSON.stringify([input.issuer, input.nonce]);
			if (state.dispatchJtis[jtiKey] || state.dispatchNonces[nonceKey]) return { result: false, dirty: false };
			state.dispatchJtis[jtiKey] = input.expiresAt;
			state.dispatchNonces[nonceKey] = input.expiresAt;
			return { result: true, dirty: true };
		});
	}
}

function parseProvisioningRequest(value: unknown): PublisherRuntimeTrustProvisioningRequestV3 {
	if (!isRecord(value) || !exactKeys(value, [
		'cloud_approval_jws', 'deployment_descriptor_jws', 'execution_grant_jws', 'hub_proof_jws',
		'operation', 'protocol_version', 'runtime_dispatch_trust',
	]) || value.protocol_version !== 3 || !['PREPARE', 'ACTIVATE'].includes(String(value.operation)) ||
		!COMPACT.test(String(value.cloud_approval_jws)) || !COMPACT.test(String(value.execution_grant_jws)) ||
		!COMPACT.test(String(value.deployment_descriptor_jws)) || !COMPACT.test(String(value.hub_proof_jws))) {
		throw new Error('publisher_runtime_trust_request_invalid');
	}
	for (const key of ['cloud_approval_jws', 'execution_grant_jws', 'deployment_descriptor_jws', 'hub_proof_jws']) {
		if (String(value[key]).length > MAX_COMPACT_BYTES) throw new Error('publisher_runtime_trust_request_invalid');
	}
	assertRuntimeDispatchTrustConfigurationV3(value.runtime_dispatch_trust);
	const trust = value.runtime_dispatch_trust;
	if (trust.affinity.executionMode !== 'PUBLISHER_HOSTED') throw new Error('publisher_runtime_trust_request_invalid');
	const dynamic = [trust.affinity.runtimeResourceInventoryHash, trust.affinity.runtimeApprovalReceiptHash, trust.affinity.runtimeAuthorizationEpoch];
	if ((value.operation === 'PREPARE' && dynamic.some((item) => item !== undefined)) ||
		(value.operation === 'ACTIVATE' && dynamic.some((item) => item === undefined))) {
		throw new Error('publisher_runtime_trust_request_invalid');
	}
	return value as unknown as PublisherRuntimeTrustProvisioningRequestV3;
}

export type PublisherRuntimeTrustProvisioningRouterOptionsV3 = Readonly<{
	provisioningUrl: string;
	mcpAppId: string;
	portalJwksResolver: PublisherPortalJwksResolverV3;
	store: PublisherRuntimeTrustDurableStoreV3;
	now?: () => number;
	clockSkewSeconds?: number;
}>;

export function createPublisherRuntimeTrustProvisioningRouterV3(
	options: PublisherRuntimeTrustProvisioningRouterOptionsV3,
): Router {
	const target = assertAbsoluteProvisioningUrl(options.provisioningUrl);
	if (!id(options.mcpAppId) || !options.portalJwksResolver || !options.store) {
		throw new Error('publisher_runtime_trust_configuration_invalid');
	}
	const clockSkewSeconds = options.clockSkewSeconds ?? 5;
	if (!Number.isSafeInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 30) {
		throw new Error('publisher_runtime_trust_configuration_invalid');
	}
	const router = Router();
	router.put(
		target.pathname,
		express.json({
			limit: MAX_PROVISIONING_BODY_BYTES,
			strict: true,
			type: 'application/json',
			verify: (request, _response, bytes) => {
				(request as Request & { publisherRuntimeTrustRawBody?: Buffer }).publisherRuntimeTrustRawBody = Buffer.from(bytes);
			},
		}),
		async (request: Request, response: Response) => {
			try {
				if (request.originalUrl.includes('?') || request.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
					throw new Error('publisher_runtime_trust_request_invalid');
				}
				const body = parseProvisioningRequest(request.body);
				const rawBody = (request as Request & { publisherRuntimeTrustRawBody?: Buffer }).publisherRuntimeTrustRawBody;
				if (!rawBody || rawBody.toString('utf8') !== canonical(body)) {
					throw new Error('publisher_runtime_trust_request_encoding_invalid');
				}
				const now = options.now?.() ?? Math.floor(Date.now() / 1000);
				if (!positiveInteger(now)) throw new Error('publisher_runtime_trust_configuration_invalid');
				// Signature and affinity verification remains mandatory after expiry. The
				// durable store makes the freshness decision atomically with generation
				// state so a crash after remote PREPARE cannot strand provisioning.
				const [approval, execution, descriptor] = await Promise.all([
					verifyPortalArtifact(
						body.cloud_approval_jws, 'cloud-approval', options.portalJwksResolver, now, clockSkewSeconds,
						true,
					),
					verifyPortalArtifact(
						body.execution_grant_jws, 'execution-grant', options.portalJwksResolver, now, clockSkewSeconds,
						true,
					),
					verifyPortalArtifact(
						body.deployment_descriptor_jws,
						'runtime-deployment-descriptor',
						options.portalJwksResolver,
						now,
						clockSkewSeconds,
						true,
					),
				]);
				const portalArtifactsExpired = [approval, execution, descriptor].some(
					(artifact) => artifact.envelope.exp <= now,
				);
				assertPortalChain({
					approval,
					execution,
					descriptor,
					trust: body.runtime_dispatch_trust,
					mcpAppId: options.mcpAppId,
					provisioningUrl: options.provisioningUrl,
				});
				const approvalReceiptHash = canonicalHash(approval.envelope);
				if (
					body.operation === 'ACTIVATE' &&
					(body.runtime_dispatch_trust.affinity.runtimeApprovalReceiptHash !== approvalReceiptHash ||
						body.runtime_dispatch_trust.affinity.runtimeAuthorizationEpoch !== execution.envelope.payload.authorizationEpoch)
				) {
					throw new Error('publisher_runtime_trust_portal_chain_invalid');
				}
				const bodyWithoutProof = {
					protocol_version: body.protocol_version,
					operation: body.operation,
					runtime_dispatch_trust: body.runtime_dispatch_trust,
					cloud_approval_jws: body.cloud_approval_jws,
					execution_grant_jws: body.execution_grant_jws,
					deployment_descriptor_jws: body.deployment_descriptor_jws,
				} as const;
				const proof = verifyHubProof({
					compact: body.hub_proof_jws,
					bodyWithoutProof,
					trust: body.runtime_dispatch_trust,
					provisioningUrl: options.provisioningUrl,
					mcpAppId: options.mcpAppId,
					now,
					clockSkewSeconds,
				});
				const evidence = await options.store.apply({
					operation: body.operation,
					provisioningUrl: options.provisioningUrl,
					mcpAppId: options.mcpAppId,
					trust: body.runtime_dispatch_trust,
					portalArtifactsHash: canonicalHash({
						cloud_approval_jws: body.cloud_approval_jws,
						execution_grant_jws: body.execution_grant_jws,
						deployment_descriptor_jws: body.deployment_descriptor_jws,
					}),
					portalArtifactsExpired,
					bodyDigest: proof.bodyDigest,
					proof,
					now,
				});
				response.status(200).type('application/json').send(canonical(evidence));
			} catch (error: unknown) {
				const code = error instanceof Error ? error.message : 'publisher_runtime_trust_request_invalid';
				const status = code.includes('signature') || code.includes('hub_proof') ? 401 :
					code.includes('conflict') || code.includes('replay') ? 409 : 400;
				response.status(status).json({ error: code });
			}
		},
	);
	return router;
}
