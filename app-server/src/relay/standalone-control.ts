/**
 * Standalone-production control channel: secret rotation, trust rotation
 * (Hub re-key or generation/manifest update), and capabilities push — all
 * delivered as ES256-signed control assertions over the already-authenticated
 * Relay WebSocket. A control message is applied only when its signature
 * verifies against the identity file's CURRENTLY pinned Hub key: the Relay
 * transport being authenticated is not sufficient on its own, because a
 * compromised relay hop must not be able to redirect credentials or trust.
 *
 * Wire contract (Hub side must match): a JSON-RPC notification over the Relay
 * WebSocket with one of the reserved methods below and
 * `params: { assertion: <compact ES256 JWS> }`. The compact JWS header is
 * `{ alg:'ES256', kid, privos_protocol:3, typ:'privos-hub-standalone-control+jws' }`
 * and its payload is
 * `{ protocolVersion:3, type, iss:'hub:<deploymentId>', aud:'mcp-runtime:<mcpAppId>',
 *    jti, nonce, iat, exp, data }` with `exp - iat <= 30` (same zero-headroom
 * budget as dispatch assertions — NTP on both sides is a hard requirement).
 * `data` is `{ clientId, clientSecret }` for secret rotation,
 * `{ trust: RuntimeDispatchTrustV3 }` for trust rotation, and
 * `{ scopes: string[], grantEpoch: number }` for a capabilities push.
 */
import crypto from 'node:crypto';

import {
	assertRuntimeDispatchTrustConfigurationV3,
	type RuntimeDispatchTrustV3,
} from '../workload/dispatch-assertion.js';
import { setAdoptedAgentBotCredential } from './agent-bot-credential.js';
import {
	loadStandaloneIdentity,
	rotateStandaloneIdentity,
	standaloneHubFingerprint,
	type LoadedStandaloneIdentity,
	type StandaloneIdentityV2,
} from './standalone-identity.js';

export const STANDALONE_SECRET_ROTATE_METHOD = 'notifications/privos.standaloneSecretRotate';
export const STANDALONE_TRUST_ROTATE_METHOD = 'notifications/privos.standaloneTrustRotate';
export const STANDALONE_CAPABILITIES_CHANGED_METHOD = 'notifications/privos.standaloneCapabilitiesChanged';
export const STANDALONE_AGENT_BOT_CREDENTIAL_METHOD = 'notifications/privos.agentBotCredential';

const CONTROL_METHODS: ReadonlySet<string> = new Set([
	STANDALONE_SECRET_ROTATE_METHOD,
	STANDALONE_TRUST_ROTATE_METHOD,
	STANDALONE_CAPABILITIES_CHANGED_METHOD,
	STANDALONE_AGENT_BOT_CREDENTIAL_METHOD,
]);

export function isStandaloneControlMethod(method: unknown): method is
	| typeof STANDALONE_SECRET_ROTATE_METHOD
	| typeof STANDALONE_TRUST_ROTATE_METHOD
	| typeof STANDALONE_CAPABILITIES_CHANGED_METHOD
	| typeof STANDALONE_AGENT_BOT_CREDENTIAL_METHOD {
	return typeof method === 'string' && CONTROL_METHODS.has(method);
}

export type StandaloneEffectiveCapabilities = Readonly<{
	scopes: readonly string[];
	grantEpoch: number;
	updatedAt: number;
}>;

/** Secret-free receipt returned only after a credential version is durable. */
export type StandaloneAgentBotCredentialReceipt = Readonly<{
	mcpAppId: string;
	runtimeInstallationId: string;
	deliveryVersion: number;
}>;

const CONTROL_HEADER_KEYS = ['alg', 'kid', 'privos_protocol', 'typ'] as const;
const CONTROL_PAYLOAD_KEYS = ['aud', 'data', 'exp', 'iat', 'iss', 'jti', 'nonce', 'protocolVersion', 'type'] as const;
const CONTROL_TYPE_BY_METHOD: Readonly<Record<string, string>> = {
	[STANDALONE_SECRET_ROTATE_METHOD]: 'standalone-secret-rotate',
	[STANDALONE_TRUST_ROTATE_METHOD]: 'standalone-trust-rotate',
	[STANDALONE_CAPABILITIES_CHANGED_METHOD]: 'standalone-capabilities-changed',
	[STANDALONE_AGENT_BOT_CREDENTIAL_METHOD]: 'standalone-agent-bot-credential',
};
const MAX_CONTROL_COMPACT_BYTES = 32_768;
const DEFAULT_REPLAY_CAPACITY = 64;

