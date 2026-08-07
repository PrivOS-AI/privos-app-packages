import crypto, { type JsonWebKey } from 'node:crypto';

import type { WorkloadBrokerContext } from './workload-identity.js';

const replay = new Map<string, number>();

const RUNTIME_DISPATCH_V3_HEADER_KEYS = ['alg', 'kid', 'privos_protocol', 'typ'] as const;
const RUNTIME_DISPATCH_V3_COMMON_KEYS = [
	'aud',
	'authorizationContext',
	'bodyDigest',
	'deploymentId',
	'executionMode',
	'exp',
	'generationId',
	'generationNumber',
	'htm',
	'htu',
	'iat',
	'iss',
	'jti',
	'manifestDigest',
	'mcpAppId',
	'nonce',
	'protocolVersion',
	'resourceManifestHash',
	'runtimeApprovalReceiptHash',
	'runtimeAuthorizationEpoch',
	'runtimeInstallationId',
	'runtimeResourceInventoryHash',
	'type',
	'workspaceId',
] as const;
const RUNTIME_DISPATCH_V3_ROOM_KEYS = [
	'authorizationBindingId',
	'bindingEpoch',
	'bindingGrantHash',
	'bindingReceiptHash',
	'bindingTokenVersion',
	'roomId',
] as const;
const RUNTIME_DISPATCH_V3_AFFINITY_REQUIRED_KEYS = [
	'workspaceId',
	'deploymentId',
	'mcpAppId',
	'executionMode',
	'generationId',
	'generationNumber',
	'runtimeInstallationId',
	'manifestDigest',
	'resourceManifestHash',
] as const;
const RUNTIME_DISPATCH_V3_AFFINITY_OPTIONAL_KEYS = [
	'runtimeResourceInventoryHash',
	'runtimeApprovalReceiptHash',
	'runtimeAuthorizationEpoch',
] as const;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const RUNTIME_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RUNTIME_MANIFEST_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RUNTIME_NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const DEFAULT_RUNTIME_REPLAY_CAPACITY = 10_000;
const MAX_RUNTIME_COMPACT_BYTES = 32_768;
const UNSIGNED_RUNTIME_INITIALIZE_PARAMS_V3 = Object.freeze({
	protocolVersion: '2025-03-26',
	capabilities: Object.freeze({
		extensions: Object.freeze({
			'io.modelcontextprotocol/ui': Object.freeze({
				mimeTypes: Object.freeze(['text/html;profile=mcp-app']),
			}),
		}),
	}),
	clientInfo: Object.freeze({ name: 'privos-hub', version: '1.0.0' }),
});

export type VerifiedDispatchActor = Readonly<{
	subject: string;
	username?: string;
	roomId?: string;
}>;

export type VerifiedDispatchAssertion = Readonly<{
	jti: string;
	issuedAt: number;
	expiresAt: number;
	actor?: VerifiedDispatchActor;
}>;

export type RuntimeDispatchExecutionModeV3 = 'SELF_HOSTED_LOCAL' | 'PUBLISHER_HOSTED';

export type RuntimeDispatchAffinityV3 = Readonly<{
	workspaceId: string;
	deploymentId: string;
	mcpAppId: string;
	executionMode: RuntimeDispatchExecutionModeV3;
	generationId: string;
	generationNumber: number;
	runtimeInstallationId: string;
	manifestDigest: string;
	resourceManifestHash: string;
	/** Optional post-readiness expectation. The signed assertion always contains this field. */
	runtimeResourceInventoryHash?: string;
	/** Optional post-readiness expectation. The signed assertion always contains this field. */
	runtimeApprovalReceiptHash?: string;
	/** Optional current-state expectation. The signed assertion always contains this field. */
	runtimeAuthorizationEpoch?: number;
}>;

export type RuntimeDispatchTrustV3 = Readonly<{
	hubKid: string;
	hubPublicJwk: JsonWebKey;
	affinity: RuntimeDispatchAffinityV3;
}>;

export type RuntimeDispatchTrustHintV3 = Readonly<{
	kid: string;
	workspaceId: string;
	deploymentId: string;
	mcpAppId: string;
	executionMode: RuntimeDispatchExecutionModeV3;
	generationId: string;
	generationNumber: number;
	runtimeInstallationId: string;
	authorizationContext: 'workspace' | 'room';
	roomId?: string;
	authorizationBindingId?: string;
	/** True only when the actual RPC body is one of the three frozen readiness messages. */
	preactivationReadiness?: true;
}>;

export type RuntimeDispatchReplayInputV3 = Readonly<{
	issuer: string;
	jti: string;
	nonce: string;
	expiresAt: number;
	now: number;
}>;

/** Implementations must atomically return true only when both the JTI and nonce are live-unseen. */
export interface RuntimeDispatchReplayConsumerV3 {
	consume(input: RuntimeDispatchReplayInputV3): boolean | Promise<boolean>;
}

