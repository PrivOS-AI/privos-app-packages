import WebSocket, { type RawData } from 'ws';

import {
	buildPairingMetadata,
	type AppDescriptor,
	type AppPermissionDescriptor,
} from '../app-descriptor.js';
import type { AuthOptions } from '../auth/user-token.js';
import {
	INVALID_REQUEST,
	PARSE_ERROR,
	errorResponse,
	jsonRpcError,
} from '../protocol/errors.js';
import {
	buildHubUserTokenAuthOptions,
	extractRelayUserTokenCredential,
} from './hub-user-token-actor.js';
import {
	AppServerRuntime,
	DEFAULT_MAX_MESSAGE_BYTES,
	relayCallerAuthSurface,
	resolveCallerCredential,
	type AppErrorMapper,
	type AppMcpHandler,
	type AppServerRuntimeOptions,
	type CallerCredentialExtractor,
	type RelayCallerAuthSurface,
	type RuntimeLimits,
	type UiResourceProvider,
} from '../runtime.js';
import { MessageTooLargeError, rawDataToText } from './message-adapter.js';
import {
	isStandaloneControlMethod,
	type StandaloneRelayIdentityController,
} from './standalone-control.js';
import {
	consumeStandalonePendingIdentity,
	loadStandaloneIdentity,
	loadStandalonePendingIdentity,
	saveStandaloneIdentity,
	saveStandalonePendingIdentity,
	standaloneHubFingerprint,
	type StandaloneIdentityV2,
	type StandalonePendingIdentityV2,
} from './standalone-identity.js';
import { lintManifest, sha256CanonicalJson } from '../manifest-tools.js';
import {
	assertRuntimeDispatchTrustConfigurationV3,
	extractRuntimeDispatchRelayEnvelopeV3,
	verifyRuntimeDispatchAssertionV3,
	type RuntimeDispatchSecurityV3,
	type RuntimeDispatchTrustV3,
	type VerifiedRuntimeDispatchAssertionV3,
} from '../workload/dispatch-assertion.js';

export interface PairAppMeta {
	name: string;
	description?: string;
	version?: string;
	icon?: string;
	scopes?: string[];
	permissions?: AppPermissionDescriptor[];
	/** Exact published schema-v3 `privos-app.json`; sent verbatim, never synthesized from metadata. */
	manifest?: Record<string, unknown>;
}

export type PairingResult = LegacyPairingResult | PendingPairingResult | CompletedPairingResult;

export interface LegacyPairingResult {
	state: 'legacy-complete';
	privosUrl: string;
	clientId: string;
	clientSecret: string;
	mcpAppId?: string;
	pairingVersion?: undefined;
	trust?: undefined;
	fingerprint?: undefined;
	identityFilePath?: undefined;
}

export interface PendingPairingResult {
	state: 'pending-approval';
	privosUrl: string;
	clientId: string;
	clientSecret: string;
	mcpAppId: string;
	pairingVersion: 2;
	pairingId: string;
	oauthClientId: string;
	manifestDigest: string;
	permissionContractHash: string;
	declaredPermissionCeiling: readonly string[];
	hubKid: string;
	fingerprint: string;
	pendingIdentityFilePath?: string;
	trust?: undefined;
	identityFilePath?: undefined;
}

export interface CompletedPairingResult {
	state: 'complete';
	privosUrl: string;
	clientId: string;
	clientSecret: string;
	mcpAppId: string;
	pairingVersion: 2;
	trust: RuntimeDispatchTrustV3;
	/** `SHA256:<hubKid>` — print/compare out-of-band, SSH-host-key style. */
	fingerprint: string;
	manifestDigest: string;
	approvedPermissionCeiling?: readonly string[];
	/** Absolute path the standalone identity file was written to, when persisted. */
	identityFilePath?: string;
}

export interface PairOverWebSocketOptions {
	timeoutMs?: number;
	/**
	 * Persist a v2 pairing result as a standalone identity file. Default `true`
	 * — set `false` only when the caller manages persistence itself.
	 */
	persistIdentityFile?: boolean;
	/** Overrides `PRIVOS_STANDALONE_IDENTITY_FILE` / the SDK default. */
	identityFilePath?: string;
	/** Overrides the separate non-dispatchable pending credential file. */
	pendingIdentityFilePath?: string;
	/** Receives the fingerprint line for out-of-band operator verification; defaults to `console.log`. */
	onFingerprint?: (fingerprint: string) => void;
}

export interface ResumeStandalonePairingOptions extends PairOverWebSocketOptions {
	fetchImpl?: typeof fetch;
	WebSocketImpl?: typeof WebSocket;
	oauthTimeoutMs?: number;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const DEFAULT_PAIRING_TIMEOUT_MS = 30_000;
const DEFAULT_OAUTH_TIMEOUT_MS = 15_000;
const DEFAULT_OPEN_HANDSHAKE_TIMEOUT_MS = 15_000;

type PairingWireResult = {
	paired?: boolean;
	pairingState?: 'pending-approval' | 'complete';
	clientId?: string;
	clientSecret?: string;
	relayUrl?: string;
	mcpAppId?: string;
	appId?: string;
	app?: { _id?: string };
	pairingVersion?: number;
	trust?: unknown;
	fingerprint?: string;
	pairingId?: string;
	oauthClientId?: string;
	manifestDigest?: string;
	permissionContractHash?: string;
	declaredPermissionCeiling?: unknown;
	approvedPermissionCeiling?: unknown;
	hubKid?: string;
};

function sortedUniqueStrings(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
		throw new Error(`Pairing response ${field} is invalid.`);
	}
	const result = [...value].sort();
	if (new Set(result).size !== result.length) throw new Error(`Pairing response ${field} contains duplicates.`);
	return result;
}