export class StandaloneControlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StandaloneControlError';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

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

function strictBase64urlDecode(value: string): Buffer {
	if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new StandaloneControlError('standalone_control_assertion_invalid');
	const decoded = Buffer.from(value, 'base64url');
	if (decoded.toString('base64url') !== value) throw new StandaloneControlError('standalone_control_assertion_invalid');
	return decoded;
}

/** Bounded replay protection for the rare (operator-triggered) control channel. */
class BoundedControlReplayConsumer {
	private readonly seen = new Map<string, number>();
	constructor(private readonly capacity = DEFAULT_REPLAY_CAPACITY) {}
	consume(key: string, expiresAt: number, now: number): boolean {
		for (const [existingKey, exp] of this.seen) if (exp <= now) this.seen.delete(existingKey);
		if (this.seen.has(key)) return false;
		if (this.seen.size >= this.capacity) {
			const oldest = this.seen.keys().next().value as string | undefined;
			if (oldest !== undefined) this.seen.delete(oldest);
		}
		this.seen.set(key, expiresAt);
		return true;
	}
}

type VerifiedStandaloneControlAssertion<TData> = Readonly<{ data: TData }>;

function verifyStandaloneControlAssertion<TData>(input: {
	method: string;
	compact: string;
	trust: RuntimeDispatchTrustV3;
	replay: BoundedControlReplayConsumer;
	now: number;
	clockSkewSeconds: number;
}): VerifiedStandaloneControlAssertion<TData> {
	const expectedType = CONTROL_TYPE_BY_METHOD[input.method];
	if (!expectedType) throw new StandaloneControlError('standalone_control_method_unknown');
	if (typeof input.compact !== 'string' || Buffer.byteLength(input.compact, 'utf8') > MAX_CONTROL_COMPACT_BYTES) {
		throw new StandaloneControlError('standalone_control_assertion_invalid');
	}
	const parts = input.compact.split('.');
	if (parts.length !== 3 || parts.some((part) => !part)) throw new StandaloneControlError('standalone_control_assertion_invalid');
	const headerBytes = strictBase64urlDecode(parts[0]!);
	const payloadBytes = strictBase64urlDecode(parts[1]!);
	const signature = strictBase64urlDecode(parts[2]!);
	let header: unknown;
	let payload: unknown;
	try {
		header = JSON.parse(headerBytes.toString('utf8')) as unknown;
		payload = JSON.parse(payloadBytes.toString('utf8')) as unknown;
	} catch {
		throw new StandaloneControlError('standalone_control_assertion_invalid');
	}
	if (!isRecord(header) || !isRecord(payload)) throw new StandaloneControlError('standalone_control_assertion_invalid');
	if (
		parts[0] !== Buffer.from(canonical(header), 'utf8').toString('base64url') ||
		parts[1] !== Buffer.from(canonical(payload), 'utf8').toString('base64url')
	) {
		throw new StandaloneControlError('standalone_control_assertion_invalid');
	}
	if (
		!exactKeys(header, CONTROL_HEADER_KEYS) ||
		header.alg !== 'ES256' ||
		header.typ !== 'privos-hub-standalone-control+jws' ||
		header.privos_protocol !== 3 ||
		header.kid !== input.trust.hubKid
	) {
		// A kid mismatch here is the cold-app case: the message was signed by a
		// key this app never accepted a trust rotation for. Refuse; the operator
		// must deliver the rotation live or re-pair.
		throw new StandaloneControlError('standalone_control_assertion_invalid');
	}
	if (
		!exactKeys(payload, CONTROL_PAYLOAD_KEYS) ||
		payload.protocolVersion !== 3 ||
		payload.type !== expectedType ||
		payload.iss !== `hub:${input.trust.affinity.deploymentId}` ||
		payload.aud !== `mcp-runtime:${input.trust.affinity.mcpAppId}` ||
		typeof payload.jti !== 'string' ||
		!payload.jti ||
		typeof payload.nonce !== 'string' ||
		!payload.nonce ||
		!Number.isSafeInteger(payload.iat) ||
		!Number.isSafeInteger(payload.exp) ||
		!isRecord(payload.data)
	) {
		throw new StandaloneControlError('standalone_control_assertion_invalid');
	}
	let key: crypto.KeyObject;
	try {
		key = crypto.createPublicKey({ key: input.trust.hubPublicJwk, format: 'jwk' });
	} catch {
		throw new StandaloneControlError('standalone_control_assertion_invalid');
	}
	if (
		signature.byteLength !== 64 ||
		!crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), { key, dsaEncoding: 'ieee-p1363' }, signature)
	) {
		throw new StandaloneControlError('standalone_control_assertion_invalid');
	}
	const iat = Number(payload.iat);
	const exp = Number(payload.exp);
	if (
		iat > input.now + input.clockSkewSeconds ||
		exp <= input.now ||
		exp <= iat ||
		exp - iat > 30
	) {
		throw new StandaloneControlError('standalone_control_assertion_time_invalid');
	}
	if (!input.replay.consume(`${payload.iss}:${payload.jti}:${payload.nonce}`, exp, input.now)) {
		throw new StandaloneControlError('standalone_control_assertion_replayed');
	}
	return { data: payload.data as TData };
}

