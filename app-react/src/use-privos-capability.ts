import { usePrivosContext } from './use-privos-context';

export type PrivosCapabilityState = Readonly<{
	resolved: boolean;
	granted: boolean;
	scope: string;
}>;

/** Presentation/degradation helper only; Hub remains the authorization authority. */
export function usePrivosCapability(scope: string): PrivosCapabilityState {
	const { effectiveScopes } = usePrivosContext();
	return {
		resolved: Array.isArray(effectiveScopes),
		granted: Array.isArray(effectiveScopes) && effectiveScopes.includes(scope),
		scope,
	};
}