function manifestDeclaredPermissionCeiling(manifest: Record<string, unknown>): string[] {
	if (!Array.isArray(manifest.permissions)) throw new Error('Published v3 manifest must declare permissions.');
	return sortedUniqueStrings(
		manifest.permissions.map((permission) =>
			permission && typeof permission === 'object' && !Array.isArray(permission)
				? (permission as Record<string, unknown>).scope
				: undefined,
		),
		'manifest permission ceiling',
	);
}

function hubOriginFromRelayUrl(relayUrl: string): string {
	return relayUrl.replace(/^ws/, 'http').replace(/\/api\/v1\/mcp-apps\.relay.*/, '');
}

async function persistCompletedPairing(input: {
	wire: PairingWireResult;
	privosUrl: string;
	clientId: string;
	clientSecret: string;
	mcpAppId: string;
	options?: PairOverWebSocketOptions;
	pending?: StandalonePendingIdentityV2;
}): Promise<CompletedPairingResult> {
	assertRuntimeDispatchTrustConfigurationV3(input.wire.trust);
	const trust = input.wire.trust;
	const fingerprint = standaloneHubFingerprint(trust.hubKid);
	if (input.wire.fingerprint !== undefined && input.wire.fingerprint !== fingerprint) {
		throw new Error('Pairing response fingerprint does not match the pinned Hub key.');
	}
	if (trust.affinity.mcpAppId !== input.mcpAppId) throw new Error('Pairing completion changed the app identity.');
	if (input.wire.manifestDigest && input.wire.manifestDigest !== trust.affinity.manifestDigest) {
		throw new Error('Pairing completion manifest digest does not match dispatch affinity.');
	}
	let approvedPermissionCeiling: string[] | undefined;
	if (input.wire.approvedPermissionCeiling !== undefined) {
		approvedPermissionCeiling = sortedUniqueStrings(input.wire.approvedPermissionCeiling, 'approvedPermissionCeiling');
	}
	if (input.pending) {
		if (
			input.pending.clientId !== input.clientId ||
			input.pending.oauthClientId !== input.wire.oauthClientId ||
			input.pending.mcpAppId !== input.mcpAppId ||
			input.pending.pairingId !== input.wire.pairingId ||
			input.pending.manifestDigest !== trust.affinity.manifestDigest ||
			input.pending.permissionContractHash !== input.wire.permissionContractHash ||
			input.pending.hubKid !== trust.hubKid ||
			input.pending.fingerprint !== fingerprint
		) {
			throw new Error('Pairing completion does not match the durable pending identity.');
		}
		if (!approvedPermissionCeiling) throw new Error('Pairing completion omitted the approved permission ceiling.');
		const declared = new Set(input.pending.declaredPermissionCeiling);
		if (approvedPermissionCeiling.some((scope) => !declared.has(scope))) {
			throw new Error('Pairing completion widened the published permission ceiling.');
		}
	}
	(input.options?.onFingerprint ?? ((line: string) => console.log(line)))(
		`PrivOS Hub fingerprint: ${fingerprint} — verify this out-of-band before trusting dispatch from this Hub.`,
	);
	let identityFilePath: string | undefined;
	if (input.options?.persistIdentityFile ?? true) {
		const identity: StandaloneIdentityV2 = {
			pairingVersion: 2,
			relayUrl: input.privosUrl,
			clientId: input.clientId,
			clientSecret: input.clientSecret,
			trust,
			fingerprint,
			mcpAppId: input.mcpAppId,
			pairedAt: Date.now(),
		};
		try {
			identityFilePath = await saveStandaloneIdentity(identity, { filePath: input.options?.identityFilePath });
		} catch (error) {
			const existing = loadStandaloneIdentity({ filePath: input.options?.identityFilePath });
			if (
				existing.identity.relayUrl !== identity.relayUrl ||
				existing.identity.clientId !== identity.clientId ||
				existing.identity.clientSecret !== identity.clientSecret ||
				existing.identity.mcpAppId !== identity.mcpAppId ||
				JSON.stringify(existing.identity.trust) !== JSON.stringify(identity.trust)
			) {
				throw error;
			}
			identityFilePath = existing.filePath;
		}
		if (input.pending) {
			await consumeStandalonePendingIdentity(input.pending, {
				filePath: input.options?.pendingIdentityFilePath,
				finalIdentityFilePath: input.options?.identityFilePath,
			});
		}
	}
	return {
		state: 'complete',
		privosUrl: input.privosUrl,
		clientId: input.clientId,
		clientSecret: input.clientSecret,
		mcpAppId: input.mcpAppId,
		pairingVersion: 2,
		trust,
		fingerprint,
		manifestDigest: trust.affinity.manifestDigest,
		...(approvedPermissionCeiling ? { approvedPermissionCeiling } : {}),
		...(identityFilePath ? { identityFilePath } : {}),
	};
}

