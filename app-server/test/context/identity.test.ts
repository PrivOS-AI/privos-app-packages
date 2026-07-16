import { describe, expect, it } from 'vitest';

import {
	assertActorAvailable,
	assertActorMatchesLegacyId,
	IdentityAssertionError,
} from '../../src/context/identity-assertions.js';
import type { ToolCallContext, VerifiedActor } from '../../src/context/tool-call-context.js';

const actor: VerifiedActor = {
	userId: 'u1',
	claims: { sub: 'u1' },
};

function ctx(partial: Partial<ToolCallContext>): ToolCallContext {
	return {
		transport: 'direct',
		identityState: 'missing',
		sessionScope: 'test',
		...partial,
	};
}

describe('identity assertions', () => {
	it('assertActorAvailable returns actor when verified', () => {
		expect(
			assertActorAvailable(ctx({ identityState: 'verified', actor }), 'enforce'),
		).toEqual(actor);
	});

	it('enforce rejects missing identity', () => {
		expect(() => assertActorAvailable(ctx({ identityState: 'missing' }), 'enforce')).toThrow(
			IdentityAssertionError,
		);
	});

	it('invalid never degrades to missing', () => {
		try {
			assertActorAvailable(ctx({ identityState: 'invalid' }), 'observe');
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(IdentityAssertionError);
			expect((err as IdentityAssertionError).code).toBe('IDENTITY_INVALID');
		}
	});

	it('assertActorMatchesLegacyId rejects mismatch in both modes (pure fn)', () => {
		expect(() => assertActorMatchesLegacyId(actor, 'other')).toThrow(/does not match/);
		expect(() => assertActorMatchesLegacyId(actor, 'u1')).not.toThrow();
		expect(() => assertActorMatchesLegacyId(actor, undefined)).not.toThrow();
	});

	it('helpers do not accept or inspect tool arguments objects', () => {
		// Compile-time / API shape check: only (actor, legacyId string).
		expect(assertActorMatchesLegacyId.length).toBe(2);
		expect(assertActorAvailable.length).toBe(2);
	});
});
