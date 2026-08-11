/**
 * Render an approved external provider (YouTube, Figma) inside your app.
 *
 * Your app document is sandboxed without `allow-same-origin`, so it runs in an opaque origin and
 * providers refuse to initialize in any iframe you create yourself — an admin-approved origin
 * still shows an empty box. This hook asks the host to render the provider frame instead, outside
 * that sandbox, positioned over a placeholder element you own.
 *
 *   function Video() {
 *     const { ref, state, reason } = useProviderEmbed('https://www.youtube.com/embed/M7lc1UVf-VE');
 *     return (
 *       <div ref={ref} style={{ width: '100%', aspectRatio: '16 / 9' }}>
 *         {state !== 'granted' && <Fallback state={state} reason={reason} />}
 *       </div>
 *     );
 *   }
 *
 * Keep the placeholder sized and laid out as usual — the host mirrors its position and clips the
 * frame to your app's own area. Leave your own content visible until `state === 'granted'`.
 *
 * Authorization is entirely the host's: it reparses the URL and matches its origin against the
 * list a workspace admin approved for this app. `denied` with `origin-not-approved` is the normal
 * answer for an origin nobody approved yet, not an error. `unsupported` means the host predates
 * this feature — render your own fallback there.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProviderEmbedDenialReason, ProviderEmbedRect } from '../PrivosAppProvider';
import { usePrivosApp } from '../use-privos-app';

export type ProviderEmbedState =
	/** Waiting for the host's decision. */
	| 'requesting'
	/** The host is rendering the provider frame over your placeholder. */
	| 'granted'
	/** The host refused; see `reason`. */
	| 'denied'
	/** The host does not implement hoisted embeds at all. */
	| 'unsupported';

export interface UseProviderEmbedResult {
	/** Attach to the element the provider frame should cover. */
	ref: (element: HTMLElement | null) => void;
	state: ProviderEmbedState;
	/** Populated when `state` is `'denied'`. */
	reason?: ProviderEmbedDenialReason;
}

const readRect = (element: HTMLElement): ProviderEmbedRect => {
	const { x, y, width, height } = element.getBoundingClientRect();
	return { x, y, width, height };
};

const sameRect = (a: ProviderEmbedRect, b: ProviderEmbedRect): boolean =>
	a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export function useProviderEmbed(url: string): UseProviderEmbedResult {
	const app = usePrivosApp();
	const [state, setState] = useState<ProviderEmbedState>('requesting');
	const [reason, setReason] = useState<ProviderEmbedDenialReason | undefined>(undefined);

	const elementRef = useRef<HTMLElement | null>(null);
	const embedIdRef = useRef<string | null>(null);
	const lastRectRef = useRef<ProviderEmbedRect | null>(null);
	// Bumped on unmount and on every re-request, so a decision from a superseded attempt cannot
	// resurrect an embed the app has already moved past.
	const attemptRef = useRef(0);

	const pushRect = useCallback(() => {
		const element = elementRef.current;
		const embedId = embedIdRef.current;
		if (!element || !embedId) return;

		const rect = readRect(element);
		if (lastRectRef.current && sameRect(lastRectRef.current, rect)) return;
		lastRectRef.current = rect;
		app.setProviderEmbedRect(embedId, rect);
	}, [app]);

	const ref = useCallback((element: HTMLElement | null) => {
		elementRef.current = element;
	}, []);

	useEffect(() => {
		// Invalidate any decision still in flight from a previous effect run.
		attemptRef.current++;
		let disposed = false;

		const release = () => {
			if (!embedIdRef.current) return;
			app.teardownProviderEmbed(embedIdRef.current);
			embedIdRef.current = null;
			lastRectRef.current = null;
		};

		const request = () => {
			const element = elementRef.current;
			if (!element || disposed) return;

			// Read at call time, not from the enclosing effect: a re-request after a document
			// reload bumps the counter first, and a stale capture would discard its own answer.
			const attempt = attemptRef.current;

			// Asking is itself the capability probe, so it works at any mount time — including a
			// tab switch long after the host's one-shot handshake. A host without this feature
			// never answers, which the SDK's own request timeout turns into a rejection below.
			app.requestProviderEmbed(url, readRect(element)).then(
				(decision) => {
					if (disposed || attempt !== attemptRef.current) return;
					if (decision?.granted) {
						embedIdRef.current = decision.embedId;
						lastRectRef.current = readRect(element);
						setReason(undefined);
						setState('granted');
						return;
					}
					// The document had not finished loading. The host clears its slate at that point
					// anyway, and `onhostinitialize` below re-requests — so stay in `requesting`
					// rather than showing the user a denial that is about to resolve itself.
					if (decision?.reason === 'not-ready') return;
					setReason(decision?.reason ?? 'invalid-url');
					setState('denied');
				},
				() => {
					if (disposed || attempt !== attemptRef.current) return;
					setState('unsupported');
				},
			);
		};

		// The host clears everything it tracks per document when it initializes the iframe, and
		// that can land after this effect's first request — a deferred module script runs before
		// the `load` event that drives it. Re-requesting here is what makes the embed survive both
		// the first load and any later reload, instead of racing them.
		const onInitialize = () => {
			release();
			attemptRef.current++;
			setState('requesting');
			request();
		};

		// The subscription, not the single-slot `onhostinitialize` setter: the chat-surface hook
		// needs this same signal, and an app using both would otherwise silently lose one.
		const unsubscribe = app.subscribeHostInitialize?.(onInitialize);
		if (!unsubscribe) app.onhostinitialize = onInitialize;

		request();

		// Scroll listeners are registered in the capture phase because scroll events do not bubble:
		// this is what keeps the frame pinned when the placeholder sits in the app's own scrolling
		// container, not just the document.
		let frame = 0;
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				pushRect();
			});
		};

		window.addEventListener('scroll', schedule, true);
		window.addEventListener('resize', schedule);

		const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
		if (elementRef.current) observer?.observe(elementRef.current);

		return () => {
			disposed = true;
			attemptRef.current++;
			if (frame) cancelAnimationFrame(frame);
			window.removeEventListener('scroll', schedule, true);
			window.removeEventListener('resize', schedule);
			observer?.disconnect();
			if (unsubscribe) unsubscribe();
			else app.onhostinitialize = undefined;
			release();
		};
	}, [app, url, pushRect]);

	return { ref, state, reason };
}