/** Process-local bounded replay protection. Publishers with multiple replicas must inject a shared atomic consumer. */
export class BoundedRuntimeDispatchReplayConsumerV3 implements RuntimeDispatchReplayConsumerV3 {
	private readonly jtis = new Map<string, number>();
	private readonly nonces = new Map<string, number>();

	constructor(private readonly capacity = DEFAULT_RUNTIME_REPLAY_CAPACITY) {
		if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Runtime dispatch replay capacity must be positive.');
	}

	consume(input: RuntimeDispatchReplayInputV3): boolean {
		for (const [key, expiresAt] of this.jtis) {
			if (expiresAt <= input.now) this.jtis.delete(key);
		}
		for (const [key, expiresAt] of this.nonces) {
			if (expiresAt <= input.now) this.nonces.delete(key);
		}
		const jtiKey = JSON.stringify([input.issuer, input.jti]);
		const nonceKey = JSON.stringify([input.issuer, input.nonce]);
		if (this.jtis.has(jtiKey) || this.nonces.has(nonceKey)) return false;
		if (this.jtis.size >= this.capacity) throw new Error('dispatch_assertion_replay_store_full');
		this.jtis.set(jtiKey, input.expiresAt);
		this.nonces.set(nonceKey, input.expiresAt);
		return true;
	}
}

export type RuntimeDispatchTrustResolverV3 = (
	hint: RuntimeDispatchTrustHintV3,
) => RuntimeDispatchTrustV3 | Promise<RuntimeDispatchTrustV3>;

export type RuntimeDispatchSecurityV3 = Readonly<{
	mode: 'required';
	trust: RuntimeDispatchTrustV3 | RuntimeDispatchTrustResolverV3;
	replayConsumer?: RuntimeDispatchReplayConsumerV3;
	/** Unix seconds. Primarily useful for deterministic conformance tests. */
	now?: () => number;
	/** Default 5 seconds. Applies only to future `iat`, never to expiration. */
	clockSkewSeconds?: number;
	/** Explicit pre-activation exception. Never permits tools/call, resources/read, or custom methods. */
	unsignedReadiness?: 'initialize-and-tools-list';
}>;

type CompleteRuntimeDispatchAffinityV3 = RuntimeDispatchAffinityV3 & Readonly<{
	runtimeResourceInventoryHash: string;
	runtimeApprovalReceiptHash: string;
	runtimeAuthorizationEpoch: number;
}>;

type RuntimeDispatchCommonV3 = CompleteRuntimeDispatchAffinityV3 & Readonly<{
	protocolVersion: 3;
	type: 'hub-runtime-dispatch-assertion';
	iss: string;
	aud: string;
	jti: string;
	nonce: string;
	iat: number;
	exp: number;
	authorizationContext: 'workspace' | 'room';
	htm: 'POST';
	htu: '/mcp';
	bodyDigest: string;
}>;

export type VerifiedRuntimeDispatchAssertionV3 =
	| (RuntimeDispatchCommonV3 & Readonly<{ authorizationContext: 'workspace' }>)
	| (RuntimeDispatchCommonV3 &
			Readonly<{
				authorizationContext: 'room';
				roomId: string;
				authorizationBindingId: string;
				bindingReceiptHash: string;
				bindingGrantHash: string;
				bindingEpoch: number;
				bindingTokenVersion: number;
			}>);

export type RuntimeDispatchRelayAuthorizationV3 = Readonly<{
	assertion: string;
	runtimeInstallationId: string;
	authorizationBindingId?: string;
}>;

export type RuntimeDispatchRelayEnvelopeV3 = Readonly<{
	logicalRpc: Record<string, unknown>;
	authorization: RuntimeDispatchRelayAuthorizationV3;
	userMetadata?: unknown;
}>;

const defaultRuntimeReplayConsumer = new BoundedRuntimeDispatchReplayConsumerV3();

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function runtimeId(value: unknown): value is string {
	return typeof value === 'string' && value.length >= 1 && value.length <= 256;
}

function positiveSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 1;
}

function runtimeHash(value: unknown): value is string {
	return typeof value === 'string' && RUNTIME_HASH_PATTERN.test(value);
}

function strictBase64urlDecode(value: string): Buffer {
	if (!value || !BASE64URL_PATTERN.test(value)) throw new Error('dispatch_assertion_invalid');
	const decoded = Buffer.from(value, 'base64url');
	if (decoded.toString('base64url') !== value) throw new Error('dispatch_assertion_invalid');
	return decoded;
}

