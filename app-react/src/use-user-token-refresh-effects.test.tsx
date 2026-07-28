import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';

import { msUntilUserTokenRefresh } from './user-token.js';
import { useUserTokenRefreshEffects } from './use-user-token-refresh-effects.js';

function fakeJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	return `${header}.${body}.sig`;
}

describe('useUserTokenRefreshEffects', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('re-arms the exp timer when a HOST-pushed fresher token arrives', () => {
		const refreshUserToken = vi.fn(async () => ({ token: null, refreshed: false }));
		const now = 1_000_000;
		vi.setSystemTime(now);

		const farExpSec = Math.floor(now / 1000) + 10 * 60;
		const soonExpSec = Math.floor(now / 1000) + 90;
		const farToken = fakeJwt({ exp: farExpSec, jti: 'a' });
		const soonToken = fakeJwt({ exp: soonExpSec, jti: 'b' });

		const { rerender } = renderHook(
			(props: { token: string; refreshEpoch: number }) => {
				const backoffUntilMsRef = useRef(0);
				useUserTokenRefreshEffects({
					token: props.token,
					refreshEpoch: props.refreshEpoch,
					refreshUserToken,
					backoffUntilMsRef,
					enabled: true,
				});
			},
			{ initialProps: { token: farToken, refreshEpoch: 0 } },
		);

		const farDelay = msUntilUserTokenRefresh(farToken, now);
		expect(farDelay).not.toBeNull();
		expect(farDelay!).toBeGreaterThan(0);

		// Advance partway through far delay — must not fire yet.
		vi.advanceTimersByTime(Math.floor(farDelay! / 2));
		expect(refreshUserToken).not.toHaveBeenCalled();

		// Simulate HOST_CONTEXT_CHANGED applying a sooner-expiring fresher token.
		rerender({ token: soonToken, refreshEpoch: 0 });

		const soonDelay = msUntilUserTokenRefresh(soonToken, now)!;
		expect(soonDelay).toBeLessThan(farDelay!);

		vi.advanceTimersByTime(soonDelay);
		expect(refreshUserToken).toHaveBeenCalledTimes(1);
		expect(refreshUserToken).toHaveBeenCalledWith('exp');
	});

	it('calls refreshUserToken on visibility when inside skew', () => {
		const refreshUserToken = vi.fn(async () => ({ token: null, refreshed: false }));
		const now = 2_000_000;
		vi.setSystemTime(now);
		const expSec = Math.floor(now / 1000) + 30;
		const token = fakeJwt({ exp: expSec });

		renderHook(() => {
			const backoffUntilMsRef = useRef(0);
			useUserTokenRefreshEffects({
				token,
				refreshEpoch: 0,
				refreshUserToken,
				backoffUntilMsRef,
				enabled: true,
			});
		});

		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => 'visible',
		});
		document.dispatchEvent(new Event('visibilitychange'));
		expect(refreshUserToken).toHaveBeenCalledWith('visibility');
	});
});
