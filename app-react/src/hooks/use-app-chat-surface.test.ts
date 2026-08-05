/**
 * Chat-surface delegation: the hook contract plus the bridge routing it depends on.
 * jsdom makes `window.parent === window`, so a MessageEvent whose source is `window`
 * is exactly what the SDK accepts from the host.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrivosAppProvider } from '../PrivosAppProvider';
import type { McpApp } from '../PrivosAppProvider';
import { usePrivosApp } from '../use-privos-app';
import { useAppChatSurface } from './use-app-chat-surface';

const createStubApp = (overrides: Partial<McpApp> = {}): McpApp => ({
	connect: vi.fn().mockResolvedValue(undefined),
	disconnect: vi.fn(),
	callServerTool: vi.fn().mockResolvedValue({}),
	rest: vi.fn().mockResolvedValue({ statusCode: 200, body: {} }),
	uploadFile: vi.fn().mockResolvedValue({}),
	registerChatSurface: vi.fn().mockResolvedValue({ ok: true, supported: true }),
	setChatOpen: vi.fn().mockResolvedValue({ ok: true }),
	...overrides,
});

const wrapperFor = (app: McpApp) =>
	function Wrapper({ children }: { children: ReactNode }) {
		return createElement(PrivosAppProvider, { app }, children);
	};

const renderChatSurface = (app: McpApp, options: Parameters<typeof useAppChatSurface>[0] = {}) =>
	renderHook(() => useAppChatSurface(options), { wrapper: wrapperFor(app) });

/** Deliver a host notification; jsdom forbids a plain object as MessageEvent.source. */
const postFromHost = (data: unknown, source: unknown = window) => {
	const event = new MessageEvent('message', { data });
	Object.defineProperty(event, 'source', { value: source });
	window.dispatchEvent(event);
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('useAppChatSurface', () => {
	it('claims the chat surface on mount', async () => {
		const app = createStubApp();
		const { result } = renderChatSurface(app);

		expect(app.registerChatSurface).toHaveBeenCalledWith(true);
		await waitFor(() => expect(result.current.supported).toBe(true));
	});

	it('reports nothing as resolved until the host answers', async () => {
		let answer: (value: { ok: true; supported: boolean }) => void = () => undefined;
		const app = createStubApp({
			registerChatSurface: vi.fn().mockReturnValue(new Promise((resolve) => { answer = resolve; })),
		});
		const { result } = renderChatSurface(app);

		// Drawing a fallback entry point here would put a second launcher next to the hub's own.
		expect(result.current.resolved).toBe(false);

		await act(async () => {
			answer({ ok: true, supported: true });
		});

		expect(result.current.resolved).toBe(true);
		expect(result.current.supported).toBe(true);
	});

	it('claims the surface again when the host reinitializes the iframe', async () => {
		const app = createStubApp();
		renderChatSurface(app);
		(app.registerChatSurface as ReturnType<typeof vi.fn>).mockClear();

		// The host clears per-mount ownership on iframe load, which can land after the first claim.
		await act(async () => {
			app.onhostinitialize?.();
		});

		expect(app.registerChatSurface).toHaveBeenCalledWith(true);
	});

	it('does not ack an open state the host already took back', async () => {
		const app = createStubApp();
		const onClose = vi.fn();
		const { result } = renderChatSurface(app, { onClose });

		await act(async () => {
			app.onhostchatopen?.();
		});
		(app.setChatOpen as ReturnType<typeof vi.fn>).mockClear();

		await act(async () => {
			app.onhostchatclose?.('timeout');
		});

		expect(onClose).toHaveBeenCalledWith('timeout');
		expect(result.current.isOpen).toBe(false);
		expect(app.setChatOpen).not.toHaveBeenCalled();
	});

	it('reports an unsupported surface so the app can draw its own entry point', async () => {
		const app = createStubApp({ registerChatSurface: vi.fn().mockResolvedValue({ ok: true, supported: false }) });
		const { result } = renderChatSurface(app);

		await waitFor(() => expect(result.current.supported).toBe(false));
	});

	it('treats a failed registration as unsupported instead of rejecting', async () => {
		const app = createStubApp({ registerChatSurface: vi.fn().mockRejectedValue(new Error('timeout')) });
		const { result } = renderChatSurface(app);

		await waitFor(() => expect(result.current.supported).toBe(false));
	});

	it('opens on the host notification and acknowledges without the author having to', async () => {
		const app = createStubApp();
		const onOpen = vi.fn();
		const { result } = renderChatSurface(app, { onOpen });

		await act(async () => {
			app.onhostchatopen?.();
		});

		expect(onOpen).toHaveBeenCalledTimes(1);
		// The ack is what keeps the host's 1.5s watchdog from taking the surface back.
		expect(app.setChatOpen).toHaveBeenCalledWith(true);
		expect(result.current.isOpen).toBe(true);
	});

	it('closes on the host notification and passes the reason through', async () => {
		const app = createStubApp();
		const onClose = vi.fn();
		const { result } = renderChatSurface(app, { onClose });

		await act(async () => {
			app.onhostchatopen?.();
		});
		await act(async () => {
			app.onhostchatclose?.('tab-inactive');
		});


		expect(onClose).toHaveBeenCalledWith('tab-inactive');
		expect(app.setChatOpen).toHaveBeenLastCalledWith(false);
		expect(result.current.isOpen).toBe(false);
	});

	it('brings the hub launcher back when the app minimizes itself', async () => {
		const app = createStubApp();
		const { result } = renderChatSurface(app);

		await act(async () => {
			result.current.open();
		});
		expect(app.setChatOpen).toHaveBeenLastCalledWith(true);

		await act(async () => {
			result.current.close();
		});
		expect(app.setChatOpen).toHaveBeenLastCalledWith(false);
		expect(result.current.isOpen).toBe(false);
	});

	it('survives a host that rejects the ack', async () => {
		const app = createStubApp({ setChatOpen: vi.fn().mockRejectedValue(new Error('gone')) });
		const { result } = renderChatSurface(app);

		await act(async () => {
			result.current.open();
		});

		expect(result.current.isOpen).toBe(true);
	});

	it('gives the surface back on unmount', async () => {
		const app = createStubApp();
		const { unmount } = renderChatSurface(app);

		unmount();

		expect(app.registerChatSurface).toHaveBeenLastCalledWith(false);
	});

	it('does not throw when the host is already gone at unmount', async () => {
		const app = createStubApp({ registerChatSurface: vi.fn().mockRejectedValue(new Error('gone')) });
		const { unmount } = renderChatSurface(app);

		expect(() => unmount()).not.toThrow();
	});
});

describe('default bridge app chat routing', () => {
	const renderDefaultApp = () => {
		function Wrapper({ children }: { children: ReactNode }) {
			return createElement(PrivosAppProvider, null, children);
		}
		return renderHook(() => usePrivosApp(), { wrapper: Wrapper });
	};

	it('sends chat registration and state as JSON-RPC requests to the host', () => {
		const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined);
		const { result } = renderDefaultApp();

		result.current.registerChatSurface(true);
		result.current.setChatOpen(false);

		const sent = postMessage.mock.calls.map(([message]) => message as Record<string, unknown>);
		expect(sent[0]).toMatchObject({ jsonrpc: '2.0', method: 'host/chat.register', params: { owns: true } });
		expect(sent[1]).toMatchObject({ jsonrpc: '2.0', method: 'host/chat.state', params: { open: false } });
		expect(sent.every((message) => typeof message.id === 'number')).toBe(true);
	});

	it('routes host chat notifications to the attached handlers', async () => {
		const { result } = renderDefaultApp();
		const onOpen = vi.fn();
		const onClose = vi.fn();
		result.current.onhostchatopen = onOpen;
		result.current.onhostchatclose = onClose;

		await act(async () => {
			postFromHost({ jsonrpc: '2.0', method: 'ui/chat.open', params: {} });
			postFromHost({ jsonrpc: '2.0', method: 'ui/chat.close', params: { reason: 'teardown' } });
		});

		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledWith('teardown');
	});

	it('detaches a handler when it is cleared', async () => {
		const { result } = renderDefaultApp();
		const onOpen = vi.fn();
		result.current.onhostchatopen = onOpen;
		result.current.onhostchatopen = undefined;

		await act(async () => {
			postFromHost({ jsonrpc: '2.0', method: 'ui/chat.open', params: {} });
		});

		expect(onOpen).not.toHaveBeenCalled();
	});

	it('routes ui/initialize so a claim can be renewed after the host resets the mount', async () => {
		const { result } = renderDefaultApp();
		const onInitialize = vi.fn();
		result.current.onhostinitialize = onInitialize;

		await act(async () => {
			postFromHost({
				jsonrpc: '2.0',
				method: 'ui/initialize',
				params: { hostCapabilities: { tools: true, context: true, chatSurface: true } },
			});
		});

		expect(onInitialize).toHaveBeenCalledTimes(1);
	});

	it('ignores chat notifications that did not come from the host frame', async () => {
		const { result } = renderDefaultApp();
		const onOpen = vi.fn();
		result.current.onhostchatopen = onOpen;

		await act(async () => {
			postFromHost({ jsonrpc: '2.0', method: 'ui/chat.open', params: {} }, { postMessage: vi.fn() });
		});

		expect(onOpen).not.toHaveBeenCalled();
	});

	it('does not let a throwing handler break the bridge listener', async () => {
		const { result } = renderDefaultApp();
		const onClose = vi.fn();
		result.current.onhostchatopen = () => {
			throw new Error('app bug');
		};
		result.current.onhostchatclose = onClose;

		await act(async () => {
			postFromHost({ jsonrpc: '2.0', method: 'ui/chat.open', params: {} });
			postFromHost({ jsonrpc: '2.0', method: 'ui/chat.close', params: { reason: 'teardown' } });
		});

		expect(onClose).toHaveBeenCalledWith('teardown');
	});
});