export interface RelayClientOptions {
	privosUrl: string;
	/**
	 * Required unless `standaloneIdentity` is given, in which case live
	 * credentials are read from the controller on every token request
	 * (rotation-safe) and these are ignored.
	 */
	clientId?: string;
	clientSecret?: string;
	descriptor: AppDescriptor | (() => AppDescriptor | Promise<AppDescriptor>);
	handler: AppMcpHandler;
	ui?: UiResourceProvider;
	auth?: AuthOptions;
	mapAppError?: AppErrorMapper;
	limits?: RuntimeLimits;
	logger?: AppServerRuntimeOptions['logger'];
	/**
	 * Extract credentials from reserved Relay auth surface only (`_meta` / `meta`).
	 * Never receives `params` / `arguments`.
	 */
	extractCallerCredential?: CallerCredentialExtractor<RelayCallerAuthSurface>;
	oauthTimeoutMs?: number;
	/** Timeout waiting for WebSocket `open` after create (default 15s). */
	openHandshakeTimeoutMs?: number;
	/** Injected for tests. */
	fetchImpl?: typeof fetch;
	WebSocketImpl?: typeof WebSocket;
	runtime?: AppServerRuntime;
	/**
	 * Explicit required final-boundary authorization for protocol-v3 publisher
	 * Relay traffic. Ignored when `standaloneIdentity` is given — its pinned
	 * trust is used instead, kept live across trust rotation.
	 */
	runtimeDispatchV3?: RuntimeDispatchSecurityV3;
	/**
	 * Standalone-production identity source (phase 3 pairing). When set, this
	 * is the sole source of Relay OAuth credentials and dispatch trust —
	 * `clientId` / `clientSecret` / `runtimeDispatchV3` are ignored — and
	 * `notifications/privos.standalone*` control messages (secret rotation,
	 * trust rotation, capabilities push) are handled automatically.
	 */
	standaloneIdentity?: StandaloneRelayIdentityController;
	/**
	 * Verify the Hub-signed RS256 user token carried at `_meta.privosUser` and
	 * populate `context.actor` for protocol-v3 runtime dispatch
	 * (`SELF_HOSTED_LOCAL` / `PUBLISHER_HOSTED`) — the assertion itself has no
	 * `actor` claim on this path, so this is the only signed source of caller
	 * identity Relay apps have. Default `'auto'`: wired in automatically using
	 * `privosUrl` as the Hub origin and this app's own `mcpAppId` as audience
	 * whenever `standaloneIdentity` is set, or `runtimeDispatchV3.trust` is a
	 * static (non-resolver) trust record — and only when the caller has not
	 * already supplied `auth` / `extractCallerCredential`. Set `'disabled'` to
	 * opt out entirely.
	 */
	hubUserTokenAuth?: 'auto' | 'disabled';
}

export interface RelayHandle {
	/** Stop reconnecting and close the active socket. */
	stop(): Promise<void>;
	/** Resolves when the first successful connection opens (or rejects if stopped first). */
	whenConnected(): Promise<void>;
	/** True only while the current WebSocket is open past the authenticated handshake. */
	isConnected(): boolean;
}

/**
 * Pair with Privos using a one-time pairing URL.
 *
 * A v1 Hub response (no `pairingVersion`) behaves exactly as before: credentials
 * are returned only, and the caller is responsible for saving them. A v2 Hub
 * response additionally carries Hub dispatch trust; by default this function
 * validates it and persists ONE standalone identity file (mode `0600`, `wx` on
 * create — same discipline as the Hub's own identity file), then prints the
 * Hub fingerprint for out-of-band operator verification. Set
 * `persistIdentityFile: false` to opt out and handle persistence yourself.
 */
