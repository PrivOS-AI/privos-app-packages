import crypto, { type JsonWebKey } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

import type { ToolCallContext } from '../context/tool-call-context.js';
import {
	managedIngressRoomAuthority,
	type ManagedIngressRoomAuthority,
} from './managed-ingress-authority.js';

export const DEFAULT_WORKLOAD_SOCKET = '/run/privos/identity.sock';

/** One process-local bound for retained tokens and simultaneous exact-key issuances. */
const WORKLOAD_AUTHORIZATION_CACHE_CAPACITY = 64;

export type WorkloadBrokerResponse = {
	ok: true;
	attestation: string;
	hubOrigin: string;
	hubKid: string;
	hubPublicJwk: JsonWebKey;
};

/**
 * Generation-scoped facts a node attests for an App Library runtime. They are
 * the affinity a cluster-routed dispatch assertion is checked against.
 */
export type WorkloadGenerationBinding = {
	clusterId: string;
	deploymentId: string;
	generationId: string;
	generationNumber: number;
	manifestDigest: string;
	resourceManifestHash: string;
	runtimeResourceInventoryHash: string;
};

export type WorkloadBinding = {
	workspaceId: string;
	installationId: string;
	mcpAppId: string;
	replicaId: string;
	receiptHash: string;
	grantEpoch: number;
	/** Present only when the node attested an App Library generation. */
	generation?: WorkloadGenerationBinding;
};

export type WorkloadBrokerContext = {
	hubOrigin: string;
	hubKid: string;
	hubPublicJwk: JsonWebKey;
	binding: WorkloadBinding;
};

export type EffectiveCapabilities = Readonly<{
	status: 'unavailable' | 'pairing' | 'paired' | 'active' | 'stale';
	scopes: readonly string[];
	workspaceId?: string;
	installationId?: string;
	mcpAppId?: string;
	replicaId?: string;
	receiptHash?: string;
	grantEpoch?: number;
	updatedAt: number;
	reason?: WorkloadIdentityErrorCode;
}>;

export type WorkloadIdentityErrorCode =
	| 'BROKER_UNAVAILABLE'
	| 'BROKER_RESPONSE_INVALID'
	| 'HUB_IDENTITY_INVALID'
	| 'CLIENT_DISPOSED'
	| 'READINESS_DENIED'
	| 'TOKEN_DENIED'
	| 'TOKEN_RESPONSE_INVALID'
	| 'TARGET_ORIGIN_INVALID'
	| 'AUTHORIZATION_STALE'
	| 'AUTHORIZATION_CAPACITY_EXCEEDED'
	| 'PERMISSION_DENIED'
	| 'CAPABILITY_NOT_GRANTED';

export class WorkloadIdentityError extends Error {
	constructor(
		public readonly code: WorkloadIdentityErrorCode,
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = 'WorkloadIdentityError';
	}
}

export class WorkloadPermissionDeniedError extends WorkloadIdentityError {
	constructor(public readonly requiredScope?: string) {
		super('PERMISSION_DENIED', 'The installation does not grant this capability.', 403);
		this.name = 'WorkloadPermissionDeniedError';
	}
}

export type WorkloadFetchInit = RequestInit & {
	/** POST/PATCH retries are disabled unless the caller explicitly proves idempotency. */
	retryMode?: 'safe-methods' | 'idempotent' | 'never';
	/** Required together with `retryMode: 'idempotent'` for mutation replay. */
	replayable?: true;
	requiredScope?: string;
};

export type RoomBoundWorkloadFetchInit = Omit<WorkloadFetchInit, 'requiredScope'> & {
	/** One exact granted permission; unions, wildcards, and whitespace are rejected. */
	requiredScope: string;
};

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type BrokerRequester = (request: Record<string, unknown>) => Promise<WorkloadBrokerResponse>;

export type WorkloadIdentityClientOptions = {
	socketPath?: string;
	fetch?: FetchImplementation;
	brokerRequest?: BrokerRequester;
	now?: () => number;
	refreshSkewMs?: number;
};

type CachedToken = {
	value: string;
	expiresAt: number;
	scopes: string[];
};

type TokenLease = Readonly<{
	cacheKey: string;
	token: CachedToken;
}>;

type RoomAuthorization = Readonly<{
	workspaceId: string;
	deploymentId: string;
	generationId: string;
	generationNumber: number;
	runtimeInstallationId: string;
	mcpAppId: string;
	manifestDigest: string;
	resourceManifestHash: string;
	runtimeResourceInventoryHash: string;
	runtimeApprovalReceiptHash: string;
	runtimeAuthorizationEpoch: number;
	roomId: string;
	authorizationBindingId: string;
	bindingReceiptHash: string;
	bindingEpoch: number;
	bindingGrantHash?: string;
	bindingTokenVersion?: number;
}>;

type RoomRequest = (input: string, init: RoomBoundWorkloadFetchInit, throwOnAuthorization: boolean) => Promise<Response>;

