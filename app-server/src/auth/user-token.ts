import {
	createLocalJWKSet,
	createRemoteJWKSet,
	jwtVerify,
	type JWTPayload,
	type JSONWebKeySet,
	type JWTVerifyGetKey,
} from 'jose';

import type { VerifiedActor } from '../context/tool-call-context.js';

export interface AuthOptions {
	jwksUrl: string | URL | (() => string | URL);
	audience: string | readonly string[] | (() => string | readonly string[]);
	issuer?: string | readonly string[];
	clockToleranceSeconds?: number;
	/** Mapped to jose `createRemoteJWKSet` `cacheMaxAge` (ms). */
	jwksCacheTtlMs?: number;
	fetchTimeoutMs?: number;
	/**
	 * Test/injection escape hatch — when set, skips remote JWKS fetch.
	 * Production code should leave this unset.
	 */
	localJwks?: JSONWebKeySet;
}

export interface CallerCredential {
	token: string;
	/** e.g. Direct `X-MCP-User-Id` — cross-checked against verified `sub`. */
	assertedUserId?: string;
	source: 'direct-header' | 'relay-metadata' | 'custom';
}

export type VerifyUserTokenResult =
	| { ok: true; actor: VerifiedActor }
	| { ok: false; reason: 'missing' | 'invalid'; message: string };

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function resolveUrl(value: string | URL | (() => string | URL)): URL {
	const raw = typeof value === 'function' ? value() : value;
	return raw instanceof URL ? raw : new URL(raw);
}

function resolveAudience(
	value: string | readonly string[] | (() => string | readonly string[]),
): string | string[] {
	const raw = typeof value === 'function' ? value() : value;
	if (typeof raw === 'string') return raw;
	return [...raw];
}

function resolveIssuer(value: string | readonly string[] | undefined): string | string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === 'string') return value;
	return [...value];
}

function getJwks(options: AuthOptions): ReturnType<typeof createRemoteJWKSet> {
	const url = resolveUrl(options.jwksUrl);
	const cacheKey = `${url.toString()}|${options.jwksCacheTtlMs ?? ''}|${options.fetchTimeoutMs ?? ''}`;
	let jwks = jwksCache.get(cacheKey);
	if (!jwks) {
		jwks = createRemoteJWKSet(url, {
			timeoutDuration: options.fetchTimeoutMs ?? 5_000,
			...(options.jwksCacheTtlMs !== undefined
				? { cacheMaxAge: options.jwksCacheTtlMs }
				: {}),
		});
		jwksCache.set(cacheKey, jwks);
	}
	return jwks;
}

/** Test helper — verify against an in-memory JWKS (no network). */
export function createLocalJwksVerifier(jwks: JSONWebKeySet) {
	return createLocalJWKSet(jwks);
}

export function clearJwksCache(): void {
	jwksCache.clear();
}

function getVerifier(options: AuthOptions): JWTVerifyGetKey {
	if (options.localJwks) {
		return createLocalJWKSet(options.localJwks);
	}
	return getJwks(options);
}

function actorFromPayload(payload: JWTPayload): VerifiedActor {
	if (!payload.sub) {
		throw new Error('JWT missing sub claim');
	}
	const username =
		typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined;
	const roomId = typeof payload.rid === 'string' ? payload.rid : undefined;
	return {
		userId: payload.sub,
		...(username !== undefined ? { username } : {}),
		...(roomId !== undefined ? { roomId } : {}),
		claims: { ...payload } as Record<string, unknown>,
	};
}

/**
 * Verify a Hub-signed RS256 user JWT via JWKS.
 * Algorithm is fixed to RS256 — HS256 / none are rejected by jose verify options.
 */
export async function verifyUserToken(
	token: string | undefined,
	options: AuthOptions,
	assertedUserId?: string,
): Promise<VerifyUserTokenResult> {
	if (!token) {
		return { ok: false, reason: 'missing', message: 'Missing caller token' };
	}

	try {
		const audience = resolveAudience(options.audience);
		const issuer = resolveIssuer(options.issuer);
		const { payload } = await jwtVerify(token, getVerifier(options), {
			audience,
			algorithms: ['RS256'],
			clockTolerance: options.clockToleranceSeconds ?? 30,
			...(issuer ? { issuer } : {}),
		});

		const actor = actorFromPayload(payload);
		if (assertedUserId !== undefined && assertedUserId !== '' && assertedUserId !== actor.userId) {
			return {
				ok: false,
				reason: 'invalid',
				message: 'X-MCP-User-Id does not match verified token subject',
			};
		}

		return { ok: true, actor };
	} catch (err) {
		return {
			ok: false,
			reason: 'invalid',
			message: err instanceof Error ? err.message : 'Token verification failed',
		};
	}
}

/**
 * Convenience for app-owned HTTP routes (non-MCP).
 * Throws on missing/invalid token — mirrors the former template `verifyPrivosUser`.
 */
export async function verifyPrivosUser(
	authHeader: string | undefined,
	options: AuthOptions,
): Promise<VerifiedActor> {
	const token =
		authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : undefined;
	const result = await verifyUserToken(token, options);
	if (!result.ok) {
		throw new Error(result.message);
	}
	return result.actor;
}