export function pairOverWebSocket(
	pairUrl: string,
	appMeta: PairAppMeta,
	WebSocketImpl: typeof WebSocket = WebSocket,
	options?: PairOverWebSocketOptions,
): Promise<PairingResult> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS;
	const persistIdentityFile = options?.persistIdentityFile ?? true;

	return new Promise((resolve, reject) => {
		const ws = new WebSocketImpl(pairUrl);
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};

		const timer = setTimeout(() => {
			settle(() => {
				try {
					ws.close();
				} catch {
					/* ignore */
				}
				reject(new Error(`Pairing timed out after ${timeoutMs}ms`));
			});
		}, timeoutMs);

		async function finishPairing(input: {
			wire: PairingWireResult;
			privosUrl: string;
			clientId: string;
			clientSecret: string;
			mcpAppId?: string;
		}): Promise<PairingResult> {
			if (input.wire.pairingVersion !== 2) {
				// v1 Hub — additive-only, unchanged behavior: no trust, no persistence.
				return {
					state: 'legacy-complete',
					privosUrl: input.privosUrl,
					clientId: input.clientId,
					clientSecret: input.clientSecret,
					mcpAppId: input.mcpAppId,
				};
			}
			if (!input.mcpAppId) throw new Error('Pairing v2 response missing app identity.');
			if (input.wire.pairingState === 'pending-approval') {
				if (!appMeta.manifest) throw new Error('Pending manifest pairing response was not requested with an exact manifest.');
				const declaredPermissionCeiling = sortedUniqueStrings(
					input.wire.declaredPermissionCeiling,
					'declaredPermissionCeiling',
				);
				const localDeclaredPermissionCeiling = manifestDeclaredPermissionCeiling(appMeta.manifest);
				const manifestDigest = sha256CanonicalJson(appMeta.manifest);
				if (
					input.wire.manifestDigest !== manifestDigest ||
					JSON.stringify(declaredPermissionCeiling) !== JSON.stringify(localDeclaredPermissionCeiling) ||
					!input.wire.pairingId ||
					!input.wire.oauthClientId ||
					input.wire.oauthClientId !== input.clientId ||
					!input.wire.permissionContractHash ||
					!input.wire.hubKid
				) {
					throw new Error('Pending pairing response does not match the exact published manifest or OAuth identity.');
				}
				const fingerprint = standaloneHubFingerprint(input.wire.hubKid);
				if (input.wire.fingerprint !== fingerprint) throw new Error('Pending pairing Hub fingerprint is invalid.');
				(options?.onFingerprint ?? ((line: string) => console.log(line)))(
					`PrivOS Hub fingerprint: ${fingerprint} — verify this out-of-band before approving this app.`,
				);
				const pending: StandalonePendingIdentityV2 = {
					pairingVersion: 2,
					state: 'pending-approval',
					relayUrl: input.privosUrl,
					clientId: input.clientId,
					clientSecret: input.clientSecret,
					mcpAppId: input.mcpAppId,
					pairingId: input.wire.pairingId,
					oauthClientId: input.wire.oauthClientId,
					manifestDigest,
					permissionContractHash: input.wire.permissionContractHash,
					declaredPermissionCeiling,
					hubKid: input.wire.hubKid,
					fingerprint,
					createdAt: Date.now(),
				};
				const pendingIdentityFilePath = persistIdentityFile
					? await saveStandalonePendingIdentity(pending, {
							filePath: options?.pendingIdentityFilePath,
							finalIdentityFilePath: options?.identityFilePath,
						})
					: undefined;
				return {
					state: 'pending-approval',
					privosUrl: input.privosUrl,
					clientId: input.clientId,
					clientSecret: input.clientSecret,
					mcpAppId: input.mcpAppId,
					pairingVersion: 2,
					pairingId: pending.pairingId,
					oauthClientId: pending.oauthClientId,
					manifestDigest,
					permissionContractHash: pending.permissionContractHash,
					declaredPermissionCeiling,
					hubKid: pending.hubKid,
					fingerprint,
					...(pendingIdentityFilePath ? { pendingIdentityFilePath } : {}),
				};
			}
			return persistCompletedPairing({
				wire: input.wire,
				privosUrl: input.privosUrl,
				clientId: input.clientId,
				clientSecret: input.clientSecret,
				mcpAppId: input.mcpAppId,
				options,
			});
		}

		ws.on('open', () => {
			try {
				if (appMeta.manifest) {
					const lint = lintManifest(appMeta.manifest);
					if (appMeta.manifest.schemaVersion !== 3 || !lint.valid) {
						throw new Error(`Exact standalone manifest is not a valid schema-v3 manifest: ${lint.errors.join('; ')}`);
					}
				}
				ws.send(
					JSON.stringify({
						name: appMeta.name,
						description: appMeta.description || '',
						version: appMeta.version || '0.0.0',
						...(appMeta.icon && { icon: appMeta.icon }),
						...(appMeta.scopes?.length && { scopes: appMeta.scopes }),
						...(appMeta.permissions?.length && { permissions: appMeta.permissions }),
						...(appMeta.manifest ? { manifest: appMeta.manifest } : {}),
					}),
				);
			} catch (err) {
				settle(() =>
					reject(err instanceof Error ? err : new Error(String(err))),
				);
			}
		});

		ws.on('message', (raw: RawData) => {
			try {
				const msg = JSON.parse(rawDataToText(raw)) as {
					error?: { message?: string };
					result?: PairingWireResult;
				};
				if (msg.error) {
					settle(() => reject(new Error(msg.error?.message || 'Pairing failed')));
					return;
				}
				if (msg.result && (msg.result.paired || msg.result.pairingState === 'pending-approval')) {
					const { clientId, clientSecret, relayUrl, app, mcpAppId, appId } =
						msg.result;
					if (!clientId || !clientSecret || !relayUrl) {
						settle(() => reject(new Error('Pairing response missing credentials')));
						return;
					}
					const privosUrl = hubOriginFromRelayUrl(relayUrl);
					const resolvedAppId =
						(typeof mcpAppId === 'string' && mcpAppId) ||
						(typeof appId === 'string' && appId) ||
						(typeof app?._id === 'string' && app._id) ||
						undefined;

					settle(() => {
						void finishPairing({
							wire: msg.result!,
							privosUrl,
							clientId,
							clientSecret,
							mcpAppId: resolvedAppId,
						})
							.then(resolve)
							.catch(reject);
					});
					try {
						ws.close();
					} catch {
						/* ignore */
					}
				}
			} catch (err) {
				settle(() =>
					reject(err instanceof Error ? err : new Error(String(err))),
				);
			}
		});

		ws.on('error', (err) => {
			settle(() => reject(new Error(`Pairing failed: ${err.message}`)));
		});

		ws.on('close', (code, reason) => {
			// Any close before a paired result ends the promise (including 1000).
			settle(() => {
				if (code === 1000) {
					reject(new Error('Pairing closed before credentials were received'));
				} else {
					reject(new Error(`Pairing closed: ${code} ${reason}`));
				}
			});
		});
	});
}

/**
 * Explicitly resumes one durable app-announced-manifest pairing. This is a
 * single operator/app action, not a polling loop: a pending Hub replies
 * pending; an approved Hub returns trust for the same OAuth/app/pairing
 * identity and the SDK atomically promotes it to the production identity.
 */