/** Request-only capability derived synchronously from one verified room context. */
export class RoomBoundWorkloadClient {
	constructor(private readonly request: RoomRequest) {}

	authorizedFetch(input: string, init: RoomBoundWorkloadFetchInit): Promise<Response> {
		return this.request(input, init, false);
	}

	authorizedRequest(input: string, init: RoomBoundWorkloadFetchInit): Promise<Response> {
		return this.request(input, init, true);
	}

	toJSON(): Record<string, unknown> {
		return { type: 'RoomBoundWorkloadClient' };
	}

	[Symbol.for('nodejs.util.inspect.custom')](): Record<string, unknown> {
		return this.toJSON();
	}
}

function encode(value: unknown): string {
	return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function thumbprint(jwk: JsonWebKey): string {
	return crypto
		.createHash('sha256')
		.update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
		.digest('base64url');
}

function normalizedHtu(value: string): string {
	const url = new URL(value);
	url.search = '';
	url.hash = '';
	return url.toString();
}

function validateHubOrigin(value: unknown): string {
	if (typeof value !== 'string') throw new WorkloadIdentityError('BROKER_RESPONSE_INVALID', 'The workload broker response is invalid.');
	const url = new URL(value);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new WorkloadIdentityError('BROKER_RESPONSE_INVALID', 'The workload broker response is invalid.');
	}
	return url.origin;
}

function parseBinding(attestation: string, nonce: string, publicJwk: JsonWebKey, now: number): WorkloadBinding {
	const parts = attestation.split('.');
	if (parts.length !== 3 || parts.some((part) => !part)) {
		throw new WorkloadIdentityError('BROKER_RESPONSE_INVALID', 'The workload broker response is invalid.');
	}
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
	} catch {
		throw new WorkloadIdentityError('BROKER_RESPONSE_INVALID', 'The workload broker response is invalid.');
	}
	if (
		payload.type !== 'node-workload-attestation' ||
		payload.nonce !== nonce ||
		payload.dpopJkt !== thumbprint(publicJwk) ||
		!Number.isInteger(payload.iat) ||
		!Number.isInteger(payload.exp) ||
		Number(payload.iat) > Math.floor(now / 1_000) + 30 ||
		Number(payload.exp) < Math.floor(now / 1_000) ||
		Number(payload.exp) - Number(payload.iat) > 60
	) {
		throw new WorkloadIdentityError('BROKER_RESPONSE_INVALID', 'The workload broker response is invalid.');
	}
	return payload.protocolVersion === 3 ? bindingFromGenerationAttestation(payload) : bindingFromReplicaAttestation(payload);
}

/**
 * A node running an App Library generation attests the generation instead of a
 * standalone replica: the installation is the runtime installation, the receipt
 * is the approval receipt, and the epoch is the authorization epoch. All three
 * generation hashes are canonical-JSON SHA-256 in base64url, never the
 * `sha256:<hex>` digest form the replica attestation uses.
 */
function bindingFromGenerationAttestation(payload: Record<string, unknown>): WorkloadBinding {
	const identifiers = [
		'workspaceId',
		'runtimeInstallationId',
		'mcpAppId',
		'replicaId',
		'clusterId',
		'deploymentId',
		'generationId',
	] as const;
	const artifactHashes = ['approvalReceiptHash', 'resourceManifestHash', 'runtimeResourceInventoryHash'] as const;
	if (
		identifiers.some((field) => typeof payload[field] !== 'string' || String(payload[field]).length === 0) ||
		artifactHashes.some((field) => typeof payload[field] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(String(payload[field]))) ||
		typeof payload.manifestDigest !== 'string' ||
		!/^sha256:[a-f0-9]{64}$/.test(payload.manifestDigest) ||
		!Number.isInteger(payload.authorizationEpoch) ||
		Number(payload.authorizationEpoch) < 1 ||
		!Number.isInteger(payload.generationNumber) ||
		Number(payload.generationNumber) < 1
	) {
		throw new WorkloadIdentityError('BROKER_RESPONSE_INVALID', 'The workload broker response is invalid.');
	}
	return {
		workspaceId: String(payload.workspaceId),
		installationId: String(payload.runtimeInstallationId),
		mcpAppId: String(payload.mcpAppId),
		replicaId: String(payload.replicaId),
		receiptHash: String(payload.approvalReceiptHash),
		grantEpoch: Number(payload.authorizationEpoch),
		generation: {
			clusterId: String(payload.clusterId),
			deploymentId: String(payload.deploymentId),
			generationId: String(payload.generationId),
			generationNumber: Number(payload.generationNumber),
			manifestDigest: payload.manifestDigest,
			resourceManifestHash: String(payload.resourceManifestHash),
			runtimeResourceInventoryHash: String(payload.runtimeResourceInventoryHash),
		},
	};
}