function parseRuntimeDispatchCompactV3(compact: string): {
	encodedHeader: string;
	encodedPayload: string;
	signature: Buffer;
	header: Record<string, unknown>;
	payload: Record<string, unknown>;
} {
	if (typeof compact !== 'string' || Buffer.byteLength(compact, 'utf8') > MAX_RUNTIME_COMPACT_BYTES) {
		throw new Error('dispatch_assertion_invalid');
	}
	const parts = compact.split('.');
	if (parts.length !== 3 || parts.some((part) => !part)) throw new Error('dispatch_assertion_invalid');
	let header: unknown;
	let payload: unknown;
	const headerBytes = strictBase64urlDecode(parts[0]!);
	const payloadBytes = strictBase64urlDecode(parts[1]!);
	const signature = strictBase64urlDecode(parts[2]!);
	try {
		header = JSON.parse(headerBytes.toString('utf8')) as unknown;
		payload = JSON.parse(payloadBytes.toString('utf8')) as unknown;
	} catch {
		throw new Error('dispatch_assertion_invalid');
	}
	if (!isRecord(header) || !isRecord(payload)) throw new Error('dispatch_assertion_invalid');
	if (
		parts[0] !== Buffer.from(canonical(header), 'utf8').toString('base64url') ||
		parts[1] !== Buffer.from(canonical(payload), 'utf8').toString('base64url')
	) {
		throw new Error('dispatch_assertion_invalid');
	}
	return { encodedHeader: parts[0]!, encodedPayload: parts[1]!, signature, header, payload };
}

function assertRuntimeDispatchHeaderV3(header: Record<string, unknown>): asserts header is Record<string, unknown> & {
	alg: 'ES256'; kid: string; typ: 'privos-hub-runtime-dispatch+jws'; privos_protocol: 3;
} {
	if (
		!exactKeys(header, RUNTIME_DISPATCH_V3_HEADER_KEYS) ||
		header.alg !== 'ES256' ||
		header.typ !== 'privos-hub-runtime-dispatch+jws' ||
		header.privos_protocol !== 3 ||
		!runtimeId(header.kid)
	) {
		throw new Error('dispatch_assertion_invalid');
	}
}

function assertRuntimeDispatchPayloadV3(payload: Record<string, unknown>): asserts payload is Record<string, unknown> & RuntimeDispatchCommonV3 {
	const context = payload.authorizationContext;
	const expectedKeys = context === 'room'
		? [...RUNTIME_DISPATCH_V3_COMMON_KEYS, ...RUNTIME_DISPATCH_V3_ROOM_KEYS]
		: RUNTIME_DISPATCH_V3_COMMON_KEYS;
	if (!exactKeys(payload, expectedKeys)) throw new Error('dispatch_assertion_invalid');
	if (
		payload.protocolVersion !== 3 ||
		payload.type !== 'hub-runtime-dispatch-assertion' ||
		!runtimeId(payload.iss) ||
		!runtimeId(payload.aud) ||
		!runtimeId(payload.jti) ||
		typeof payload.nonce !== 'string' ||
		!RUNTIME_NONCE_PATTERN.test(payload.nonce) ||
		!positiveSafeInteger(payload.iat) ||
		!positiveSafeInteger(payload.exp) ||
		!runtimeId(payload.workspaceId) ||
		!runtimeId(payload.deploymentId) ||
		!runtimeId(payload.mcpAppId) ||
		!['SELF_HOSTED_LOCAL', 'PUBLISHER_HOSTED'].includes(String(payload.executionMode)) ||
		!runtimeId(payload.generationId) ||
		!positiveSafeInteger(payload.generationNumber) ||
		!runtimeId(payload.runtimeInstallationId) ||
		typeof payload.manifestDigest !== 'string' ||
		!RUNTIME_MANIFEST_DIGEST_PATTERN.test(payload.manifestDigest) ||
		!runtimeHash(payload.resourceManifestHash) ||
		!runtimeHash(payload.runtimeResourceInventoryHash) ||
		!runtimeHash(payload.runtimeApprovalReceiptHash) ||
		!positiveSafeInteger(payload.runtimeAuthorizationEpoch) ||
		(context !== 'workspace' && context !== 'room') ||
		payload.htm !== 'POST' ||
		payload.htu !== '/mcp' ||
		!runtimeHash(payload.bodyDigest)
	) {
		throw new Error('dispatch_assertion_invalid');
	}
	if (context === 'room') {
		if (
			!runtimeId(payload.roomId) ||
			!runtimeId(payload.authorizationBindingId) ||
			!runtimeHash(payload.bindingReceiptHash) ||
			!runtimeHash(payload.bindingGrantHash) ||
			!positiveSafeInteger(payload.bindingEpoch) ||
			!positiveSafeInteger(payload.bindingTokenVersion)
		) {
			throw new Error('dispatch_assertion_invalid');
		}
	}
}

