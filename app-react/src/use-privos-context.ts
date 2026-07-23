/**
 * Subscribes to HOST_CONTEXT_CHANGED and fetches `mcpapp.context.get`.
 * Owns short-lived Hub userToken refresh (single-flight + backoff) and exposes
 * `refreshUserToken` / `userTokenGeneration` for identity recovery UIs.
 *
 * Do not call this hook alongside another HOST listener in the same iframe —
 * `PrivosAppProvider` stores `onhostcontextchanged` as a module-level singleton.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { parseToolResult } from './parse-tool-result.js';
import { usePrivosApp } from './use-privos-app';
import {
	isFresherUserToken,
	USER_TOKEN_REFRESH_FAILED_BACKOFF_MS,
	type UserTokenRefreshResult,
} from './user-token.js';
import { useUserTokenRefreshEffects } from './use-user-token-refresh-effects.js';

export interface PrivosContext {
	userId: string;
	username: string;
	theme: string;
	roomId: string;
	roomName: string;
	userRoles: string[];
	/**
	 * Short-lived RS256 JWT issued by the hub.
	 * Forward to your app backend as `Authorization: Bearer <userToken>` and verify via JWKS.
	 * Proactively refreshed before `exp`; see `refreshUserToken` / `userTokenGeneration`.
	 */
	userToken?: string;
	/**
	 * Increments when a fresher `userToken` is applied (proactive refresh, visibility,
	 * IDENTITY_INVALID recovery, or HOST_CONTEXT). Clear identity banners on change.
	 */
	userTokenGeneration: number;
	/** Re-fetch Hub context; single-flight. Resolves with the token after the attempt. */
	refreshUserToken: (reason?: string) => Promise<UserTokenRefreshResult>;
}

type PrivosContextState = Omit<PrivosContext, 'userTokenGeneration' | 'refreshUserToken'>;

const defaultState: PrivosContextState = {
	userId: '',
	username: '',
	theme: 'light',
	roomId: '',
	roomName: '',
	userRoles: [],
	userToken: undefined,
};

function mergeHostContext(
	prev: PrivosContextState,
	patch: Record<string, unknown>,
): PrivosContextState {
	const userId = String(patch.userId ?? prev.userId ?? '');
	// Empty/whitespace `userToken` is "no change" — layout-only HOST_CONTEXT_CHANGED
	// often omits the field or sends ''; never clear a still-usable cached JWT here.
	const incomingToken = typeof patch.userToken === 'string' ? patch.userToken.trim() : '';
	const userToken = incomingToken || prev.userToken || undefined;
	// Empty/whitespace username is "no change" (layout-only pushes).
	const incomingUsername = typeof patch.username === 'string' ? patch.username.trim() : '';
	const username = (incomingUsername || prev.username || '').trim();

	return {
		userId,
		username,
		theme: String(patch.theme ?? prev.theme ?? 'light'),
		roomId: String(patch.roomId ?? prev.roomId ?? ''),
		roomName: String(patch.roomName ?? prev.roomName ?? ''),
		userRoles: Array.isArray(patch.userRoles)
			? (patch.userRoles as string[])
			: prev.userRoles,
		userToken: userToken || undefined,
	};
}

export function usePrivosContext(): PrivosContext {
	const app = usePrivosApp();
	const [context, setContext] = useState<PrivosContextState>(defaultState);
	const [tokenRefreshEpoch, setTokenRefreshEpoch] = useState(0);
	const [userTokenGeneration, setUserTokenGeneration] = useState(0);
	const ctxRef = useRef(context);
	ctxRef.current = context;
	const refreshPromiseRef = useRef<Promise<UserTokenRefreshResult> | null>(null);
	const tokenRefreshBackoffUntilMs = useRef(0);

	const refreshUserToken = useCallback(
		async (reason = 'manual'): Promise<UserTokenRefreshResult> => {
			if (refreshPromiseRef.current) {
				return refreshPromiseRef.current;
			}

			const run = (async (): Promise<UserTokenRefreshResult> => {
				try {
					const raw = await app.callServerTool({
						name: 'mcpapp.context.get',
						arguments: {},
					});
					const data = parseToolResult(raw);
					const prevToken = ctxRef.current.userToken ?? '';
					const nextToken = typeof data.userToken === 'string' ? data.userToken.trim() : '';
					if (nextToken && isFresherUserToken(prevToken, nextToken)) {
						tokenRefreshBackoffUntilMs.current = 0;
						const merged = mergeHostContext(ctxRef.current, data);
						ctxRef.current = merged;
						setContext(merged);
						setUserTokenGeneration((n) => n + 1);
						return { token: nextToken, refreshed: true };
					}
					tokenRefreshBackoffUntilMs.current =
						Date.now() + USER_TOKEN_REFRESH_FAILED_BACKOFF_MS;
					const { userToken: _ignored, ...rest } = data;
					void _ignored;
					if (Object.keys(rest).length > 0) {
						const merged = mergeHostContext(ctxRef.current, rest);
						ctxRef.current = merged;
						setContext(merged);
					}
					const current = (ctxRef.current.userToken ?? '').trim();
					return { token: current || null, refreshed: false };
				} catch {
					tokenRefreshBackoffUntilMs.current =
						Date.now() + USER_TOKEN_REFRESH_FAILED_BACKOFF_MS;
					const current = (ctxRef.current.userToken ?? '').trim();
					return { token: current || null, refreshed: false };
				} finally {
					refreshPromiseRef.current = null;
					setTokenRefreshEpoch((n) => n + 1);
				}
			})();

			refreshPromiseRef.current = run;
			return run;
		},
		[app],
	);

	useEffect(() => {
		app.onhostcontextchanged = (ctx: Record<string, unknown>) => {
			const incomingToken =
				typeof ctx.userToken === 'string' ? ctx.userToken.trim() : '';
			if (incomingToken && isFresherUserToken(ctxRef.current.userToken ?? '', incomingToken)) {
				tokenRefreshBackoffUntilMs.current = 0;
				setUserTokenGeneration((n) => n + 1);
			}
			setContext((prev) => {
				const merged = mergeHostContext(prev, ctx);
				ctxRef.current = merged;
				return merged;
			});
		};

		void (async () => {
			try {
				const raw = await app.callServerTool({
					name: 'mcpapp.context.get',
					arguments: {},
				});
				const data = parseToolResult(raw);
				setContext((prev) => {
					const merged = mergeHostContext(prev, data);
					ctxRef.current = merged;
					return merged;
				});
			} catch {
				/* HOST_CONTEXT_CHANGED may still arrive */
			}
		})();

		return () => {
			app.onhostcontextchanged = undefined;
		};
	}, [app]);

	useUserTokenRefreshEffects({
		token: context.userToken ?? '',
		refreshEpoch: tokenRefreshEpoch,
		refreshUserToken,
		backoffUntilMsRef: tokenRefreshBackoffUntilMs,
		enabled: true,
	});

	return {
		...context,
		userTokenGeneration,
		refreshUserToken,
	};
}
