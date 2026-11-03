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

	it('lifts the Hub-signed room_roles / workspace_roles claims onto the actor', async () => {
		const { jwks, sign, aud } = await mintTestKeys();
		const token = await sign({
			sub: 'user-1',
			rid: 'room-9',
			room_roles: ['owner', 'moderator'],
			workspace_roles: ['admin', 'user'],
		});
		const result = await verifyUserToken(token, {
			jwksUrl: 'http://unused.invalid/jwks',
			audience: aud,
			localJwks: jwks,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.actor.roomRoles).toEqual(['owner', 'moderator']);
			expect(result.actor.workspaceRoles).toEqual(['admin', 'user']);
			// Empty room_roles ("plain member") is preserved, never dropped.
			expect(result.actor.claims.room_roles).toEqual(['owner', 'moderator']);
		}
	});

	it('omits the typed role fields when the token carries no role claims', async () => {
		const { jwks, sign, aud } = await mintTestKeys();
		const token = await sign({ sub: 'user-1', rid: 'room-9' });
		const result = await verifyUserToken(token, {
			jwksUrl: 'http://unused.invalid/jwks',
			audience: aud,
			localJwks: jwks,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.actor.roomRoles).toBeUndefined();
			expect(result.actor.workspaceRoles).toBeUndefined();
		}
	});

	it('lifts caller_app / cross_room onto the actor and ignores malformed values', async () => {
		const { jwks, sign, aud } = await mintTestKeys();
		const opts = { jwksUrl: 'http://unused.invalid/jwks', audience: aud, localJwks: jwks };
		const ok = await verifyUserToken(await sign({ sub: 'u', rid: 'r', caller_app: 'ai.x.app', cross_room: true }), opts);
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(ok.actor.callerApp).toBe('ai.x.app');
			expect(ok.actor.crossRoom).toBe(true);
		}
		const bad = await verifyUserToken(await sign({ sub: 'u', caller_app: 7, cross_room: 'yes' }), opts);
		expect(bad.ok).toBe(true);
		if (bad.ok) {
			expect(bad.actor.callerApp).toBeUndefined();
			expect(bad.actor.crossRoom).toBeUndefined();
		}
	});

	it('lifts ptype=bot onto the actor and ignores absent or malformed values', async () => {
		const { jwks, sign, aud } = await mintTestKeys();
		const opts = { jwksUrl: 'http://unused.invalid/jwks', audience: aud, localJwks: jwks };
		const bot = await verifyUserToken(await sign({ sub: 'u', ptype: 'bot' }), opts);
		expect(bot.ok && bot.actor.principalType).toBe('bot');
		for (const extra of [{}, { ptype: 'human' }, { ptype: true }, { ptype: ['bot'] }]) {
			const r = await verifyUserToken(await sign({ sub: 'u', ...extra }), opts);
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.actor.principalType).toBeUndefined();
		}
	});
});
