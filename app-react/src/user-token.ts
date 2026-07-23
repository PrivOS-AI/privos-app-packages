/**
 * Client-side helpers for Hub short-lived userToken refresh scheduling.
 * Payload decode is not verification — app backends still verify via JWKS.
 */

/** Refresh this many ms before JWT `exp` so in-flight calls do not race expiry. */
export const USER_TOKEN_REFRESH_SKEW_MS = 60_000;

/** Floor for timer delays (avoids tight loops when clock skew is small). */
export const USER_TOKEN_REFRESH_MIN_DELAY_MS = 5_000;

/**
 * When `exp` cannot be read, re-fetch context on this cadence while the tab is open.
 * Hub staging tokens have historically been ~5 minutes; stay under that.
 */
export const USER_TOKEN_REFRESH_FALLBACK_MS = 4 * 60_000;

/** After a refresh that did not yield a fresher token, wait before auto-retry. */
export const USER_TOKEN_REFRESH_FAILED_BACKOFF_MS = 30_000;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const trimmed = token.trim();
	const parts = trimmed.split('.');
	if (parts.length < 2) return null;
	const segment = parts[1];
	if (!segment) return null;
	try {
		const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
		const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
		const json = atob(b64 + pad);
		const parsed: unknown = JSON.parse(json);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Unix-ms expiry from JWT payload `exp`, or null if missing/unreadable. */
export function readUserTokenExpMs(token: string): number | null {
	const payload = decodeJwtPayload(token);
	if (!payload) return null;
	const exp = payload.exp;
	if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return null;
	return Math.floor(exp * 1000);
}

/**
 * True when the token is unreadable, already expired, or within the refresh skew.
 * Empty/whitespace tokens return false — callers should gate on a non-empty token first.
 */
export function shouldRefreshUserTokenNow(
	token: string,
	nowMs: number = Date.now(),
	skewMs: number = USER_TOKEN_REFRESH_SKEW_MS,
): boolean {
	const trimmed = token.trim();
	if (!trimmed) return false;
	const expMs = readUserTokenExpMs(trimmed);
	if (expMs == null) return true;
	return expMs - skewMs <= nowMs;
}

/**
 * Delay until the next proactive `mcpapp.context.get` refresh.
 * `0` means refresh as soon as the event loop allows.
 */
export function msUntilUserTokenRefresh(
	token: string,
	nowMs: number = Date.now(),
	options?: {
		skewMs?: number;
		minDelayMs?: number;
		fallbackMs?: number;
	},
): number | null {
	const trimmed = token.trim();
	if (!trimmed) return null;

	const skewMs = options?.skewMs ?? USER_TOKEN_REFRESH_SKEW_MS;
	const minDelayMs = options?.minDelayMs ?? USER_TOKEN_REFRESH_MIN_DELAY_MS;
	const fallbackMs = options?.fallbackMs ?? USER_TOKEN_REFRESH_FALLBACK_MS;

	const expMs = readUserTokenExpMs(trimmed);
	if (expMs == null) return fallbackMs;

	const raw = expMs - skewMs - nowMs;
	if (raw <= 0) return 0;
	return Math.max(minDelayMs, raw);
}

/** Prefer a candidate token when it is non-empty and not older than the current one. */
export function isFresherUserToken(current: string, candidate: string): boolean {
	const next = candidate.trim();
	if (!next) return false;
	const prev = current.trim();
	if (!prev) return true;
	if (next === prev) return false;

	const prevExp = readUserTokenExpMs(prev);
	const nextExp = readUserTokenExpMs(next);
	// Accept same-exp rotations (Hub may re-sign without extending lifetime).
	if (prevExp != null && nextExp != null) return nextExp >= prevExp;
	// Different opaque string without comparable exp — accept Hub's new value.
	return true;
}

/** True for the backend identity-invalid messages the UI may surface in banners. */
export function isIdentityTokenErrorMessage(message: string): boolean {
	return /Caller identity token is invalid|IDENTITY_INVALID/i.test(message);
}

export function toolResultLooksIdentityInvalid(result: unknown): boolean {
	if (!result || typeof result !== 'object') return false;
	const row = result as { isError?: boolean; content?: Array<{ text?: string }> };
	if (!row.isError) return false;
	const text = row.content?.[0]?.text ?? '';
	return isIdentityTokenErrorMessage(text);
}

export interface UserTokenRefreshResult {
	/** Latest usable token after the attempt (may be unchanged). */
	token: string | null;
	/** True when Hub returned a fresher JWT than we had. */
	refreshed: boolean;
}