function bindingFromReplicaAttestation(payload: Record<string, unknown>): WorkloadBinding {
	const identifiers = ['workspaceId', 'installationId', 'mcpAppId', 'replicaId'] as const;
	if (
		identifiers.some((field) => typeof payload[field] !== 'string' || String(payload[field]).length === 0) ||
		typeof payload.receiptHash !== 'string' ||
		!/^sha256:[a-f0-9]{64}$/.test(payload.receiptHash) ||
		!Number.isInteger(payload.grantEpoch) ||
		Number(payload.grantEpoch) < 1
	) {
		throw new WorkloadIdentityError('BROKER_RESPONSE_INVALID', 'The workload broker response is invalid.');
	}
	return {
		workspaceId: String(payload.workspaceId),
		installationId: String(payload.installationId),
		mcpAppId: String(payload.mcpAppId),
		replicaId: String(payload.replicaId),
		receiptHash: payload.receiptHash,
		grantEpoch: Number(payload.grantEpoch),
	};
}

function parseScopes(value: unknown): string[] {
	if (typeof value !== 'string') throw new WorkloadIdentityError('TOKEN_RESPONSE_INVALID', 'The workload token response is invalid.');
	const scopes = value.split(/\s+/).filter(Boolean);
	if (
		new Set(scopes).size !== scopes.length ||
		scopes.some((scope) => !/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/.test(scope))
	) {
		throw new WorkloadIdentityError('TOKEN_RESPONSE_INVALID', 'The workload token response is invalid.');
	}
	return scopes.sort();
}

function capabilitiesEqual(left: EffectiveCapabilities, right: EffectiveCapabilities): boolean {
	return JSON.stringify({ ...left, updatedAt: 0 }) === JSON.stringify({ ...right, updatedAt: 0 });
}

function retryAllowed(method: string, mode: WorkloadFetchInit['retryMode'], replayable: WorkloadFetchInit['replayable']): boolean {
	if (mode === 'never') return false;
	if (mode === 'idempotent') return replayable === true;
	return ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(method);
}

function exactScope(scope: unknown): scope is string {
	return typeof scope === 'string' && /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/.test(scope);
}

function workspaceAuthorizationKey(context: WorkloadBrokerContext): string {
	const generation = context.binding.generation;
	return JSON.stringify([
		'workspace',
		context.hubOrigin,
		context.binding.workspaceId,
		context.binding.installationId,
		context.binding.mcpAppId,
		context.binding.receiptHash,
		context.binding.grantEpoch,
		...(generation
			? [
					generation.clusterId,
					generation.deploymentId,
					generation.generationId,
					generation.generationNumber,
					generation.manifestDigest,
					generation.resourceManifestHash,
					generation.runtimeResourceInventoryHash,
				]
			: []),
	]);
}

function roomAuthorizationKey(context: WorkloadBrokerContext, authorization: RoomAuthorization): string {
	return JSON.stringify([
		'room',
		workspaceAuthorizationKey(context),
		authorization.roomId,
		authorization.authorizationBindingId,
		authorization.bindingReceiptHash,
		authorization.bindingEpoch,
		authorization.bindingGrantHash ?? null,
		authorization.bindingTokenVersion ?? null,
	]);
}

function roomAuthorizationFromAuthority(authority: ManagedIngressRoomAuthority): RoomAuthorization {
	return Object.freeze({
		workspaceId: authority.workspaceId,
		deploymentId: authority.deploymentId,
		generationId: authority.generationId,
		generationNumber: authority.generationNumber,
		runtimeInstallationId: authority.runtimeInstallationId,
		mcpAppId: authority.mcpAppId,
		manifestDigest: authority.manifestDigest,
		resourceManifestHash: authority.resourceManifestHash,
		runtimeResourceInventoryHash: authority.runtimeResourceInventoryHash,
		runtimeApprovalReceiptHash: authority.runtimeApprovalReceiptHash,
		runtimeAuthorizationEpoch: authority.runtimeAuthorizationEpoch,
		roomId: authority.roomId,
		authorizationBindingId: authority.authorizationBindingId,
		bindingReceiptHash: authority.bindingReceiptHash,
		bindingEpoch: authority.bindingEpoch,
		...(authority.bindingGrantHash ? { bindingGrantHash: authority.bindingGrantHash } : {}),
		...(authority.bindingTokenVersion !== undefined ? { bindingTokenVersion: authority.bindingTokenVersion } : {}),
	});
}

function assertRoomMatchesBroker(context: WorkloadBrokerContext, authorization: RoomAuthorization): void {
	const generation = context.binding.generation;
	if (
		!generation ||
		context.binding.workspaceId !== authorization.workspaceId ||
		context.binding.installationId !== authorization.runtimeInstallationId ||
		context.binding.mcpAppId !== authorization.mcpAppId ||
		context.binding.receiptHash !== authorization.runtimeApprovalReceiptHash ||
		context.binding.grantEpoch !== authorization.runtimeAuthorizationEpoch ||
		generation.deploymentId !== authorization.deploymentId ||
		generation.generationId !== authorization.generationId ||
		generation.generationNumber !== authorization.generationNumber ||
		generation.manifestDigest !== authorization.manifestDigest ||
		generation.resourceManifestHash !== authorization.resourceManifestHash ||
		generation.runtimeResourceInventoryHash !== authorization.runtimeResourceInventoryHash
	) {
		throw new WorkloadIdentityError('AUTHORIZATION_STALE', 'The verified room authorization is stale.', 401);
	}
}