function runtimeDispatchTrustHintV3(
	header: { kid: string },
	payload: Record<string, unknown> & RuntimeDispatchCommonV3,
	body: unknown,
): RuntimeDispatchTrustHintV3 {
	return Object.freeze({
		kid: header.kid,
		workspaceId: payload.workspaceId,
		deploymentId: payload.deploymentId,
		mcpAppId: payload.mcpAppId,
		executionMode: payload.executionMode,
		generationId: payload.generationId,
		generationNumber: payload.generationNumber,
		runtimeInstallationId: payload.runtimeInstallationId,
		authorizationContext: payload.authorizationContext,
		...(isExactRuntimeReadinessRpcV3(body) ? { preactivationReadiness: true as const } : {}),
		...(payload.authorizationContext === 'room'
			? { roomId: String(payload.roomId), authorizationBindingId: String(payload.authorizationBindingId) }
			: {}),
	});
}

export function assertRuntimeDispatchTrustConfigurationV3(
	value: unknown,
): asserts value is RuntimeDispatchTrustV3 {
	if (!isRecord(value) || !exactKeys(value, ['affinity', 'hubKid', 'hubPublicJwk'])) {
		throw new Error('runtime_dispatch_trust_invalid');
	}
	const jwk = value.hubPublicJwk;
	const affinity = value.affinity;
	if (
		typeof value.hubKid !== 'string' ||
		!RUNTIME_HASH_PATTERN.test(value.hubKid) ||
		!isRecord(jwk) ||
		!exactKeys(jwk, ['crv', 'kty', 'x', 'y']) ||
		jwk.kty !== 'EC' ||
		jwk.crv !== 'P-256' ||
		typeof jwk.x !== 'string' ||
		typeof jwk.y !== 'string' ||
		!RUNTIME_HASH_PATTERN.test(jwk.x) ||
		!RUNTIME_HASH_PATTERN.test(jwk.y) ||
		!isRecord(affinity)
	) {
		throw new Error('runtime_dispatch_trust_invalid');
	}
	const optionalKeys = RUNTIME_DISPATCH_V3_AFFINITY_OPTIONAL_KEYS.filter((key) => affinity[key] !== undefined);
	let canonicalPublicKey = false;
	try {
		const x = Buffer.from(String(jwk.x), 'base64url');
		const y = Buffer.from(String(jwk.y), 'base64url');
		const key = crypto.createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
		const exported = key.export({ format: 'jwk' });
		canonicalPublicKey =
			x.byteLength === 32 &&
			y.byteLength === 32 &&
			x.toString('base64url') === jwk.x &&
			y.toString('base64url') === jwk.y &&
			exported.kty === 'EC' &&
			exported.crv === 'P-256' &&
			exported.x === jwk.x &&
			exported.y === jwk.y &&
			!exported.d;
	} catch {
		canonicalPublicKey = false;
	}
	if (
		!exactKeys(affinity, [...RUNTIME_DISPATCH_V3_AFFINITY_REQUIRED_KEYS, ...optionalKeys]) ||
		!runtimeId(affinity.workspaceId) ||
		!runtimeId(affinity.deploymentId) ||
		!runtimeId(affinity.mcpAppId) ||
		!['SELF_HOSTED_LOCAL', 'PUBLISHER_HOSTED'].includes(String(affinity.executionMode)) ||
		!runtimeId(affinity.generationId) ||
		!positiveSafeInteger(affinity.generationNumber) ||
		!runtimeId(affinity.runtimeInstallationId) ||
		typeof affinity.manifestDigest !== 'string' ||
		!RUNTIME_MANIFEST_DIGEST_PATTERN.test(affinity.manifestDigest) ||
		!runtimeHash(affinity.resourceManifestHash) ||
		(affinity.runtimeResourceInventoryHash !== undefined && !runtimeHash(affinity.runtimeResourceInventoryHash)) ||
		(affinity.runtimeApprovalReceiptHash !== undefined && !runtimeHash(affinity.runtimeApprovalReceiptHash)) ||
		(affinity.runtimeAuthorizationEpoch !== undefined && !positiveSafeInteger(affinity.runtimeAuthorizationEpoch)) ||
		!canonicalPublicKey ||
		crypto.createHash('sha256').update(canonical({
			crv: jwk.crv,
			kty: jwk.kty,
			x: jwk.x,
			y: jwk.y,
		})).digest('base64url') !== value.hubKid
	) {
		throw new Error('runtime_dispatch_trust_invalid');
	}
}

export function parseRuntimeDispatchTrustV3Json(raw: string): RuntimeDispatchTrustV3 {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new Error('runtime_dispatch_trust_invalid');
	}
	assertRuntimeDispatchTrustConfigurationV3(parsed);
	return Object.freeze({
		hubKid: parsed.hubKid,
		hubPublicJwk: Object.freeze({ ...parsed.hubPublicJwk }),
		affinity: Object.freeze({ ...parsed.affinity }),
	});
}

