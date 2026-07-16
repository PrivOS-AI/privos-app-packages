import type { IdentityEnforcementMode } from './identity-mode.js';
import type { ToolCallContext, VerifiedActor } from './tool-call-context.js';

export class IdentityAssertionError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = 'IdentityAssertionError';
		this.code = code;
	}
}

/**
 * Pure helper — does not read tool arguments.
 * App decides whether a call requires an actor, then calls this.
 */
export function assertActorAvailable(
	context: ToolCallContext,
	mode: IdentityEnforcementMode,
): VerifiedActor {
	if (context.identityState === 'verified' && context.actor) {
		return context.actor;
	}

	if (context.identityState === 'invalid') {
		throw new IdentityAssertionError(
			'IDENTITY_INVALID',
			'Caller identity token is invalid',
		);
	}

	if (mode === 'enforce') {
		throw new IdentityAssertionError(
			'IDENTITY_REQUIRED',
			'Verified caller identity is required',
		);
	}

	throw new IdentityAssertionError(
		'IDENTITY_MISSING',
		'Verified caller identity is missing',
	);
}

/**
 * Pure helper — `legacyId` must be extracted by the app and passed explicitly.
 * Runtime never inspects MCP tool arguments.
 * Mismatch rejects in both observe and enforce modes.
 */
export function assertActorMatchesLegacyId(
	actor: VerifiedActor,
	legacyId: string | undefined | null,
): void {
	if (legacyId == null || legacyId === '') return;
	if (actor.userId !== legacyId) {
		throw new IdentityAssertionError(
			'IDENTITY_MISMATCH',
			'Verified actor does not match legacy user id',
		);
	}
}