export interface StandaloneRelayIdentityController {
	getCredentials(): Readonly<{ clientId: string; clientSecret: string }>;
	getTrust(): RuntimeDispatchTrustV3;
	peekEffectiveCapabilities(): StandaloneEffectiveCapabilities;
	onCapabilitiesChanged(listener: (capabilities: StandaloneEffectiveCapabilities) => void): () => void;
	/**
	 * Internal seam used by `connectRelay` when a `notifications/privos.standalone*`
	 * message arrives on an open, authenticated Relay connection. Not for app use.
	 */
	handleControlNotification(method: string, params: unknown): Promise<'handled' | 'ignored' | StandaloneAgentBotCredentialReceipt>;
}

export type StandaloneRelayIdentityControllerOptions = Readonly<{
	filePath?: string;
	now?: () => number;
	clockSkewSeconds?: number;
	onRotated?: (identity: LoadedStandaloneIdentity) => void;
	logger?: (event: string, fields: Record<string, unknown>) => void;
}>;

function assertSecretRotateData(value: unknown): asserts value is { clientId: string; clientSecret: string } {
	if (
		!isRecord(value) ||
		!exactKeys(value, ['clientId', 'clientSecret']) ||
		typeof value.clientId !== 'string' ||
		!value.clientId ||
		typeof value.clientSecret !== 'string' ||
		!value.clientSecret
	) {
		throw new StandaloneControlError('standalone_control_secret_rotate_data_invalid');
	}
}

function assertTrustRotateData(value: unknown, current: RuntimeDispatchTrustV3): asserts value is { trust: RuntimeDispatchTrustV3 } {
	if (!isRecord(value) || !exactKeys(value, ['trust'])) {
		throw new StandaloneControlError('standalone_control_trust_rotate_data_invalid');
	}
	try {
		assertRuntimeDispatchTrustConfigurationV3(value.trust);
	} catch {
		throw new StandaloneControlError('standalone_control_trust_rotate_data_invalid');
	}
	const next = value.trust as RuntimeDispatchTrustV3;
	if (
		next.affinity.workspaceId !== current.affinity.workspaceId ||
		next.affinity.deploymentId !== current.affinity.deploymentId ||
		next.affinity.mcpAppId !== current.affinity.mcpAppId ||
		next.affinity.runtimeInstallationId !== current.affinity.runtimeInstallationId
	) {
		// Re-key/generation-update rotation may change the key, generation, and
		// manifest — it must never change which installation this identity is.
		throw new StandaloneControlError('standalone_control_trust_rotate_identity_mismatch');
	}
}

