/**
 * Take over the hub's AI chat surface so this app can render its own chat window.
 *
 * While the app owns the surface, clicking the hub's floating launcher opens the app's chat
 * instead of the hub's, and the launcher hides until the app reports its chat closed.
 * Ownership is per iframe mount — a reload or a tab switch hands the surface back.
 *
 *   const { supported, isOpen, close } = useAppChatSurface({
 *     onOpen: () => setPanelVisible(true),
 *     onClose: () => setPanelVisible(false),
 *   });
 *
 * When `supported` is false the host surface has no launcher to delegate (the standalone page
 * and the sidebar panel) — render your own entry point there.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { usePrivosApp } from '../use-privos-app';

export interface UseAppChatSurfaceOptions {
	/** The user asked for the chat. Show your chat window here. */
	onOpen?: () => void;
	/** The host needs the chat closed. Hide your chat window here. */
	onClose?: (reason?: string) => void;
}

export interface UseAppChatSurfaceResult {
	/**
	 * Whether the host has answered yet. Until this is true `supported` is not yet known — do not
	 * draw a fallback entry point, or it will appear next to the hub's own launcher.
	 */
	resolved: boolean;
	/** Whether this host surface actually has a launcher to hand over. */
	supported: boolean;
	/** Whether the host currently believes the app's chat window is showing. */
	isOpen: boolean;
	/** Open the app's chat window and hide the hub launcher. */
	open: () => void;
	/** Minimize the app's chat window and bring the hub launcher back. */
	close: () => void;
}

export function useAppChatSurface(options: UseAppChatSurfaceOptions = {}): UseAppChatSurfaceResult {
	const app = usePrivosApp();
	const [resolved, setResolved] = useState(false);
	const [supported, setSupported] = useState(false);
	const [isOpen, setIsOpen] = useState(false);

	// Read handlers through a ref so callers can pass inline closures without re-registering.
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const reportOpen = useCallback(
		(open: boolean) => {
			setIsOpen(open);
			// The host may already be gone (teardown); losing this ack is not worth an unhandled rejection.
			app.setChatOpen(open).catch(() => undefined);
		},
		[app],
	);

	const open = useCallback(() => reportOpen(true), [reportOpen]);
	const close = useCallback(() => reportOpen(false), [reportOpen]);

	useEffect(() => {
		let active = true;

		const claim = () => {
			app.registerChatSurface(true).then(
				(result) => {
					if (!active) return;
					setSupported(Boolean(result?.supported));
					setResolved(true);
				},
				() => {
					if (!active) return;
					setSupported(false);
					setResolved(true);
				},
			);
		};

		// The host clears per-mount state when it initializes the iframe, and that can land after
		// this effect's first claim — a deferred module script runs before the `load` event that
		// drives it. Claiming again here is what makes ownership survive both the first load and
		// any later reload, instead of depending on which of the two arrives first.
		// Subscribe rather than take the single `onhostinitialize` slot: hoisted provider embeds
		// need the same signal, and whichever hook mounted last would otherwise silently win it.
		const unsubscribe = app.subscribeHostInitialize?.(() => claim());
		if (!unsubscribe) app.onhostinitialize = () => claim();
		app.onhostchatopen = () => {
			optionsRef.current.onOpen?.();
			// Ack on the author's behalf: forgetting it would trip the host's watchdog, which
			// takes the surface back and puts the hub launcher in front of the app's own chat.
			reportOpen(true);
		};
		app.onhostchatclose = (reason: string) => {
			optionsRef.current.onClose?.(reason);
			setIsOpen(false);
			// 'timeout' means the host already dropped us and restored its launcher; acking an
			// open state it no longer believes in would only be ignored.
			if (reason !== 'timeout') app.setChatOpen(false).catch(() => undefined);
		};

		claim();

		return () => {
			active = false;
			if (unsubscribe) unsubscribe();
			else app.onhostinitialize = undefined;
			app.onhostchatopen = undefined;
			app.onhostchatclose = undefined;
			app.registerChatSurface(false).catch(() => undefined);
		};
	}, [app, reportOpen]);

	return { resolved, supported, isOpen, open, close };
}
