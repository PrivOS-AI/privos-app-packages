import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { verifyUserToken } from '../../src/auth/user-token.js';

async function mintTestKeys(aud = 'app.test') {
	const { privateKey, publicKey } = await generateKeyPair('RS256');
	const jwk = await exportJWK(publicKey);
	jwk.kid = 'test-kid';
	jwk.alg = 'RS256';
	jwk.use = 'sig';
	const jwks = { keys: [jwk] };

	async function sign(claims: Record<string, unknown>, expSecs = 300) {
		return new SignJWT(claims)
			.setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
			.setIssuedAt()
			.setExpirationTime(`${expSecs}s`)
			.setAudience(aud)
			.sign(privateKey);
	}

	return { jwks, sign, aud };
}

describe('verifyUserToken', () => {
	it('verifies a valid RS256 token', async () => {
		const { jwks, sign, aud } = await mintTestKeys();
		const token = await sign({ sub: 'user-1', preferred_username: 'alice', rid: 'room-9' });
		const result = await verifyUserToken(token, {
			jwksUrl: 'http://unused.invalid/jwks',
			audience: aud,
			localJwks: jwks,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.actor.userId).toBe('user-1');
			expect(result.actor.username).toBe('alice');
			expect(result.actor.roomId).toBe('room-9');
		}
	});

	it('rejects missing token as missing', async () => {
		const result = await verifyUserToken(undefined, {
			jwksUrl: 'http://unused.invalid/jwks',
			audience: 'app.test',
			localJwks: { keys: [] },
		});
		expect(result).toEqual({
			ok: false,
			reason: 'missing',
			message: 'Missing caller token',
		});
	});

	it('rejects assertedUserId mismatch as invalid', async () => {
		const { jwks, sign, aud } = await mintTestKeys();
		const token = await sign({ sub: 'user-1' });
		const result = await verifyUserToken(
			token,
			{ jwksUrl: 'http://unused.invalid/jwks', audience: aud, localJwks: jwks },
			'other-user',
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('invalid');
	});

	it('rejects wrong audience', async () => {
		const { jwks, sign } = await mintTestKeys('app.a');
		const token = await sign({ sub: 'user-1' });
		const result = await verifyUserToken(token, {
			jwksUrl: 'http://unused.invalid/jwks',
			audience: 'app.b',
			localJwks: jwks,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('invalid');
	});
});