const RESERVED_ROOM_AUTHORITY_KEYS = new Set(['roomId', 'authorizationBindingId']);

function roomAuthorityOverrideError(): WorkloadIdentityError {
	return new WorkloadIdentityError(
		'TARGET_ORIGIN_INVALID',
		'Room-bound request URLs and semantic bodies cannot carry room authority selectors.',
		400,
	);
}

function assertNoReservedQuery(target: URL): void {
	for (const key of target.searchParams.keys()) {
		if (RESERVED_ROOM_AUTHORITY_KEYS.has(key)) throw roomAuthorityOverrideError();
	}
}

function assertNoReservedJson(value: unknown, seen = new Set<object>()): void {
	if (!value || typeof value !== 'object') return;
	if (seen.has(value)) throw roomAuthorityOverrideError();
	seen.add(value);
	if (Array.isArray(value)) {
		for (const child of value) assertNoReservedJson(child, seen);
		return;
	}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (RESERVED_ROOM_AUTHORITY_KEYS.has(key)) throw roomAuthorityOverrideError();
		assertNoReservedJson(child, seen);
	}
}

function assertNoReservedForm(params: URLSearchParams | FormData): void {
	for (const key of params.keys()) {
		if (RESERVED_ROOM_AUTHORITY_KEYS.has(key)) throw roomAuthorityOverrideError();
	}
}

function semanticContentType(headers: Headers, body: NonNullable<RequestInit['body']>): 'json' | 'form' | undefined {
	const supplied = headers.get('content-type');
	const value = (supplied || (body instanceof Blob ? body.type : '')).split(';', 1)[0]!.trim().toLowerCase();
	if (value === 'application/json' || value.endsWith('+json')) return 'json';
	if (value === 'application/x-www-form-urlencoded') return 'form';
	return undefined;
}

function bodyText(body: string | Blob | ArrayBuffer | ArrayBufferView): Promise<string> | string {
	if (typeof body === 'string') return body;
	if (body instanceof Blob) return body.text();
	try {
		const bytes = body instanceof ArrayBuffer
			? new Uint8Array(body)
			: new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw roomAuthorityOverrideError();
	}
}

async function assertNoReservedBody(init: RequestInit): Promise<void> {
	const body = init.body;
	if (body === undefined || body === null) return;
	if (body instanceof URLSearchParams || body instanceof FormData) {
		assertNoReservedForm(body);
		return;
	}
	if (body instanceof ReadableStream) throw roomAuthorityOverrideError();

	const semantic = semanticContentType(new Headers(init.headers), body);
	if (!semantic) {
		if (
			typeof body === 'string' ||
			body instanceof Blob ||
			body instanceof ArrayBuffer ||
			ArrayBuffer.isView(body)
		) return;
		throw roomAuthorityOverrideError();
	}
	if (
		typeof body !== 'string' &&
		!(body instanceof Blob) &&
		!(body instanceof ArrayBuffer) &&
		!ArrayBuffer.isView(body)
	) {
		throw roomAuthorityOverrideError();
	}

	const text = await bodyText(body);
	if (semantic === 'json') {
		try {
			assertNoReservedJson(JSON.parse(text));
		} catch (error) {
			if (error instanceof WorkloadIdentityError) throw error;
			throw roomAuthorityOverrideError();
		}
		return;
	}
	if (/%(?![0-9A-Fa-f]{2})/.test(text)) throw roomAuthorityOverrideError();
	assertNoReservedForm(new URLSearchParams(text));
}

export class WorkloadIdentityClient {
	private readonly socketPath: string;
	private readonly fetchImplementation: FetchImplementation;
	private readonly brokerRequester?: BrokerRequester;
	private readonly now: () => number;
	private readonly refreshSkewMs: number;
	private readonly privateJwk: JsonWebKey;
	private readonly publicJwk: JsonWebKey;
	private readonly tokens = new Map<string, CachedToken>();
	private readonly tokenIssuance = new Map<string, Promise<TokenLease>>();
	private disposed = false;
	private ready = false;
	private context?: WorkloadBrokerContext;
	private monitor?: ReturnType<typeof setInterval>;
	private readonly listeners = new Set<(capabilities: EffectiveCapabilities) => void>();
	private capabilities: EffectiveCapabilities;

