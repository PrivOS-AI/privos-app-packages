/**
 * Hoisted provider embeds: the hook contract an app author actually depends on.
 *
 * The authorization itself lives in the host and is tested there — what matters here is that the
 * app is never left waiting forever, never shows a denial that is about to resolve itself, and
 * always gives the frame back.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrivosAppProvider } from '../PrivosAppProvider';
import type { McpApp, ProviderEmbedDecision } from '../PrivosAppProvider';
import { useProviderEmbed } from './use-provider-embed';

const URL = 'https://www.youtube.com/embed/M7lc1UVf-VE';

/** Handlers the hook subscribed for `ui/initialize`, so a test can replay a document reload. */
const initializeSubscribers = new Set<() => void>();

const createStubApp = (overrides: Partial<McpApp> = {}): McpApp => ({
	connect: vi.fn().mockResolvedValue(undefined),
	disconnect: vi.fn(),
	callServerTool: vi.fn().mockResolvedValue({}),
	rest: vi.fn().mockResolvedValue({ statusCode: 200, body: {} }),
	uploadFile: vi.fn().mockResolvedValue({}),
	registerChatSurface: vi.fn().mockResolvedValue({ ok: true, supported: true }),
	setChatOpen: vi.fn().mockResolvedValue({ ok: true }),
	requestProviderEmbed: vi.fn().mockResolvedValue({ granted: true, embedId: 'embed-1' } as ProviderEmbedDecision),
	setProviderEmbedRect: vi.fn(),
	teardownProviderEmbed: vi.fn(),
	// Mirrors the real provider: a real subscription, so the chat-surface hook and this one can
	// both listen. Unsubscribing on unmount is part of the contract under test.
	subscribeHostInitialize(handler: () => void) {
		initializeSubscribers.add(handler);
		return () => {
			initializeSubscribers.delete(handler);
		};
	},
	...overrides,
});

/** Replay the host's `ui/initialize` push — a fresh app document. */
const postHostInitialize = () => [...initializeSubscribers].forEach((handler) => handler());

const wrapperFor = (app: McpApp) =>
	function Wrapper({ children }: { children: ReactNode }) {
		return createElement(PrivosAppProvider, { app }, children);
	};

/** Render the hook with its ref already attached to a laid-out placeholder. */
const renderEmbed = (app: McpApp, url = URL) => {
	const element = document.createElement('div');
	element.getBoundingClientRect = () => ({ x: 10, y: 20, width: 320, height: 180 }) as DOMRect;
	document.body.appendChild(element);

	const view = renderHook(() => {
		const result = useProviderEmbed(url);
		result.ref(element);
		return result;
	}, { wrapper: wrapperFor(app) });

	return { ...view, element };
};

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
	initializeSubscribers.clear();
});

