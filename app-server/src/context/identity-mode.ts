export type IdentityEnforcementMode = 'observe' | 'enforce';

export function parseIdentityEnforcementMode(
	value: string | undefined,
	fallback: IdentityEnforcementMode = 'observe',
): IdentityEnforcementMode {
	if (value === 'observe' || value === 'enforce') return value;
	return fallback;
}