	constructor(options: string | WorkloadIdentityClientOptions = {}) {
		const normalized = typeof options === 'string' ? { socketPath: options } : options;
		this.socketPath = normalized.socketPath ?? process.env.PRIVOS_WORKLOAD_SOCKET ?? DEFAULT_WORKLOAD_SOCKET;
		this.fetchImplementation = normalized.fetch ?? fetch;
		this.brokerRequester = normalized.brokerRequest;
		this.now = normalized.now ?? Date.now;
		this.refreshSkewMs = normalized.refreshSkewMs ?? 30_000;
		const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
		this.privateJwk = pair.privateKey.export({ format: 'jwk' });
		this.publicJwk = pair.publicKey.export({ format: 'jwk' });
		this.capabilities = Object.freeze({
			status: this.isAvailable() ? 'pairing' : 'unavailable',
			scopes: Object.freeze([]),
			updatedAt: this.now(),
			...(this.isAvailable() ? {} : { reason: 'BROKER_UNAVAILABLE' as const }),
		});
	}

	isAvailable(): boolean {
		return Boolean(this.brokerRequester) || fs.existsSync(this.socketPath);
	}

	private assertNotDisposed(): void {
		if (this.disposed) {
			throw new WorkloadIdentityError('CLIENT_DISPOSED', 'The workload identity client is disposed.');
		}
	}