function assertAgentBotCredentialData(
	value: unknown,
): asserts value is { botUserId: string; token: string; runtimeInstallationId: string; deliveryVersion: number } {
	if (
		!isRecord(value) ||
		!exactKeys(value, ['botUserId', 'token', 'runtimeInstallationId', 'deliveryVersion']) ||
		typeof value.botUserId !== 'string' ||
		!value.botUserId ||
		typeof value.token !== 'string' ||
		!value.token ||
		typeof value.runtimeInstallationId !== 'string' ||
		!value.runtimeInstallationId ||
		!Number.isSafeInteger(value.deliveryVersion) ||
		Number(value.deliveryVersion) <= 0
	) {
		throw new StandaloneControlError('standalone_control_agent_bot_credential_data_invalid');
	}
}

function assertCapabilitiesChangedData(value: unknown): asserts value is { scopes: string[]; grantEpoch: number } {
	if (
		!isRecord(value) ||
		!exactKeys(value, ['scopes', 'grantEpoch']) ||
		!Array.isArray(value.scopes) ||
		value.scopes.some((scope) => typeof scope !== 'string') ||
		!Number.isSafeInteger(value.grantEpoch) ||
		Number(value.grantEpoch) < 0
	) {
		throw new StandaloneControlError('standalone_control_capabilities_data_invalid');
	}
}

/**
 * Builds the mutable, in-process bridge between the persisted identity file
 * and a live Relay connection: current credentials/trust for outbound OAuth
 * and dispatch verification, plus the capabilities event surface, all kept in
 * sync as verified rotation/capabilities control messages arrive.
 */
