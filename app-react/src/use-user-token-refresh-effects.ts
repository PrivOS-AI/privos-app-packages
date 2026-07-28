/**
 * Shared exp-timer + visibility/focus triggers for Hub userToken refresh.
 *
 * Does NOT own single-flight or failed-backoff mutation — callers implement those
 * inside their own `refreshUserToken` and pass `backoffUntilMsRef` for read-only
 * delay adjustment.
 *
 * `token` and `refreshEpoch` must be reactive props so HOST-pushed fresher tokens
 * (and no-op refresh attempts) re-arm the timer.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';

import {
	msUntilUserTokenRefresh,
	shouldRefreshUserTokenNow,
	type UserTokenRefreshResult,
} from './user-token.js';

export interface UseUserTokenRefreshEffectsOptions {
	/** Current JWT — reactive; HOST push that changes the string re-arms the timer. */
	token: string;
	/**
	 * Bumped after every refresh attempt (success or not) so the timer re-arms
	 * even when the JWT string is unchanged.
	 */
	refreshEpoch: number;
	refreshUserToken: (reason: string) => Promise<UserTokenRefreshResult>;
	/** Same ref the caller's refreshUserToken writes on failure / no-fresher. */
	backoffUntilMsRef: MutableRefObject<number>;
	/** When false, neither timer nor visibility listeners are armed. */
	enabled?: boolean;
}

export function useUserTokenRefreshEffects(options: UseUserTokenRefreshEffectsOptions): void {
	const {
		token,
		refreshEpoch,
		refreshUserToken,
		backoffUntilMsRef,
		enabled = true,
	} = options;

	const tokenRef = useRef(token);
	tokenRef.current = token;

	// Proactive refresh from JWT exp.
	useEffect(() => {
		if (!enabled) return;
		if (!token) return;

		let delay = msUntilUserTokenRefresh(token);
		if (delay == null) return;
		const backoffLeft = backoffUntilMsRef.current - Date.now();
		if (delay === 0 && backoffLeft > 0) {
			delay = backoffLeft;
		}

		const id = window.setTimeout(() => {
			void refreshUserToken('exp');
		}, delay);
		return () => window.clearTimeout(id);
	}, [token, refreshEpoch, refreshUserToken, enabled, backoffUntilMsRef]);

	// Visibility / focus: catch expiry that happened while the tab was hidden.
	useEffect(() => {
		if (!enabled) return;

		const maybeRefresh = () => {
			const current = tokenRef.current;
			if (!current) return;
			if (!shouldRefreshUserTokenNow(current)) return;
			const backoffLeft = backoffUntilMsRef.current - Date.now();
			if (backoffLeft > 0) return;
			void refreshUserToken('visibility');
		};

		const onVisibility = () => {
			if (document.visibilityState === 'visible') maybeRefresh();
		};
		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('focus', maybeRefresh);
		return () => {
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('focus', maybeRefresh);
		};
	}, [refreshUserToken, enabled, backoffUntilMsRef]);
}