	private proof(input: { htu: string; htm: string; nonce?: string; ath?: string }): string {
		const header = encode({ alg: 'ES256', typ: 'dpop+jwt', jwk: this.publicJwk });
		const payload = encode({
			htu: normalizedHtu(input.htu),
			htm: input.htm.toUpperCase(),
			iat: Math.floor(this.now() / 1_000),
			jti: crypto.randomUUID(),
			...(input.nonce ? { nonce: input.nonce } : {}),
			...(input.ath ? { ath: input.ath } : {}),
		});
		const signingInput = Buffer.from(`${header}.${payload}`, 'utf8');
		const key = crypto.createPrivateKey({ key: this.privateJwk, format: 'jwk' });
		const signature = crypto.sign('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
		return `${header}.${payload}.${signature}`;
	}

	private updateCapabilities(input: Omit<EffectiveCapabilities, 'updatedAt'>): void {
		const next: EffectiveCapabilities = Object.freeze({
			...input,
			scopes: Object.freeze([...input.scopes].sort()),
			updatedAt: this.now(),
		});
		if (capabilitiesEqual(this.capabilities, next)) return;
		this.capabilities = next;
		for (const listener of this.listeners) {
			try {
				listener(next);
			} catch {
				// A consumer callback must never break token refresh or expose credentials through an error path.
			}
		}
	}

	private contextCapabilities(status: EffectiveCapabilities['status'], scopes: readonly string[], reason?: WorkloadIdentityErrorCode): void {
		const binding = this.context?.binding;
		this.updateCapabilities({
			status,
			scopes,
			...(binding
				? {
						workspaceId: binding.workspaceId,
						installationId: binding.installationId,
						mcpAppId: binding.mcpAppId,
						replicaId: binding.replicaId,
						receiptHash: binding.receiptHash,
						grantEpoch: binding.grantEpoch,
					}
				: {}),
			...(reason ? { reason } : {}),
		});
	}

	private async attest(): Promise<{ broker: WorkloadBrokerResponse; nonce: string }> {
		this.assertNotDisposed();
		const nonce = crypto.randomBytes(24).toString('base64url');
		const broker = await this.requestBroker({ op: 'attest', publicJwk: this.publicJwk, nonce });
		this.assertNotDisposed();
		if (
			!broker ||
			broker.ok !== true ||
			typeof broker.attestation !== 'string' ||
			typeof broker.hubKid !== 'string' ||
			!broker.hubPublicJwk ||
			thumbprint(broker.hubPublicJwk) !== broker.hubKid
		) {
			throw new WorkloadIdentityError('HUB_IDENTITY_INVALID', 'The workload broker Hub identity is invalid.');
		}
		const hubOrigin = validateHubOrigin(broker.hubOrigin);
		const binding = parseBinding(broker.attestation, nonce, this.publicJwk, this.now());
		this.context = { hubOrigin, hubKid: broker.hubKid, hubPublicJwk: broker.hubPublicJwk, binding };
		return { broker: { ...broker, hubOrigin }, nonce };
	}

	private requestBroker(request: Record<string, unknown>): Promise<WorkloadBrokerResponse> {
		if (this.brokerRequester) return this.brokerRequester(request);
		if (!fs.existsSync(this.socketPath)) {
			return Promise.reject(new WorkloadIdentityError('BROKER_UNAVAILABLE', 'The PrivOS workload identity broker is unavailable.'));
		}
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(this.socketPath);
			let buffer = '';
			const timeout = setTimeout(
				() => socket.destroy(new WorkloadIdentityError('BROKER_UNAVAILABLE', 'The PrivOS workload identity broker timed out.')),
				5_000,
			);
			socket.setEncoding('utf8');
			socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
			socket.on('data', (chunk) => {
				buffer += chunk;
				if (buffer.length > 32_768) {
					socket.destroy(new WorkloadIdentityError('BROKER_RESPONSE_INVALID', 'The workload broker response is invalid.'));
					return;
				}
				const end = buffer.indexOf('\n');
				if (end < 0) return;
				clearTimeout(timeout);
				socket.end();
				try {
					const parsed = JSON.parse(buffer.slice(0, end)) as WorkloadBrokerResponse | { ok: false };
					if (!parsed.ok) throw new WorkloadIdentityError('BROKER_RESPONSE_INVALID', 'The workload broker denied identity.');
					resolve(parsed);
				} catch (error) {
					reject(error instanceof WorkloadIdentityError ? error : new WorkloadIdentityError('BROKER_RESPONSE_INVALID', 'The workload broker response is invalid.'));
				}
			});
			socket.once('error', (error) => {
				clearTimeout(timeout);
				reject(error);
			});
		});
	}

	async ensureReady(): Promise<void> {
		this.assertNotDisposed();
		if (this.ready) return;
		this.contextCapabilities('pairing', []);
		const { broker, nonce } = await this.attest();
		this.assertNotDisposed();
		const target = `${broker.hubOrigin}/api/v1/mcp-workload.ready`;
		const response = await this.fetchImplementation(target, {
			method: 'POST',
			headers: { 'content-type': 'application/json', dpop: this.proof({ htu: target, htm: 'POST', nonce }) },
			body: JSON.stringify({ attestation: broker.attestation }),
			signal: AbortSignal.timeout(10_000),
		});
		this.assertNotDisposed();
		if (!response.ok) {
			this.contextCapabilities('stale', [], 'READINESS_DENIED');
			throw new WorkloadIdentityError('READINESS_DENIED', 'PrivOS did not accept workload readiness.', response.status);
		}
		this.ready = true;
		this.contextCapabilities('paired', []);
	}

	private pruneUnusableTokens(): void {
		const now = this.now();
		for (const [key, token] of this.tokens) {
			if (token.expiresAt - now <= this.refreshSkewMs) this.tokens.delete(key);
		}
	}

	private retainToken(cacheKey: string, token: CachedToken): void {
		this.pruneUnusableTokens();
		this.tokens.delete(cacheKey);
		while (this.tokens.size >= WORKLOAD_AUTHORIZATION_CACHE_CAPACITY) {
			const leastRecentlyUsed = this.tokens.keys().next().value as string | undefined;
			if (leastRecentlyUsed === undefined) break;
			this.tokens.delete(leastRecentlyUsed);
		}
		this.tokens.set(cacheKey, token);
	}

	private async issueAccessToken(cacheKey: string, authorization?: RoomAuthorization): Promise<TokenLease> {
		this.assertNotDisposed();
		await this.ensureReady();
		this.assertNotDisposed();
		const { broker, nonce } = await this.attest();
		this.assertNotDisposed();
		if (authorization) assertRoomMatchesBroker(this.context!, authorization);
		const currentKey = authorization
			? roomAuthorizationKey(this.context!, authorization)
			: workspaceAuthorizationKey(this.context!);
		if (currentKey !== cacheKey) {
			this.tokens.delete(cacheKey);
			throw new WorkloadIdentityError('AUTHORIZATION_STALE', 'The workload authorization changed during token issuance.', 401);
		}
		const target = `${broker.hubOrigin}/api/v1/mcp-workload.token`;
		const response = await this.fetchImplementation(target, {
			method: 'POST',
			headers: { 'content-type': 'application/json', dpop: this.proof({ htu: target, htm: 'POST', nonce }) },
			body: JSON.stringify({
				attestation: broker.attestation,
				...(authorization ? { authorizationBindingId: authorization.authorizationBindingId } : {}),
			}),
			signal: AbortSignal.timeout(10_000),
		});
		this.assertNotDisposed();
		if (!response.ok) {
			this.tokens.delete(cacheKey);
			this.tokens.delete(currentKey);
			this.contextCapabilities('stale', [], 'TOKEN_DENIED');
			throw new WorkloadIdentityError('TOKEN_DENIED', 'PrivOS did not issue workload authorization.', response.status);
		}
		let body: { access_token?: unknown; expires_in?: unknown; token_type?: unknown; scope?: unknown };
		try {
			body = await response.json() as typeof body;
			this.assertNotDisposed();
		} catch {
			this.assertNotDisposed();
			throw new WorkloadIdentityError('TOKEN_RESPONSE_INVALID', 'The workload token response is invalid.');
		}
		if (
			typeof body.access_token !== 'string' ||
			body.access_token.length < 32 ||
			body.token_type !== 'DPoP' ||
			typeof body.expires_in !== 'number' ||
			!Number.isFinite(body.expires_in) ||
			body.expires_in <= 0 ||
			body.expires_in > 600
		) {
			throw new WorkloadIdentityError('TOKEN_RESPONSE_INVALID', 'The workload token response is invalid.');
		}
		const scopes = parseScopes(body.scope ?? '');
		const token = { value: body.access_token, expiresAt: this.now() + body.expires_in * 1_000, scopes };
		this.retainToken(cacheKey, token);
		this.contextCapabilities('active', scopes);
		return Object.freeze({ cacheKey, token });
	}

	private tokenFor(cacheKey: string, authorization?: RoomAuthorization, forceRefresh = false): Promise<TokenLease> {
		this.assertNotDisposed();
		this.pruneUnusableTokens();
		const cached = this.tokens.get(cacheKey);
		if (!forceRefresh && cached) {
			this.tokens.delete(cacheKey);
			this.tokens.set(cacheKey, cached);
			return Promise.resolve(Object.freeze({ cacheKey, token: cached }));
		}
		const issuing = this.tokenIssuance.get(cacheKey);
		if (issuing) return issuing;
		if (forceRefresh) this.tokens.delete(cacheKey);
		if (this.tokenIssuance.size >= WORKLOAD_AUTHORIZATION_CACHE_CAPACITY) {
			return Promise.reject(new WorkloadIdentityError(
				'AUTHORIZATION_CAPACITY_EXCEEDED',
				'The workload authorization issuance capacity is exhausted.',
				503,
			));
		}
		const started = this.issueAccessToken(cacheKey, authorization).finally(() => {
			if (this.tokenIssuance.get(cacheKey) === started) this.tokenIssuance.delete(cacheKey);
		});
		this.tokenIssuance.set(cacheKey, started);
		return started;
	}

	async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
		this.assertNotDisposed();
		await this.ensureReady();
		this.assertNotDisposed();
		const context = await this.brokerContext();
		this.assertNotDisposed();
		const lease = await this.tokenFor(workspaceAuthorizationKey(context), undefined, options.forceRefresh);
		this.assertNotDisposed();
		return lease.token.value;
	}

	async getEffectiveCapabilities(options: { forceRefresh?: boolean } = {}): Promise<EffectiveCapabilities> {
		await this.getAccessToken(options);
		this.assertNotDisposed();
		return this.capabilities;
	}

	peekEffectiveCapabilities(): EffectiveCapabilities {
		return this.capabilities;
	}

	toJSON(): Record<string, unknown> {
		return { type: 'WorkloadIdentityClient', capabilities: this.capabilities };
	}

	[Symbol.for('nodejs.util.inspect.custom')](): Record<string, unknown> {
		return this.toJSON();
	}

	onCapabilitiesChanged(listener: (capabilities: EffectiveCapabilities) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	requireCapability(scope: string): void {
		if (!this.capabilities.scopes.includes(scope)) {
			throw new WorkloadIdentityError('CAPABILITY_NOT_GRANTED', `The optional capability "${scope}" is not granted.`);
		}
	}

	startCapabilityMonitor(intervalMs = 60_000): () => void {
		this.assertNotDisposed();
		if (!Number.isFinite(intervalMs) || intervalMs < 5_000) throw new RangeError('Capability monitor interval must be at least 5000 ms.');
		if (!this.monitor) {
			this.monitor = setInterval(() => {
				void this.getEffectiveCapabilities({ forceRefresh: true }).catch(() => undefined);
			}, intervalMs);
			this.monitor.unref();
		}
		return () => this.stopCapabilityMonitor();
	}

	stopCapabilityMonitor(): void {
		if (this.monitor) clearInterval(this.monitor);
		this.monitor = undefined;
	}

	forRoom(context: ToolCallContext): RoomBoundWorkloadClient {
		this.assertNotDisposed();
		const privateAuthority = managedIngressRoomAuthority(this, context);
		if (
			!privateAuthority ||
			context.runtimeAuthorization !== privateAuthority.sourceAuthorization ||
			context.actor !== privateAuthority.sourceActor ||
			!Object.isFrozen(context)
		) {
			throw new WorkloadIdentityError('PERMISSION_DENIED', 'An authentic managed-ingress room context is required.', 403);
		}
		const authorization = roomAuthorizationFromAuthority(privateAuthority);
		return new RoomBoundWorkloadClient((input, init, throwOnAuthorization) =>
			this.performRoomRequest(authorization, input, init, throwOnAuthorization));
	}

	private async performAuthorizedFetch(target: URL, init: RequestInit, token: string): Promise<Response> {
		this.assertNotDisposed();
		const headers = new Headers(init.headers);
		headers.set('authorization', `DPoP ${token}`);
		headers.set('dpop', this.proof({
			htu: target.toString(),
			htm: init.method ?? 'GET',
			ath: crypto.createHash('sha256').update(token, 'utf8').digest('base64url'),
		}));
		return this.fetchImplementation(target, { ...init, headers });
	}

	async authorizedFetch(input: string | URL, init: WorkloadFetchInit = {}): Promise<Response> {
		this.assertNotDisposed();
		await this.ensureReady();
		this.assertNotDisposed();
		const context = await this.brokerContext();
		this.assertNotDisposed();
		const target = new URL(input, context.hubOrigin);
		if (target.origin !== context.hubOrigin) {
			throw new WorkloadIdentityError('TARGET_ORIGIN_INVALID', 'Workload authorization can only be sent to the bound PrivOS Hub.');
		}
		const { retryMode = 'safe-methods', replayable, requiredScope: _requiredScope, ...requestInit } = init;
		const method = (requestInit.method ?? 'GET').toUpperCase();
		const cacheKey = workspaceAuthorizationKey(context);
		const lease = await this.tokenFor(cacheKey);
		this.assertNotDisposed();
		const response = await this.performAuthorizedFetch(target, requestInit, lease.token.value);
		if (response.status !== 401) return response;
		this.tokens.delete(lease.cacheKey);
		this.contextCapabilities('stale', [], 'AUTHORIZATION_STALE');
		if (!retryAllowed(method, retryMode, replayable)) return response;
		const retryLease = await this.tokenFor(cacheKey, undefined, true);
		const retryResponse = await this.performAuthorizedFetch(target, requestInit, retryLease.token.value);
		if (retryResponse.status === 401) {
			this.tokens.delete(retryLease.cacheKey);
			this.contextCapabilities('stale', [], 'AUTHORIZATION_STALE');
		}
		return retryResponse;
	}

	async authorizedRequest(input: string | URL, init: WorkloadFetchInit = {}): Promise<Response> {
		const response = await this.authorizedFetch(input, init);
		if (response.status === 403) throw new WorkloadPermissionDeniedError(init.requiredScope);
		if (response.status === 401) {
			throw new WorkloadIdentityError('AUTHORIZATION_STALE', 'Workload authorization is stale.', 401);
		}
		return response;
	}

	private async performRoomRequest(
		authorization: RoomAuthorization,
		input: string,
		init: RoomBoundWorkloadFetchInit,
		throwOnAuthorization: boolean,
	): Promise<Response> {
		this.assertNotDisposed();
		if (
			typeof input !== 'string' ||
			!input.startsWith('/') ||
			input.startsWith('//') ||
			Object.prototype.hasOwnProperty.call(init, 'roomId') ||
			Object.prototype.hasOwnProperty.call(init, 'authorizationBindingId')
		) {
			throw new WorkloadIdentityError('TARGET_ORIGIN_INVALID', 'Room-bound requests accept only Hub-relative paths and verified context binding.', 400);
		}
		if (!exactScope(init.requiredScope)) {
			throw new WorkloadIdentityError('PERMISSION_DENIED', 'A single exact permission scope is required.', 403);
		}
		const parsedTarget = new URL(input, 'https://room-bound.invalid');
		assertNoReservedQuery(parsedTarget);
		await assertNoReservedBody(init);
		this.assertNotDisposed();
		await this.ensureReady();
		this.assertNotDisposed();
		const context = await this.brokerContext();
		this.assertNotDisposed();
		assertRoomMatchesBroker(context, authorization);
		const target = new URL(input, context.hubOrigin);
		if (target.origin !== context.hubOrigin) {
			throw new WorkloadIdentityError('TARGET_ORIGIN_INVALID', 'Workload authorization can only be sent to the bound PrivOS Hub.');
		}
		const { retryMode = 'safe-methods', replayable, requiredScope, ...requestInit } = init;
		const method = (requestInit.method ?? 'GET').toUpperCase();
		const cacheKey = roomAuthorizationKey(context, authorization);
		let lease = await this.tokenFor(cacheKey, authorization);
		this.assertNotDisposed();
		if (!lease.token.scopes.includes(requiredScope)) throw new WorkloadPermissionDeniedError(requiredScope);
		let response = await this.performAuthorizedFetch(target, requestInit, lease.token.value);
		if (response.status === 401) {
			this.tokens.delete(lease.cacheKey);
			this.contextCapabilities('stale', [], 'AUTHORIZATION_STALE');
			if (retryAllowed(method, retryMode, replayable)) {
				lease = await this.tokenFor(cacheKey, authorization, true);
				if (!lease.token.scopes.includes(requiredScope)) throw new WorkloadPermissionDeniedError(requiredScope);
				response = await this.performAuthorizedFetch(target, requestInit, lease.token.value);
				if (response.status === 401) {
					this.tokens.delete(lease.cacheKey);
					this.contextCapabilities('stale', [], 'AUTHORIZATION_STALE');
				}
			}
		}
		if (throwOnAuthorization && response.status === 403) throw new WorkloadPermissionDeniedError(requiredScope);
		if (throwOnAuthorization && response.status === 401) {
			throw new WorkloadIdentityError('AUTHORIZATION_STALE', 'Workload authorization is stale.', 401);
		}
		return response;
	}

	async brokerContext(): Promise<WorkloadBrokerContext> {
		this.assertNotDisposed();
		if (!this.context) await this.attest();
		this.assertNotDisposed();
		if (!this.context) throw new WorkloadIdentityError('BROKER_RESPONSE_INVALID', 'The workload broker response is invalid.');
		return this.context;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopCapabilityMonitor();
		this.tokens.clear();
		this.tokenIssuance.clear();
		this.listeners.clear();
	}
}

let defaultClient: WorkloadIdentityClient | undefined;

export function getWorkloadIdentityClient(): WorkloadIdentityClient {
	defaultClient ??= new WorkloadIdentityClient();
	return defaultClient;
}