export function createStandaloneRelayIdentityController(
	loaded: LoadedStandaloneIdentity,
	options: StandaloneRelayIdentityControllerOptions = {},
): StandaloneRelayIdentityController {
	const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
	const clockSkewSeconds = options.clockSkewSeconds ?? 5;
	const replay = new BoundedControlReplayConsumer();
	let current = loaded;
	let capabilities: StandaloneEffectiveCapabilities = Object.freeze({
		scopes: Object.freeze([]),
		grantEpoch: current.trust.affinity.runtimeAuthorizationEpoch ?? 0,
		updatedAt: Date.now(),
	});
	const listeners = new Set<(next: StandaloneEffectiveCapabilities) => void>();

	async function applySecretRotate(assertionCompact: unknown): Promise<void> {
		if (typeof assertionCompact !== 'string') throw new StandaloneControlError('standalone_control_assertion_invalid');
		const verified = verifyStandaloneControlAssertion<unknown>({
			method: STANDALONE_SECRET_ROTATE_METHOD,
			compact: assertionCompact,
			trust: current.trust,
			replay,
			now: now(),
			clockSkewSeconds,
		});
		assertSecretRotateData(verified.data);
		const { clientId, clientSecret } = verified.data;
		const rotated = await rotateStandaloneIdentity(
			(identity): StandaloneIdentityV2 => ({ ...identity, clientId, clientSecret, rotatedAt: Date.now() }),
			{ filePath: current.filePath },
		);
		current = rotated;
		options.logger?.('standalone.identity.secret_rotated', { filePath: current.filePath });
		options.onRotated?.(current);
	}

	async function applyTrustRotate(assertionCompact: unknown): Promise<void> {
		if (typeof assertionCompact !== 'string') throw new StandaloneControlError('standalone_control_assertion_invalid');
		const verified = verifyStandaloneControlAssertion<unknown>({
			method: STANDALONE_TRUST_ROTATE_METHOD,
			compact: assertionCompact,
			trust: current.trust,
			replay,
			now: now(),
			clockSkewSeconds,
		});
		assertTrustRotateData(verified.data, current.trust);
		const nextTrust = verified.data.trust;
		const rotated = await rotateStandaloneIdentity(
			(identity): StandaloneIdentityV2 => ({
				...identity,
				trust: nextTrust,
				fingerprint: standaloneHubFingerprint(nextTrust.hubKid),
				rotatedAt: Date.now(),
			}),
			{ filePath: current.filePath },
		);
		current = rotated;
		options.logger?.('standalone.identity.trust_rotated', {
			filePath: current.filePath,
			fingerprint: current.fingerprint,
		});
		options.onRotated?.(current);
	}

	async function applyAgentBotCredential(assertionCompact: unknown): Promise<StandaloneAgentBotCredentialReceipt> {
		if (typeof assertionCompact !== 'string') throw new StandaloneControlError('standalone_control_assertion_invalid');
		const verified = verifyStandaloneControlAssertion<unknown>({
			method: STANDALONE_AGENT_BOT_CREDENTIAL_METHOD,
			compact: assertionCompact,
			trust: current.trust,
			replay,
			now: now(),
			clockSkewSeconds,
		});
		assertAgentBotCredentialData(verified.data);
		const { botUserId, token, runtimeInstallationId, deliveryVersion } = verified.data;
		if (runtimeInstallationId !== current.trust.affinity.runtimeInstallationId) {
			throw new StandaloneControlError('standalone_control_agent_bot_credential_installation_mismatch');
		}
		const persistedCredential = current.identity.agentBotCredential;
		const persistedVersion = persistedCredential?.deliveryVersion ?? 0;
		if (deliveryVersion < persistedVersion) {
			throw new StandaloneControlError('standalone_control_agent_bot_credential_stale');
		}
		if (deliveryVersion === persistedVersion) {
			if (!persistedCredential || persistedCredential.botUserId !== botUserId || persistedCredential.token !== token) {
				throw new StandaloneControlError('standalone_control_agent_bot_credential_version_conflict');
			}
			return {
				mcpAppId: current.trust.affinity.mcpAppId,
				runtimeInstallationId,
				deliveryVersion,
			};
		}
		// Persist into the identity file so the credential survives a restart,
		// then adopt it in-process so the running app uses it HOT — no restart.
		// Env always overrides the adopted value (operator override preserved).
		const rotated = await rotateStandaloneIdentity(
			(identity): StandaloneIdentityV2 => ({ ...identity, agentBotCredential: { botUserId, token, deliveryVersion }, rotatedAt: Date.now() }),
			{ filePath: current.filePath },
		);
		current = rotated;
		setAdoptedAgentBotCredential({ botUserId, token });
		// The token is never logged; only that a delivery landed.
		options.logger?.('standalone.identity.agent_bot_credential_delivered', { filePath: current.filePath });
		options.onRotated?.(current);
		return {
			mcpAppId: current.trust.affinity.mcpAppId,
			runtimeInstallationId,
			deliveryVersion,
		};
	}

	async function applyCapabilitiesChanged(assertionCompact: unknown): Promise<void> {
		if (typeof assertionCompact !== 'string') throw new StandaloneControlError('standalone_control_assertion_invalid');
		const verified = verifyStandaloneControlAssertion<unknown>({
			method: STANDALONE_CAPABILITIES_CHANGED_METHOD,
			compact: assertionCompact,
			trust: current.trust,
			replay,
			now: now(),
			clockSkewSeconds,
		});
		assertCapabilitiesChangedData(verified.data);
		const next: StandaloneEffectiveCapabilities = Object.freeze({
			scopes: Object.freeze([...new Set(verified.data.scopes)].sort()),
			grantEpoch: verified.data.grantEpoch,
			updatedAt: Date.now(),
		});
		if (next.grantEpoch < capabilities.grantEpoch) {
			// A control channel may reorder; never regress to a stale epoch.
			return;
		}
		capabilities = next;
		for (const listener of listeners) {
			try {
				listener(next);
			} catch {
				// A consumer callback must never break the control channel.
			}
		}
	}

	return {
		getCredentials: () => current.relay,
		getTrust: () => current.trust,
		peekEffectiveCapabilities: () => capabilities,
		onCapabilitiesChanged: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async handleControlNotification(method, params) {
			if (!isStandaloneControlMethod(method)) return 'ignored';
			const assertion = isRecord(params) ? params.assertion : undefined;
			if (method === STANDALONE_SECRET_ROTATE_METHOD) await applySecretRotate(assertion);
			else if (method === STANDALONE_TRUST_ROTATE_METHOD) await applyTrustRotate(assertion);
			else if (method === STANDALONE_AGENT_BOT_CREDENTIAL_METHOD) return applyAgentBotCredential(assertion);
			else await applyCapabilitiesChanged(assertion);
			return 'handled';
		},
	};
}

/** Convenience: load the identity file and build its controller in one call. */
export function loadStandaloneRelayIdentityController(
	options: StandaloneRelayIdentityControllerOptions = {},
): StandaloneRelayIdentityController {
	const loaded = loadStandaloneIdentity({ filePath: options.filePath });
	return createStandaloneRelayIdentityController(loaded, options);
}