function assertRuntimeDispatchTrustMatchesV3(
	trust: RuntimeDispatchTrustV3,
	header: { kid: string },
	payload: Record<string, unknown> & RuntimeDispatchCommonV3,
): void {
	try {
		assertRuntimeDispatchTrustConfigurationV3(trust);
	} catch {
		throw new Error('dispatch_assertion_invalid');
	}
	if (trust.hubKid !== header.kid) throw new Error('dispatch_assertion_invalid');
	if (
		RUNTIME_DISPATCH_V3_AFFINITY_REQUIRED_KEYS.some((key) => trust.affinity[key] !== payload[key]) ||
		RUNTIME_DISPATCH_V3_AFFINITY_OPTIONAL_KEYS.some((key) =>
			trust.affinity[key] !== undefined && trust.affinity[key] !== payload[key])
	) {
		throw new Error('dispatch_assertion_binding_mismatch');
	}
}

export function sha256RuntimeDispatchBodyV3(body: unknown): string {
	return crypto.createHash('sha256').update(canonical(body), 'utf8').digest('base64url');
}

export function isUnsignedRuntimeReadinessRpcV3(body: unknown, security: RuntimeDispatchSecurityV3): boolean {
	if (
		security.mode !== 'required' ||
		security.unsignedReadiness !== 'initialize-and-tools-list' ||
		!isExactRuntimeReadinessRpcV3(body)
	) return false;
	return true;
}

/** Exact readiness classification; it grants no authority without a verified signed assertion. */
export function isExactRuntimeReadinessRpcV3(body: unknown): boolean {
	if (!isRecord(body)) return false;
	if (body.method === 'initialize') {
		return exactKeys(body, ['id', 'jsonrpc', 'method', 'params']) &&
			body.jsonrpc === '2.0' &&
			body.id === 1 &&
			canonical(body.params) === canonical(UNSIGNED_RUNTIME_INITIALIZE_PARAMS_V3);
	}
	if (body.method === 'notifications/initialized') {
		return exactKeys(body, ['jsonrpc', 'method']) && body.jsonrpc === '2.0';
	}
	if (body.method === 'tools/list') {
		return exactKeys(body, ['id', 'jsonrpc', 'method', 'params']) &&
			body.jsonrpc === '2.0' &&
			body.id === 2 &&
			isRecord(body.params) &&
			exactKeys(body.params, []);
	}
	return false;
}

export async function verifyRuntimeDispatchAssertionV3(input: {
	compact: string;
	body: unknown;
	security: RuntimeDispatchSecurityV3;
	/** When present, wrapper affinity is checked before the assertion is consumed for replay. */
	relayAuthorization?: RuntimeDispatchRelayAuthorizationV3;
	now?: number;
}): Promise<VerifiedRuntimeDispatchAssertionV3> {
	if (!input.security || input.security.mode !== 'required') throw new Error('dispatch_assertion_invalid');
	const parsed = parseRuntimeDispatchCompactV3(input.compact);
	assertRuntimeDispatchHeaderV3(parsed.header);
	assertRuntimeDispatchPayloadV3(parsed.payload);
	const trust = typeof input.security.trust === 'function'
		? await input.security.trust(runtimeDispatchTrustHintV3(parsed.header, parsed.payload, input.body))
		: input.security.trust;
	assertRuntimeDispatchTrustMatchesV3(trust, parsed.header, parsed.payload);
	let key: crypto.KeyObject;
	try {
		key = crypto.createPublicKey({ key: trust.hubPublicJwk, format: 'jwk' });
	} catch {
		throw new Error('dispatch_assertion_invalid');
	}
	if (
		parsed.signature.byteLength !== 64 ||
		!crypto.verify(
			'sha256',
			Buffer.from(`${parsed.encodedHeader}.${parsed.encodedPayload}`, 'ascii'),
			{ key, dsaEncoding: 'ieee-p1363' },
			parsed.signature,
		)
	) {
		throw new Error('dispatch_assertion_invalid');
	}
	if (
		parsed.payload.iss !== `hub:${parsed.payload.deploymentId}` ||
		parsed.payload.aud !== `mcp-runtime:${parsed.payload.mcpAppId}`
	) {
		throw new Error('dispatch_assertion_binding_mismatch');
	}
	const now = input.now ?? input.security.now?.() ?? Math.floor(Date.now() / 1_000);
	const skew = input.security.clockSkewSeconds ?? 5;
	if (!Number.isSafeInteger(now) || now < 1 || !Number.isSafeInteger(skew) || skew < 0 || skew > 30) {
		throw new Error('dispatch_assertion_invalid');
	}
	if (
		parsed.payload.iat > now + skew ||
		parsed.payload.exp <= now ||
		parsed.payload.exp <= parsed.payload.iat ||
		parsed.payload.exp - parsed.payload.iat > 30
	) {
		throw new Error('dispatch_assertion_time_invalid');
	}
	if (parsed.payload.bodyDigest !== sha256RuntimeDispatchBodyV3(input.body)) {
		throw new Error('dispatch_assertion_body_mismatch');
	}
	if (input.relayAuthorization) {
		assertRuntimeDispatchRelayAffinityV3(
			input.relayAuthorization,
			parsed.payload as VerifiedRuntimeDispatchAssertionV3,
		);
	}
	const consumed = await (input.security.replayConsumer ?? defaultRuntimeReplayConsumer).consume({
		issuer: parsed.payload.iss,
		jti: parsed.payload.jti,
		nonce: parsed.payload.nonce,
		expiresAt: parsed.payload.exp,
		now,
	});
	if (!consumed) throw new Error('dispatch_assertion_replayed');
	return Object.freeze({ ...parsed.payload }) as VerifiedRuntimeDispatchAssertionV3;
}