describe('useProviderEmbed', () => {
	it('requests the embed with the placeholder rect and reports granted', async () => {
		const app = createStubApp();
		const { result } = renderEmbed(app);

		await waitFor(() => expect(result.current.state).toBe('granted'));
		expect(app.requestProviderEmbed).toHaveBeenCalledWith(URL, { x: 10, y: 20, width: 320, height: 180 });
		expect(result.current.reason).toBeUndefined();
	});

	it('starts in requesting so the app can keep its own content visible', () => {
		const app = createStubApp({ requestProviderEmbed: vi.fn().mockReturnValue(new Promise(() => undefined)) });
		const { result } = renderEmbed(app);

		expect(result.current.state).toBe('requesting');
	});

	it('surfaces a denial with its reason instead of throwing', async () => {
		const app = createStubApp({
			requestProviderEmbed: vi.fn().mockResolvedValue({ granted: false, reason: 'origin-not-approved' }),
		});
		const { result } = renderEmbed(app);

		await waitFor(() => expect(result.current.state).toBe('denied'));
		expect(result.current.reason).toBe('origin-not-approved');
	});

	// A host predating this feature answers nothing at all, so the SDK's request timeout rejects.
	// The app must fall back, not hang.
	it('resolves to unsupported when the host never answers', async () => {
		const app = createStubApp({ requestProviderEmbed: vi.fn().mockRejectedValue(new Error('host/embed.request timeout')) });
		const { result } = renderEmbed(app);

		await waitFor(() => expect(result.current.state).toBe('unsupported'));
	});

	// 'not-ready' means the document had not finished loading; the host is about to clear its
	// slate and the re-request below fixes it. Showing a denial here would flash a wrong message.
	it('stays in requesting on not-ready and succeeds after the host initializes', async () => {
		const decisions: ProviderEmbedDecision[] = [
			{ granted: false, reason: 'not-ready' },
			{ granted: true, embedId: 'embed-7' },
		];
		const requestProviderEmbed = vi.fn().mockImplementation(() => Promise.resolve(decisions.shift()));
		const app = createStubApp({ requestProviderEmbed });
		const { result } = renderEmbed(app);

		await waitFor(() => expect(requestProviderEmbed).toHaveBeenCalledTimes(1));
		expect(result.current.state).toBe('requesting');

		act(() => postHostInitialize());

		await waitFor(() => expect(result.current.state).toBe('granted'));
	});

	it('unsubscribes on unmount so a later reload cannot revive it', async () => {
		const app = createStubApp();
		const { result, unmount } = renderEmbed(app);
		await waitFor(() => expect(result.current.state).toBe('granted'));

		unmount();
		postHostInitialize();

		expect(app.requestProviderEmbed).toHaveBeenCalledTimes(1);
	});

	it('re-requests when the app document reloads', async () => {
		const app = createStubApp();
		const { result } = renderEmbed(app);
		await waitFor(() => expect(result.current.state).toBe('granted'));

		act(() => postHostInitialize());

		await waitFor(() => expect(app.requestProviderEmbed).toHaveBeenCalledTimes(2));
		// The frame the previous document held is handed back rather than left to the host.
		expect(app.teardownProviderEmbed).toHaveBeenCalledWith('embed-1');
	});

	it('gives the embed back on unmount', async () => {
		const app = createStubApp();
		const { result, unmount } = renderEmbed(app);
		await waitFor(() => expect(result.current.state).toBe('granted'));

		unmount();

		expect(app.teardownProviderEmbed).toHaveBeenCalledWith('embed-1');
	});

	it('does not tear down an embed it never got', async () => {
		const app = createStubApp({ requestProviderEmbed: vi.fn().mockResolvedValue({ granted: false, reason: 'origin-not-approved' }) });
		const { result, unmount } = renderEmbed(app);
		await waitFor(() => expect(result.current.state).toBe('denied'));

		unmount();

		expect(app.teardownProviderEmbed).not.toHaveBeenCalled();
	});

	it('pushes a rect only when the placeholder actually moved', async () => {
		const app = createStubApp();
		const { result, element } = renderEmbed(app);
		await waitFor(() => expect(result.current.state).toBe('granted'));

		// Same rect: nothing to tell the host.
		act(() => window.dispatchEvent(new Event('resize')));
		await waitForFrame();
		expect(app.setProviderEmbedRect).not.toHaveBeenCalled();

		element.getBoundingClientRect = () => ({ x: 10, y: 400, width: 320, height: 180 }) as DOMRect;
		act(() => window.dispatchEvent(new Event('resize')));
		await waitForFrame();

		expect(app.setProviderEmbedRect).toHaveBeenCalledWith('embed-1', { x: 10, y: 400, width: 320, height: 180 });
	});

	it('ignores a decision that arrives after unmount', async () => {
		let answer: (decision: ProviderEmbedDecision) => void = () => undefined;
		const app = createStubApp({
			requestProviderEmbed: vi.fn().mockReturnValue(
				new Promise<ProviderEmbedDecision>((resolve) => {
					answer = resolve;
				}),
			),
		});
		const { unmount } = renderEmbed(app);

		unmount();
		await act(async () => {
			answer({ granted: true, embedId: 'embed-late' });
		});

		// A late grant must not strand a frame nobody will ever tear down.
		expect(app.teardownProviderEmbed).not.toHaveBeenCalled();
	});
});

/** Let the rAF-throttled rect push run. */
const waitForFrame = () =>
	act(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => resolve());
			}),
	);
