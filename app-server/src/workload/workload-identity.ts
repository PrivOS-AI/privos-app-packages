import crypto, { type JsonWebKey } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

export const DEFAULT_WORKLOAD_SOCKET = '/run/privos/identity.sock';

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
	| 'READINESS_DENIED'
	| 'TOKEN_DENIED'
	| 'TOKEN_RESPONSE_INVALID'
	| 'TARGET_ORIGIN_INVALID'
	| 'AUTHORIZATION_STALE'
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
	requiredScope?: string;
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

function retryAllowed(method: string, mode: WorkloadFetchInit['retryMode']): boolean {
	if (mode === 'never') return false;
	if (mode === 'idempotent') return true;
	return ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(method);
}

export class WorkloadIdentityClient {
	private readonly socketPath: string;
	private readonly fetchImplementation: FetchImplementation;
	private readonly brokerRequester?: BrokerRequester;
	private readonly now: () => number;
	private readonly refreshSkewMs: number;
	private readonly privateJwk: JsonWebKey;
	private readonly publicJwk: JsonWebKey;
	private token?: CachedToken;
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
		const nonce = crypto.randomBytes(24).toString('base64url');
		const broker = await this.requestBroker({ op: 'attest', publicJwk: this.publicJwk, nonce });
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
		if (this.ready) return;
		this.contextCapabilities('pairing', []);
		const { broker, nonce } = await this.attest();
		const target = `${broker.hubOrigin}/api/v1/mcp-workload.ready`;
		const response = await this.fetchImplementation(target, {
			method: 'POST',
			headers: { 'content-type': 'application/json', dpop: this.proof({ htu: target, htm: 'POST', nonce }) },
			body: JSON.stringify({ attestation: broker.attestation }),
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			this.contextCapabilities('stale', [], 'READINESS_DENIED');
			throw new WorkloadIdentityError('READINESS_DENIED', 'PrivOS did not accept workload readiness.', response.status);
		}
		this.ready = true;
		this.contextCapabilities('paired', []);
	}

	private async issueAccessToken(): Promise<CachedToken> {
		await this.ensureReady();
		const { broker, nonce } = await this.attest();
		const target = `${broker.hubOrigin}/api/v1/mcp-workload.token`;
		const response = await this.fetchImplementation(target, {
			method: 'POST',
			headers: { 'content-type': 'application/json', dpop: this.proof({ htu: target, htm: 'POST', nonce }) },
			body: JSON.stringify({ attestation: broker.attestation }),
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			this.token = undefined;
			this.contextCapabilities('stale', [], 'TOKEN_DENIED');
			throw new WorkloadIdentityError('TOKEN_DENIED', 'PrivOS did not issue workload authorization.', response.status);
		}
		let body: { access_token?: unknown; expires_in?: unknown; token_type?: unknown; scope?: unknown };
		try {
			body = await response.json() as typeof body;
		} catch {
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
		this.token = token;
		this.contextCapabilities('active', scopes);
		return token;
	}

	async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
		if (!options.forceRefresh && this.token && this.token.expiresAt - this.now() > this.refreshSkewMs) return this.token.value;
		return (await this.issueAccessToken()).value;
	}

	async getEffectiveCapabilities(options: { forceRefresh?: boolean } = {}): Promise<EffectiveCapabilities> {
		await this.getAccessToken(options);
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

	private async performAuthorizedFetch(target: URL, init: RequestInit, token: string): Promise<Response> {
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
		await this.ensureReady();
		const context = await this.brokerContext();
		const target = new URL(input, context.hubOrigin);
		if (target.origin !== context.hubOrigin) {
			throw new WorkloadIdentityError('TARGET_ORIGIN_INVALID', 'Workload authorization can only be sent to the bound PrivOS Hub.');
		}
		const { retryMode = 'safe-methods', requiredScope: _requiredScope, ...requestInit } = init;
		const method = (requestInit.method ?? 'GET').toUpperCase();
		const token = await this.getAccessToken();
		const response = await this.performAuthorizedFetch(target, requestInit, token);
		if (response.status !== 401) return response;
		this.token = undefined;
		this.contextCapabilities('stale', [], 'AUTHORIZATION_STALE');
		if (!retryAllowed(method, retryMode)) return response;
		const retryToken = await this.getAccessToken({ forceRefresh: true });
		return this.performAuthorizedFetch(target, requestInit, retryToken);
	}

	async authorizedRequest(input: string | URL, init: WorkloadFetchInit = {}): Promise<Response> {
		const response = await this.authorizedFetch(input, init);
		if (response.status === 403) throw new WorkloadPermissionDeniedError(init.requiredScope);
		if (response.status === 401) {
			throw new WorkloadIdentityError('AUTHORIZATION_STALE', 'Workload authorization is stale.', 401);
		}
		return response;
	}

	async brokerContext(): Promise<WorkloadBrokerContext> {
		if (!this.context) await this.attest();
		if (!this.context) throw new WorkloadIdentityError('BROKER_RESPONSE_INVALID', 'The workload broker response is invalid.');
		return this.context;
	}

	dispose(): void {
		this.stopCapabilityMonitor();
		this.token = undefined;
		this.listeners.clear();
	}
}

let defaultClient: WorkloadIdentityClient | undefined;

export function getWorkloadIdentityClient(): WorkloadIdentityClient {
	defaultClient ??= new WorkloadIdentityClient();
	return defaultClient;
}
