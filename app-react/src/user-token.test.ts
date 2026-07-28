import { describe, expect, it } from 'vitest';

import {
	isFresherUserToken,
	msUntilUserTokenRefresh,
	readUserTokenExpMs,
	shouldRefreshUserTokenNow,
	USER_TOKEN_REFRESH_FALLBACK_MS,
	USER_TOKEN_REFRESH_SKEW_MS,
	isIdentityTokenErrorMessage,
	toolResultLooksIdentityInvalid,
} from './user-token.js';

function fakeJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	return `${header}.${body}.sig`;
}

describe('readUserTokenExpMs', () => {
	it('reads exp as unix ms', () => {
		const exp = 1_700_000_000;
		expect(readUserTokenExpMs(fakeJwt({ exp }))).toBe(exp * 1000);
	});

	it('returns null for garbage', () => {
		expect(readUserTokenExpMs('not-a-jwt')).toBeNull();
		expect(readUserTokenExpMs('')).toBeNull();
	});
});

describe('shouldRefreshUserTokenNow', () => {
	it('is true inside skew window', () => {
		const now = 1_000_000;
		const expSec = Math.floor((now + USER_TOKEN_REFRESH_SKEW_MS - 1) / 1000);
		expect(shouldRefreshUserTokenNow(fakeJwt({ exp: expSec }), now)).toBe(true);
	});

	it('is false when exp is comfortably ahead', () => {
		const now = 1_000_000;
		const expSec = Math.floor((now + USER_TOKEN_REFRESH_SKEW_MS + 120_000) / 1000);
		expect(shouldRefreshUserTokenNow(fakeJwt({ exp: expSec }), now)).toBe(false);
	});

	it('is false for empty token', () => {
		expect(shouldRefreshUserTokenNow('', 0)).toBe(false);
	});
});

describe('msUntilUserTokenRefresh', () => {
	it('returns 0 when already inside skew', () => {
		const now = 5_000_000;
		const expSec = Math.floor(now / 1000) + 10;
		expect(msUntilUserTokenRefresh(fakeJwt({ exp: expSec }), now)).toBe(0);
	});

	it('uses fallback when exp is missing', () => {
		expect(msUntilUserTokenRefresh(fakeJwt({ sub: 'u1' }), 0)).toBe(USER_TOKEN_REFRESH_FALLBACK_MS);
	});

	it('returns null for empty token', () => {
		expect(msUntilUserTokenRefresh('')).toBeNull();
	});
});

describe('isFresherUserToken', () => {
	it('rejects identical or empty candidates', () => {
		const token = fakeJwt({ exp: 100 });
		expect(isFresherUserToken(token, token)).toBe(false);
		expect(isFresherUserToken(token, '')).toBe(false);
	});

	it('accepts a later or equal exp when the string differs', () => {
		const older = fakeJwt({ exp: 100, jti: 'a' });
		const newer = fakeJwt({ exp: 200, jti: 'b' });
		const rotated = fakeJwt({ exp: 100, jti: 'c' });
		expect(isFresherUserToken(older, newer)).toBe(true);
		expect(isFresherUserToken(newer, older)).toBe(false);
		expect(isFresherUserToken(older, rotated)).toBe(true);
	});
});

describe('isIdentityTokenErrorMessage', () => {
	it('matches backend identity-invalid copy', () => {
		expect(isIdentityTokenErrorMessage('Caller identity token is invalid')).toBe(true);
		expect(isIdentityTokenErrorMessage('IDENTITY_INVALID')).toBe(true);
		expect(isIdentityTokenErrorMessage('Failed to load threads')).toBe(false);
	});
});

describe('toolResultLooksIdentityInvalid', () => {
	it('reads MCP isError tool payloads', () => {
		expect(
			toolResultLooksIdentityInvalid({
				isError: true,
				content: [{ type: 'text', text: 'Caller identity token is invalid' }],
			}),
		).toBe(true);
		expect(toolResultLooksIdentityInvalid({ isError: false, content: [] })).toBe(false);
	});
});