export async function resumeStandalonePairing(options?: ResumeStandalonePairingOptions): Promise<PendingPairingResult | CompletedPairingResult> {
	const loaded = loadStandalonePendingIdentity({
		filePath: options?.pendingIdentityFilePath,
		finalIdentityFilePath: options?.identityFilePath,
	});
	const pending = loaded.identity;
	const fetchImpl = options?.fetchImpl ?? fetch;
	const WebSocketImpl = options?.WebSocketImpl ?? WebSocket;
	const controller = new AbortController();
	const oauthTimer = setTimeout(() => controller.abort(), options?.oauthTimeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS);
	let accessToken: string;
	try {
		const response = await fetchImpl(`${pending.relayUrl}/oauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: `grant_type=client_credentials&client_id=${encodeURIComponent(pending.clientId)}&client_secret=${encodeURIComponent(pending.clientSecret)}`,
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`Pairing completion OAuth failed: ${response.status} ${response.statusText}`);
		const token = (await response.json()) as { access_token?: string };
		if (!token.access_token) throw new Error('Pairing completion OAuth response omitted access_token.');
		accessToken = token.access_token;
	} finally {
		clearTimeout(oauthTimer);
	}

	const timeoutMs = options?.timeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS;
	const wire = await new Promise<PairingWireResult>((resolve, reject) => {
		const wsUrl = `${pending.relayUrl.replace(/^http/, 'ws')}/api/v1/mcp-apps.relay?pairingCompletion=1`;
		const ws = new WebSocketImpl(wsUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const timer = setTimeout(() => {
			settle(() => reject(new Error(`Pairing completion timed out after ${timeoutMs}ms`)));
			try { ws.close(); } catch { /* ignore */ }
		}, timeoutMs);
		ws.on('message', (raw: RawData) => {
			try {
				const message = JSON.parse(rawDataToText(raw)) as { result?: PairingWireResult; error?: { message?: string } };
				if (message.error) return settle(() => reject(new Error(message.error?.message || 'Pairing completion failed')));
				if (message.result?.pairingVersion !== 2) return settle(() => reject(new Error('Pairing completion response is not protocol v2.')));
				settle(() => resolve(message.result!));
				try { ws.close(); } catch { /* ignore */ }
			} catch (error) {
				settle(() => reject(error instanceof Error ? error : new Error(String(error))));
			}
		});
		ws.on('error', (error) => settle(() => reject(new Error(`Pairing completion failed: ${error.message}`))));
		ws.on('close', (code, reason) => settle(() => reject(new Error(`Pairing completion closed: ${code} ${reason}`))));
	});

	if (
		wire.clientId !== pending.clientId ||
		wire.oauthClientId !== pending.oauthClientId ||
		wire.appId !== pending.mcpAppId ||
		wire.pairingId !== pending.pairingId ||
		wire.manifestDigest !== pending.manifestDigest ||
		wire.permissionContractHash !== pending.permissionContractHash ||
		wire.hubKid !== pending.hubKid ||
		wire.fingerprint !== pending.fingerprint
	) {
		throw new Error('Pairing resume response does not match the durable pending identity.');
	}
	if (wire.pairingState === 'pending-approval') {
		const declaredPermissionCeiling = sortedUniqueStrings(wire.declaredPermissionCeiling, 'declaredPermissionCeiling');
		if (JSON.stringify(declaredPermissionCeiling) !== JSON.stringify(pending.declaredPermissionCeiling)) {
			throw new Error('Pairing resume changed the declared permission ceiling.');
		}
		return {
			state: 'pending-approval',
			privosUrl: pending.relayUrl,
			clientId: pending.clientId,
			clientSecret: pending.clientSecret,
			mcpAppId: pending.mcpAppId,
			pairingVersion: 2,
			pairingId: pending.pairingId,
			oauthClientId: pending.oauthClientId,
			manifestDigest: pending.manifestDigest,
			permissionContractHash: pending.permissionContractHash,
			declaredPermissionCeiling: pending.declaredPermissionCeiling,
			hubKid: pending.hubKid,
			fingerprint: pending.fingerprint,
			pendingIdentityFilePath: loaded.filePath,
		};
	}
	if (wire.pairingState !== 'complete' || !wire.clientSecret || wire.clientSecret !== pending.clientSecret) {
		throw new Error('Pairing resume did not return an exact completed identity.');
	}
	return persistCompletedPairing({
		wire,
		privosUrl: pending.relayUrl,
		clientId: pending.clientId,
		clientSecret: pending.clientSecret,
		mcpAppId: pending.mcpAppId,
		options,
		pending,
	});
}

export async function pairFromDescriptor(
	pairUrl: string,
	descriptor: AppDescriptor,
	WebSocketImpl?: typeof WebSocket,
	options?: PairOverWebSocketOptions,
): Promise<PairingResult> {
	return pairOverWebSocket(
		pairUrl,
		buildPairingMetadata(descriptor),
		WebSocketImpl,
		options,
	);
}

/**
 * Connect to PrivOS relay WebSocket with exponential backoff, token refresh,
 * single reconnect timer, and explicit stop().
 */
export function connectRelay(opts: RelayClientOptions): RelayHandle {
	if (!opts.standaloneIdentity && (!opts.clientId || !opts.clientSecret)) {
		throw new Error('connectRelay requires clientId and clientSecret, or a standaloneIdentity controller.');
	}
	const fetchImpl = opts.fetchImpl ?? fetch;
	const WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
	const effectiveRuntimeDispatchV3: RuntimeDispatchSecurityV3 | undefined = opts.standaloneIdentity
		? {
				mode: 'required',
				trust: () => opts.standaloneIdentity!.getTrust(),
			}
		: opts.runtimeDispatchV3;

	// `mcpAppId` is only known synchronously (without racing an async
	// descriptor resolution) when it comes from already-loaded dispatch trust:
	// standalone identity (rotation-safe via `getTrust()`) or a static
	// (non-resolver) `runtimeDispatchV3.trust`. A dynamic trust resolver has no
	// single app-wide `mcpAppId` to pin ahead of the first verified dispatch,
	// so auto-wiring is skipped for that case — the app can still call
	// `buildHubUserTokenAuthOptions` / `extractRelayUserTokenCredential` itself.
	const staticTrustAffinity =
		opts.runtimeDispatchV3 && typeof opts.runtimeDispatchV3.trust !== 'function'
			? opts.runtimeDispatchV3.trust.affinity
			: undefined;
	const hubUserTokenAudience: string | (() => string) | undefined = opts.standaloneIdentity
		? () => opts.standaloneIdentity!.getTrust().affinity.mcpAppId
		: staticTrustAffinity?.mcpAppId;
	const autoHubUserTokenAuth =
		(opts.hubUserTokenAuth ?? 'auto') === 'auto' &&
		!opts.auth &&
		!opts.extractCallerCredential &&
		hubUserTokenAudience !== undefined;
	const effectiveAuth: AuthOptions | undefined = autoHubUserTokenAuth
		? buildHubUserTokenAuthOptions({ hubOrigin: opts.privosUrl, audience: hubUserTokenAudience! })
		: opts.auth;
	const effectiveExtractCallerCredential = autoHubUserTokenAuth
		? extractRelayUserTokenCredential
		: opts.extractCallerCredential;

	const runtime =
		opts.runtime ??
		new AppServerRuntime({
			descriptor: opts.descriptor,
			handler: opts.handler,
			ui: opts.ui,
			auth: effectiveAuth,
			mapAppError: opts.mapAppError,
			limits: opts.limits,
			logger: opts.logger,
		});

	const maxMessageBytes =
		opts.limits?.maxMessageBytes ??
		runtime.getLimits().maxMessageBytes ??
		DEFAULT_MAX_MESSAGE_BYTES;
	const oauthTimeoutMs = opts.oauthTimeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
	const openHandshakeTimeoutMs =
		opts.openHandshakeTimeoutMs ?? DEFAULT_OPEN_HANDSHAKE_TIMEOUT_MS;
	const maxBufferedBytes = runtime.getLimits().maxBufferedBytes;

	let stopped = false;
	let activeWs: WebSocket | null = null;
	let wsAuthenticated = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let openHandshakeTimer: ReturnType<typeof setTimeout> | null = null;
	let backoffIndex = 0;
	let connectGeneration = 0;
	let oauthAbort: AbortController | null = null;

	let connectedResolve: (() => void) | null = null;
	let connectedReject: ((err: Error) => void) | null = null;
	let connectedOnce = false;
	const connectedPromise = new Promise<void>((resolve, reject) => {
		connectedResolve = resolve;
		connectedReject = reject;
	});
	// Prevent unhandledrejection when consumers never call whenConnected().
	// Explicit await whenConnected() still receives the rejection.
	void connectedPromise.catch(() => undefined);

	const log = (event: string, fields: Record<string, unknown> = {}) => {
		opts.logger?.(event, fields);
	};

	const clearReconnectTimer = () => {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	};

	const clearOpenHandshakeTimer = () => {
		if (openHandshakeTimer) {
			clearTimeout(openHandshakeTimer);
			openHandshakeTimer = null;
		}
	};

	const scheduleReconnect = () => {
		if (stopped) return;
		if (reconnectTimer) return;
		const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)] ?? 30_000;
		backoffIndex = Math.min(backoffIndex + 1, BACKOFF_MS.length - 1);
		log('relay.reconnect.scheduled', { delayMs: delay });
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			void openConnection().catch((err) => {
				log('relay.open_unhandled', {
					message: err instanceof Error ? err.message : String(err),
				});
			});
		}, delay);
	};

	async function getAccessToken(signal: AbortSignal): Promise<string> {
		const credentials = opts.standaloneIdentity
			? opts.standaloneIdentity.getCredentials()
			: { clientId: opts.clientId!, clientSecret: opts.clientSecret! };
		const res = await fetchImpl(`${opts.privosUrl}/oauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: `grant_type=client_credentials&client_id=${encodeURIComponent(credentials.clientId)}&client_secret=${encodeURIComponent(credentials.clientSecret)}`,
			signal,
		});
		if (!res.ok) throw new Error(`OAuth token failed: ${res.status} ${res.statusText}`);
		const data = (await res.json()) as { access_token?: string };
		if (!data.access_token) throw new Error('No access_token in response');
		return data.access_token;
	}

	async function openConnection(): Promise<void> {
		if (stopped) return;
		const generation = ++connectGeneration;
		oauthAbort?.abort();
		oauthAbort = new AbortController();
		const oauthTimer = setTimeout(() => oauthAbort?.abort(), oauthTimeoutMs);

		try {
			const accessToken = await getAccessToken(oauthAbort.signal);
			if (stopped || generation !== connectGeneration) return;

			const wsUrl = opts.privosUrl.replace(/^http/, 'ws') + '/api/v1/mcp-apps.relay';
			const ws = new WebSocketImpl(wsUrl, {
				headers: { Authorization: `Bearer ${accessToken}` },
			});

			if (activeWs && activeWs !== ws) {
				try {
					activeWs.removeAllListeners();
					activeWs.close();
				} catch {
					/* ignore */
				}
			}
			activeWs = ws;

			clearOpenHandshakeTimer();
			openHandshakeTimer = setTimeout(() => {
				openHandshakeTimer = null;
				if (stopped || generation !== connectGeneration) return;
				if (ws.readyState === WebSocketImpl.OPEN) return;
				log('relay.open_handshake_timeout', {
					generation,
					timeoutMs: openHandshakeTimeoutMs,
				});
				try {
					ws.close();
				} catch {
					/* ignore */
				}
				// close handler schedules reconnect when generation still current
			}, openHandshakeTimeoutMs);

			ws.on('open', () => {
				clearOpenHandshakeTimer();
				if (stopped || generation !== connectGeneration) {
					try {
						ws.close();
					} catch {
						/* ignore */
					}
					return;
				}
				backoffIndex = 0;
				wsAuthenticated = true;
				log('relay.connected', { generation });
				if (!connectedOnce) {
					connectedOnce = true;
					connectedResolve?.();
				}
			});

			ws.on('message', (raw: RawData) => {
				void handleMessage(ws, generation, raw).catch((err) => {
					log('relay.message_unhandled', {
						reason: 'handler_failed',
						generation,
						...(err instanceof Error ? { name: err.name } : {}),
					});
				});
			});

			ws.on('ping', () => {
				try {
					ws.pong();
				} catch {
					/* ignore */
				}
			});

			ws.on('close', (code) => {
				clearOpenHandshakeTimer();
				log('relay.disconnected', { code, generation });
				if (activeWs === ws) {
					activeWs = null;
					wsAuthenticated = false;
				}
				if (!stopped && generation === connectGeneration) {
					scheduleReconnect();
				}
			});

			ws.on('error', (err) => {
				log('relay.ws_error', { reason: 'ws_error', generation, name: err.name });
			});
		} catch (err) {
			log('relay.connect_failed', {
				message: err instanceof Error ? err.message : String(err),
				generation,
			});
			if (!stopped && generation === connectGeneration) {
				scheduleReconnect();
			}
		} finally {
			clearTimeout(oauthTimer);
		}
	}

	function safeSend(
		ws: WebSocket,
		payload: unknown,
		rpcFields: { generation?: number; method?: string; toolName?: string } = {},
	): void {
		if (ws.readyState !== WebSocketImpl.OPEN) return;
		if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > maxBufferedBytes) {
			log('relay.backpressure', {
				bufferedAmount: ws.bufferedAmount,
				maxBufferedBytes,
			});
			return;
		}
		let text: string;
		try {
			text = JSON.stringify(payload);
		} catch {
			log('relay.serialize_error', { reason: 'json_stringify_failed' });
			return;
		}
		try {
			const payloadObject =
				payload && typeof payload === 'object' && !Array.isArray(payload)
					? (payload as Record<string, unknown>)
					: undefined;
			const responseId =
				payloadObject &&
				Object.prototype.hasOwnProperty.call(payloadObject, 'id') &&
				(typeof payloadObject.id === 'string' ||
					typeof payloadObject.id === 'number' ||
					payloadObject.id === null)
					? (payloadObject.id as string | number | null)
					: undefined;
			log('relay.rpc.outbound', {
				direction: '→',
				...rpcFields,
				...(responseId !== undefined ? { requestId: responseId } : {}),
				responseKind: payloadObject && 'error' in payloadObject ? 'error' : 'result',
			});
			ws.send(text, (err) => {
				if (err) {
					log('relay.send_error', { reason: 'send_callback_error', name: err.name });
				}
			});
		} catch (err) {
			log('relay.send_error', {
				reason: 'send_threw',
				...(err instanceof Error ? { name: err.name } : {}),
			});
		}
	}

	async function handleMessage(
		ws: WebSocket,
		generation: number,
		raw: RawData,
	): Promise<void> {
		if (stopped || generation !== connectGeneration) return;

		let text: string;
		try {
			text = rawDataToText(raw, maxMessageBytes);
		} catch (err) {
			log('relay.message_too_large', {
				message: err instanceof Error ? err.message : String(err),
				...(err instanceof MessageTooLargeError
					? { bytes: err.bytes, maxBytes: err.maxBytes }
					: {}),
			});
			try {
				ws.close(1009, 'Message too large');
			} catch {
				/* ignore */
			}
			return;
		}

		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(text);
		} catch {
			safeSend(ws, errorResponse(null, jsonRpcError(PARSE_ERROR, 'Parse error')), {
				generation,
			});
			return;
		}

		const transportMsgObj =
			parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)
				? (parsedJson as Record<string, unknown>)
				: {};

		// Standalone-production control channel: secret rotation, trust rotation,
		// and capabilities push arrive as reserved notifications on this same
		// authenticated connection. They are never MCP dispatch and are handled
		// (verified against the currently pinned Hub key) before anything else.
		if (opts.standaloneIdentity && isStandaloneControlMethod(transportMsgObj.method)) {
			try {
				await opts.standaloneIdentity.handleControlNotification(transportMsgObj.method, transportMsgObj.params);
				log('relay.standalone_control.applied', { generation, method: transportMsgObj.method });
			} catch (err) {
				log('relay.standalone_control.rejected', {
					generation,
					method: transportMsgObj.method,
					message: err instanceof Error ? err.message : String(err),
				});
			}
			return;
		}

		let dispatchObject: unknown = parsedJson;
		let runtimeAuthorization: VerifiedRuntimeDispatchAssertionV3 | undefined;
		const isRequest = typeof transportMsgObj.method === 'string';
		const transportParams = isRecord(transportMsgObj.params) ? transportMsgObj.params : undefined;
		const transportMeta = isRecord(transportParams?._meta) ? transportParams._meta : undefined;
		const hasRuntimeAuthorization = Boolean(
			transportMeta && Object.prototype.hasOwnProperty.call(transportMeta, 'privosAuthorization'),
		);
		if (isRequest && effectiveRuntimeDispatchV3) {
			try {
				if (hasTopLevelRuntimeMetadata(transportMsgObj)) {
					throw new Error('dispatch_assertion_ambiguous');
				}
				if (!hasRuntimeAuthorization) {
					throw new Error('dispatch_assertion_missing');
				} else {
					const envelope = extractRuntimeDispatchRelayEnvelopeV3(parsedJson);
					runtimeAuthorization = await verifyRuntimeDispatchAssertionV3({
						compact: envelope.authorization.assertion,
						body: envelope.logicalRpc,
						security: effectiveRuntimeDispatchV3,
						relayAuthorization: envelope.authorization,
					});
					dispatchObject = envelope.logicalRpc;
				}
			} catch {
				safeSend(ws, dispatchAuthorizationError(transportMsgObj), { generation });
				return;
			}
		} else if (isRequest && (hasRuntimeAuthorization || hasTopLevelRuntimeMetadata(transportMsgObj))) {
			safeSend(ws, dispatchAuthorizationError(transportMsgObj), { generation });
			return;
		}
		const msgObj =
			dispatchObject && typeof dispatchObject === 'object' && !Array.isArray(dispatchObject)
				? (dispatchObject as Record<string, unknown>)
				: {};

		const authSurface = relayCallerAuthSurface(transportMsgObj);
		const credentialResolution = await resolveCallerCredential(
			effectiveExtractCallerCredential,
			authSurface,
		);

		const requestId =
			Object.prototype.hasOwnProperty.call(msgObj, 'id') &&
			(typeof msgObj.id === 'string' || typeof msgObj.id === 'number' || msgObj.id === null)
				? (msgObj.id as string | number | null)
				: undefined;
		const method = typeof msgObj.method === 'string' ? msgObj.method : undefined;
		const params =
			msgObj.params && typeof msgObj.params === 'object' && !Array.isArray(msgObj.params)
				? (msgObj.params as Record<string, unknown>)
				: undefined;
		const toolName =
			method === 'tools/call' && typeof params?.name === 'string' ? params.name : undefined;
		log('relay.rpc.inbound', {
			direction: '←',
			generation,
			...(requestId !== undefined ? { requestId } : { notification: true }),
			...(method ? { method } : {}),
			...(toolName ? { toolName } : {}),
		});

		let context;
		try {
			context = await runtime.buildContext({
				transport: 'relay',
				requestId,
				sessionScope: `ws:${generation}`,
				credentialResolution,
				...(runtimeAuthorization ? { runtimeAuthorization } : {}),
			});
		} catch (error) {
			if (runtimeAuthorization && error instanceof Error && error.message === 'dispatch_assertion_binding_mismatch') {
				safeSend(ws, dispatchAuthorizationError(msgObj), { generation, method, toolName });
				return;
			}
			throw error;
		}

		const outcome = await runtime.dispatchObject(dispatchObject, context);

		if (outcome.type === 'no_response' || outcome.type === 'protocol_warning') {
			return;
		}

		safeSend(ws, outcome.response, { generation, method, toolName });
	}

	void openConnection().catch((err) => {
		log('relay.open_unhandled', {
			message: err instanceof Error ? err.message : String(err),
		});
	});

	return {
		whenConnected: () => connectedPromise,
		isConnected: () => wsAuthenticated && activeWs !== null && activeWs.readyState === WebSocketImpl.OPEN,
		async stop() {
			stopped = true;
			wsAuthenticated = false;
			clearReconnectTimer();
			clearOpenHandshakeTimer();
			connectGeneration += 1;
			oauthAbort?.abort();
			oauthAbort = null;
			const ws = activeWs;
			activeWs = null;
			if (ws) {
				await new Promise<void>((resolve) => {
					try {
						ws.once('close', () => resolve());
						ws.close();
						setTimeout(resolve, 0);
					} catch {
						resolve();
					}
				});
			}
			if (!connectedOnce) {
				connectedReject?.(new Error('Relay stopped before connecting'));
			}
			log('relay.stopped', {});
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasTopLevelRuntimeMetadata(message: Record<string, unknown>): boolean {
	const containsReserved = (value: unknown): boolean => isRecord(value) &&
		(Object.prototype.hasOwnProperty.call(value, 'privosAuthorization') ||
			Object.prototype.hasOwnProperty.call(value, 'privosUser'));
	return containsReserved(message._meta) ||
		containsReserved(message.meta) ||
		Object.prototype.hasOwnProperty.call(message, 'privosAuthorization') ||
		Object.prototype.hasOwnProperty.call(message, 'privosUser');
}

function dispatchAuthorizationError(message: Record<string, unknown>) {
	const id = Object.prototype.hasOwnProperty.call(message, 'id') &&
		(typeof message.id === 'string' || typeof message.id === 'number' || message.id === null)
		? message.id
		: null;
	return errorResponse(id, jsonRpcError(INVALID_REQUEST, 'Authenticated private dispatch required', {
		code: 'DISPATCH_ASSERTION_INVALID',
	}));
}
