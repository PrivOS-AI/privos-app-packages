/**
 * Convenience hook that returns the current user's signed identity token.
 *
 * The hub mints a short-lived RS256 JWT and pushes it to the iframe on every
 * HOST_CONTEXT_CHANGED event. Tokens are scoped to a single app (aud=appId) and
 * expire after ~5 minutes, so they cannot be replayed to other apps or stale sessions.
 *
 * Usage — forward the token when calling your app's own backend:
 *
 *   const token = usePrivosUserToken();
 *   fetch('/api/your-endpoint', {
 *     headers: { Authorization: `Bearer ${token}` },
 *   });
 *
 * On the backend, verify the token via the hub JWKS before trusting the userId.
 * See the template `server.ts` for the recommended `verifyPrivosUser()` pattern.
 * Without verification, never trust any client-supplied userId — it is forgeable.
 */
import { usePrivosContext } from './use-privos-context';

export function usePrivosUserToken(): string | undefined {
	const { userToken } = usePrivosContext();
	return userToken;
}