export function extractRuntimeDispatchRelayEnvelopeV3(value: unknown): RuntimeDispatchRelayEnvelopeV3 {
	if (!isRecord(value) || !isRecord(value.params) || !isRecord(value.params._meta)) {
		throw new Error('dispatch_assertion_missing');
	}
	const meta = value.params._meta;
	const authorization = meta.privosAuthorization;
	if (!isRecord(authorization)) throw new Error('dispatch_assertion_missing');
	const allowedAuthorizationKeys = authorization.authorizationBindingId === undefined
		? ['assertion', 'runtimeInstallationId']
		: ['assertion', 'authorizationBindingId', 'runtimeInstallationId'];
	if (
		!exactKeys(authorization, allowedAuthorizationKeys) ||
		typeof authorization.assertion !== 'string' ||
		!authorization.assertion ||
		!runtimeId(authorization.runtimeInstallationId) ||
		(authorization.authorizationBindingId !== undefined && !runtimeId(authorization.authorizationBindingId))
	) {
		throw new Error('dispatch_assertion_invalid');
	}
	const logicalMeta = { ...meta };
	delete logicalMeta.privosAuthorization;
	delete logicalMeta.privosUser;
	const logicalParams = { ...value.params };
	if (Object.keys(logicalMeta).length === 0) delete logicalParams._meta;
	else logicalParams._meta = logicalMeta;
	const logicalRpc = { ...value, params: logicalParams };
	return Object.freeze({
		logicalRpc,
		authorization: Object.freeze({
			assertion: authorization.assertion,
			runtimeInstallationId: authorization.runtimeInstallationId,
			...(authorization.authorizationBindingId !== undefined
				? { authorizationBindingId: authorization.authorizationBindingId }
				: {}),
		}),
		...(Object.prototype.hasOwnProperty.call(meta, 'privosUser') ? { userMetadata: meta.privosUser } : {}),
	});
}

export function assertRuntimeDispatchRelayAffinityV3(
	authorization: RuntimeDispatchRelayAuthorizationV3,
	verified: VerifiedRuntimeDispatchAssertionV3,
): void {
	if (
		authorization.runtimeInstallationId !== verified.runtimeInstallationId ||
		(verified.authorizationContext === 'workspace' && authorization.authorizationBindingId !== undefined) ||
		(verified.authorizationContext === 'room' && authorization.authorizationBindingId !== verified.authorizationBindingId)
	) {
		throw new Error('dispatch_assertion_binding_mismatch');
	}
}

