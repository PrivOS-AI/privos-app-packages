/**
 * Hub-signed RS256 user token verification for the Relay transport.
 *
 * Protocol-v3 runtime dispatch (`SELF_HOSTED_LOCAL` / `PUBLISHER_HOSTED`) has
 * no room for an `actor` claim inside the signed dispatch assertion — only
 * the managed-Cluster assertion variant carries one
 * (`dispatch-assertion.ts` `CLUSTER_DISPATCH_V3_OPTIONAL_KEYS`). Instead, the
 * Hub sends caller identity for these apps as a SEPARATE short-lived RS256
 * JWT at `params._meta.privosUser.userToken`, verifiable against the Hub's
 * published JWKS (`/.well-known/mcp-apps/jwks.json`).
 *
 * The plain `userId` / `username` / `roomId` fields that ride alongside the
 * token are NOT proof of anything — only the signed token is. This module
 * never builds a `VerifiedActor` from those plain fields; `userId` is passed
 * through only as `assertedUserId`, which `verifyUserToken` cross-checks
 * against the verified token's `sub` and REJECTS on mismatch — it never
 * substitutes for verification.
 */
import type { AuthOptions, CallerCredential } from '../auth/user-token.js';
import type { RelayCallerAuthSurface } from '../runtime.js';

/** Path the Hub serves its MCP-app user-token JWKS at (`mcp-user-token-jwks.ts`). */
export const DEFAULT_HUB_USER_TOKEN_JWKS_PATH = '/.well-known/mcp-apps/jwks.json';

/** Mirrors the Hub JWKS route's own `Cache-Control: max-age=300`. */
const DEFAULT_JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * The Hub mints these tokens with a 5-minute TTL and no built-in future-skew
 * budget beyond clock drift — 5s mirrors the dispatch-assertion verifier's
 * own default skew (`dispatch-assertion.ts` `clockSkewSeconds`), not the
 * generic 30s default `verifyUserToken` uses for other callers.
 */
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;

const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

/**
 * Validate and normalize a Hub origin used only for user-token JWKS
 * verification. Always a caller-supplied, config-time value (Relay
 * `RelayClientOptions.privosUrl`, or a Direct/Cluster workload broker's
 * `hubOrigin`) — an inbound WebSocket/HTTP message field must never reach
 * this function.
 */
export function validateHubUserTokenOrigin(origin: string): string {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error('Invalid Hub origin for user-token JWKS verification.');
	}
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error('Invalid Hub origin for user-token JWKS verification.');
	}
	return url.origin;
}

export interface HubUserTokenAuthOptions {
	/** Config-time Hub origin — see {@link validateHubUserTokenOrigin}. */
	hubOrigin: string;
	/** This app's own `mcpAppId` — checked against the token's `aud` claim. */
	audience: string | readonly string[] | (() => string | readonly string[]);
	/** Default {@link DEFAULT_HUB_USER_TOKEN_JWKS_PATH}. */
	jwksPath?: string;
	issuer?: string | readonly string[];
	clockToleranceSeconds?: number;
	jwksCacheTtlMs?: number;
	fetchTimeoutMs?: number;
}

/**
 * Builds `AuthOptions` for verifying a Hub-signed user token against the Hub
 * JWKS. Production-plaintext-HTTP refusal, JWKS-fetch timeout bounding, and
 * unknown-`kid` refetch-once-then-fail all live in the shared
 * `auth/user-token.ts` verifier this feeds — this function only assembles
 * the pointer at the correct, trusted origin.
 */
export function buildHubUserTokenAuthOptions(input: HubUserTokenAuthOptions): AuthOptions {
	const origin = validateHubUserTokenOrigin(input.hubOrigin);
	const jwksUrl = new URL(input.jwksPath ?? DEFAULT_HUB_USER_TOKEN_JWKS_PATH, origin);
	return {
		jwksUrl,
		audience: input.audience,
		...(input.issuer !== undefined ? { issuer: input.issuer } : {}),
		clockToleranceSeconds: input.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
		jwksCacheTtlMs: input.jwksCacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS,
		fetchTimeoutMs: input.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Built-in Relay `CallerCredentialExtractor` for the Hub-signed user token.
 * Reads only the signed `userToken`; `userId` rides along as
 * `assertedUserId`, cross-checked (never trusted on its own) by
 * `verifyUserToken` against the token's verified `sub`.
 *
 * Returns `undefined` — never throws — when `_meta.privosUser` is absent or
 * malformed, so a caller with no usable token degrades to
 * `identityState: 'missing'` (fail closed) rather than failing dispatch.
 */
export function extractRelayUserTokenCredential(
	surface: RelayCallerAuthSurface,
): CallerCredential | undefined {
	const meta = surface._meta;
	if (!isRecord(meta) || !Object.prototype.hasOwnProperty.call(meta, 'privosUser')) {
		return undefined;
	}
	const privosUser = meta.privosUser;
	if (!isRecord(privosUser) || typeof privosUser.userToken !== 'string' || !privosUser.userToken) {
		return undefined;
	}
	const assertedUserId =
		typeof privosUser.userId === 'string' && privosUser.userId ? privosUser.userId : undefined;
	return {
		token: privosUser.userToken,
		...(assertedUserId !== undefined ? { assertedUserId } : {}),
		source: 'relay-metadata',
	};
}