function canonical(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

const CLUSTER_DISPATCH_V3_COMMON_KEYS = [
	'aud',
	'authorizationContext',
	'bodyDigest',
	'clusterAppId',
	'clusterId',
	'deploymentId',
	'exp',
	'generationId',
	'generationNumber',
	'htm',
	'htu',
	'iat',
	'iss',
	'jti',
	'manifestDigest',
	'mcpAppId',
	'nonce',
	'protocolVersion',
	'resourceManifestHash',
	'runtimeApprovalReceiptHash',
	'runtimeGrantEpoch',
	'runtimeInstallationId',
	'runtimeResourceInventoryHash',
	'type',
	'workspaceId',
] as const;

const CLUSTER_DISPATCH_V3_ROOM_KEYS = [
	...CLUSTER_DISPATCH_V3_COMMON_KEYS,
	'authorizationBindingId',
	'bindingEpoch',
	'bindingReceiptHash',
	'roomId',
] as const;

/**
 * Claims a Hub may add that an older app would not have known to expect.
 *
 * They are optional on the wire in both directions: a Hub that predates the
 * claim signs none, and a Hub only enriches an assertion for an app whose
 * manifest declared it can read one. Absence is therefore normal forever and
 * must never be an error.
 */
const CLUSTER_DISPATCH_V3_OPTIONAL_KEYS = ['actor'] as const;

const CLUSTER_DISPATCH_V3_ACTOR_KEYS = ['subject', 'username', 'roomId'] as const;

function validClusterDispatchActorV3(value: unknown): value is VerifiedDispatchActor {
	if (!isRecord(value)) return false;
	const extra = Object.keys(value).filter(
		(key) => !(CLUSTER_DISPATCH_V3_ACTOR_KEYS as readonly string[]).includes(key),
	);
	return (
		extra.length === 0 &&
		typeof value.subject === 'string' &&
		value.subject.length >= 1 &&
		(value.username === undefined || typeof value.username === 'string') &&
		(value.roomId === undefined || typeof value.roomId === 'string')
	);
}

export type VerifiedClusterDispatchAssertionV3 = Readonly<{
	jti: string;
	issuedAt: number;
	expiresAt: number;
	authorizationContext: 'workspace' | 'room';
	roomId?: string;
	authorizationBindingId?: string;
	/**
	 * Who the Hub says initiated this dispatch, when the app declared
	 * `capabilities.verifiedActor` and a user actually initiated it.
	 *
	 * Identity metadata to display or attribute with — it grants nothing. What
	 * this dispatch is allowed to reach is decided by the room binding and the
	 * approved permissions, never by this field.
	 */
	actor?: VerifiedDispatchActor;
}>;

/**
 * Verify the dispatch a Hub routes to an App Library runtime through its
 * cluster. The assertion reuses the replica `typ` but carries generation
 * affinity instead of replica affinity, so every field is checked against the
 * generation the node attested — the runtime trusts no claim the broker did
 * not already bind it to.
 */
export function verifyClusterDispatchAssertionV3(input: {
	compact: string;
	body: unknown;
	context: WorkloadBrokerContext;
	now?: number;
}): VerifiedClusterDispatchAssertionV3 {
	const generation = input.context.binding.generation;
	if (!generation) throw new Error('dispatch_assertion_invalid');
	const parts = input.compact.split('.');
	if (parts.length !== 3) throw new Error('dispatch_assertion_invalid');
	let header: Record<string, unknown>;
	let payload: Record<string, unknown>;
	try {
		header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
		payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
	} catch {
		throw new Error('dispatch_assertion_invalid');
	}
	if (
		!isRecord(header) ||
		!isRecord(payload) ||
		!exactKeys(header, RUNTIME_DISPATCH_V3_HEADER_KEYS) ||
		header.alg !== 'ES256' ||
		header.typ !== 'privos-hub-dispatch+jws' ||
		header.privos_protocol !== 3 ||
		header.kid !== input.context.hubKid
	) {
		throw new Error('dispatch_assertion_invalid');
	}
	const key = crypto.createPublicKey({ key: input.context.hubPublicJwk, format: 'jwk' });
	if (!crypto.verify(
		'sha256',
		Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
		{ key, dsaEncoding: 'ieee-p1363' },
		Buffer.from(parts[2]!, 'base64url'),
	)) throw new Error('dispatch_assertion_invalid');
	const now = input.now ?? Math.floor(Date.now() / 1000);
	const room = payload.authorizationContext === 'room';
	const presentOptionalKeys = CLUSTER_DISPATCH_V3_OPTIONAL_KEYS.filter((key) => payload[key] !== undefined);
	if (
		!exactKeys(payload, [
			...(room ? CLUSTER_DISPATCH_V3_ROOM_KEYS : CLUSTER_DISPATCH_V3_COMMON_KEYS),
			...presentOptionalKeys,
		]) ||
		(payload.actor !== undefined && !validClusterDispatchActorV3(payload.actor)) ||
		payload.protocolVersion !== 3 ||
		payload.type !== 'hub-dispatch-assertion' ||
		payload.aud !== 'privos-mcp-app' ||
		payload.htm !== 'POST' ||
		payload.htu !== '/mcp' ||
		typeof payload.jti !== 'string' ||
		typeof payload.iss !== 'string' ||
		typeof payload.nonce !== 'string' ||
		!Number.isInteger(payload.iat) ||
		!Number.isInteger(payload.exp) ||
		Number(payload.iat) > now + 5 ||
		Number(payload.exp) < now ||
		Number(payload.exp) - Number(payload.iat) > 30
	) {
		throw new Error('dispatch_assertion_invalid');
	}
	if (
		payload.workspaceId !== input.context.binding.workspaceId ||
		payload.runtimeInstallationId !== input.context.binding.installationId ||
		payload.mcpAppId !== input.context.binding.mcpAppId ||
		payload.runtimeApprovalReceiptHash !== input.context.binding.receiptHash ||
		payload.runtimeGrantEpoch !== input.context.binding.grantEpoch ||
		payload.clusterId !== generation.clusterId ||
		payload.deploymentId !== generation.deploymentId ||
		payload.generationId !== generation.generationId ||
		payload.generationNumber !== generation.generationNumber ||
		payload.manifestDigest !== generation.manifestDigest ||
		payload.resourceManifestHash !== generation.resourceManifestHash ||
		payload.runtimeResourceInventoryHash !== generation.runtimeResourceInventoryHash ||
		typeof payload.clusterAppId !== 'string' ||
		payload.clusterAppId.length === 0 ||
		payload.bodyDigest !== sha256RuntimeDispatchBodyV3(input.body)
	) {
		throw new Error('dispatch_assertion_binding_mismatch');
	}
	if (room && (
		typeof payload.roomId !== 'string' ||
		payload.roomId.length === 0 ||
		typeof payload.authorizationBindingId !== 'string' ||
		payload.authorizationBindingId.length === 0 ||
		typeof payload.bindingReceiptHash !== 'string' ||
		!Number.isInteger(payload.bindingEpoch) ||
		Number(payload.bindingEpoch) < 1
	)) {
		throw new Error('dispatch_assertion_binding_mismatch');
	}
	if (!room && payload.authorizationContext !== 'workspace') throw new Error('dispatch_assertion_invalid');
	for (const [jti, exp] of replay) if (exp < now) replay.delete(jti);
	if (replay.has(payload.jti)) throw new Error('dispatch_assertion_replayed');
	replay.set(payload.jti, Number(payload.exp));
	return Object.freeze({
		jti: payload.jti,
		issuedAt: Number(payload.iat),
		expiresAt: Number(payload.exp),
		authorizationContext: room ? 'room' : 'workspace',
		...(room ? { roomId: String(payload.roomId), authorizationBindingId: String(payload.authorizationBindingId) } : {}),
		...(payload.actor !== undefined ? { actor: Object.freeze({ ...(payload.actor as VerifiedDispatchActor) }) } : {}),
	});
}

export function verifyDispatchAssertion(input: {
	compact: string;
	body: unknown;
	context: WorkloadBrokerContext;
	now?: number;
}): VerifiedDispatchAssertion {
	const parts = input.compact.split('.');
	if (parts.length !== 3) throw new Error('dispatch_assertion_invalid');
	const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
	const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
	if (header.alg !== 'ES256' || header.typ !== 'privos-hub-dispatch+jws' || header.kid !== input.context.hubKid) {
		throw new Error('dispatch_assertion_invalid');
	}
	const key = crypto.createPublicKey({ key: input.context.hubPublicJwk, format: 'jwk' });
	if (!crypto.verify(
		'sha256',
		Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
		{ key, dsaEncoding: 'ieee-p1363' },
		Buffer.from(parts[2]!, 'base64url'),
	)) throw new Error('dispatch_assertion_invalid');
	const now = input.now ?? Math.floor(Date.now() / 1000);
	if (
		payload.type !== 'hub-dispatch-assertion' ||
		payload.aud !== 'privos-mcp-app' ||
		payload.htm !== 'POST' ||
		payload.htu !== '/mcp' ||
		!Number.isInteger(payload.iat) ||
		!Number.isInteger(payload.exp) ||
		Number(payload.iat) > now + 5 ||
		Number(payload.exp) < now ||
		Number(payload.exp) - Number(payload.iat) > 30 ||
		payload.workspaceId !== input.context.binding.workspaceId ||
		payload.installationId !== input.context.binding.installationId ||
		payload.mcpAppId !== input.context.binding.mcpAppId ||
		payload.replicaId !== input.context.binding.replicaId ||
		payload.receiptHash !== input.context.binding.receiptHash ||
		payload.grantEpoch !== input.context.binding.grantEpoch ||
		payload.bodyDigest !== `sha256:${crypto.createHash('sha256').update(canonical(input.body)).digest('hex')}` ||
		typeof payload.jti !== 'string'
	) throw new Error('dispatch_assertion_binding_mismatch');
	let actor: VerifiedDispatchActor | undefined;
	if (payload.actor !== undefined) {
		const candidate = payload.actor as Record<string, unknown>;
		if (
			!candidate ||
			typeof candidate !== 'object' ||
			typeof candidate.subject !== 'string' ||
			candidate.subject.length === 0 ||
			(candidate.username !== undefined && typeof candidate.username !== 'string') ||
			(candidate.roomId !== undefined && typeof candidate.roomId !== 'string')
		) throw new Error('dispatch_assertion_actor_invalid');
		actor = Object.freeze({
			subject: candidate.subject,
			...(candidate.username ? { username: candidate.username } : {}),
			...(candidate.roomId ? { roomId: candidate.roomId } : {}),
		});
	}
	for (const [jti, exp] of replay) if (exp < now) replay.delete(jti);
	if (replay.has(payload.jti)) throw new Error('dispatch_assertion_replayed');
	replay.set(payload.jti, Number(payload.exp));
	return Object.freeze({
		jti: payload.jti,
		issuedAt: Number(payload.iat),
		expiresAt: Number(payload.exp),
		...(actor ? { actor } : {}),
	});
}
