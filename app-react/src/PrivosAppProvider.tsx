/**
 * Context provider that initializes the MCP App connection and provides it to the tree.
 * Wraps the standard App class from @modelcontextprotocol/ext-apps.
 */
import { createContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/** Params for a REST passthrough call (gated server-side by the app's granted scopes). */
export interface RestRequestParams {
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	/** Hub REST path after /api/v1/, e.g. 'file-management.files.channel/' + roomId */
	path: string;
	query?: Record<string, string | number | boolean>;
	body?: any;
	/** Override the host-bridge response timeout (ms). Default 10000. Raise for slow
	 *  downstreams (e.g. a cold Sandbox VM spawn behind agents.sandbox.generate-async). */
	timeoutMs?: number;
}

/** Result of a REST passthrough: downstream HTTP status + parsed JSON body. */
export interface RestResponse<T = any> {
	statusCode: number;
	body: T;
}

/** Placeholder geometry, in CSS pixels relative to the app document's own viewport. */
export interface ProviderEmbedRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Why the host refused to render a provider embed. */
export type ProviderEmbedDenialReason =
	| 'invalid-url'
	/** No workspace admin approved this origin for this app. */
	| 'origin-not-approved'
	/** The hub's own origin, which a hoisted frame may never point at. */
	| 'self-origin'
	/** The app already holds the maximum number of concurrent embeds. */
	| 'limit-exceeded'
	/** The app document has not finished loading; re-request after `onhostinitialize`. */
	| 'not-ready';

export type ProviderEmbedDecision = { granted: true; embedId: string } | { granted: false; reason: ProviderEmbedDenialReason };

/** Params for a multipart file upload to file management (requires files:write). */
export interface UploadFileParams {
	channelId: string;
	fileName: string;
	/** Base64-encoded file content (data URI accepted). */
	base64Data: string;
	mimeType?: string;
	folderId?: string;
	enableEmbedding?: boolean;
	duplicateAction?: 'replace' | 'keep_both' | 'cancel';
}

/** Host-mediated, per-app persistent key/value store (see `McpApp.storage`). */
export interface AppStorage {
	/** The stored string for `key`, or `null` if never set. */
	get(key: string): Promise<string | null>;
	/** Write `value` for `key` (overwrites). */
	set(key: string, value: string): Promise<void>;
	/** Delete `key`. No-op if it was never set. */
	remove(key: string): Promise<void>;
}

/** Minimal MCP App interface (mirrors @modelcontextprotocol/ext-apps App class) */
export interface McpApp {
	connect(): Promise<void>;
	disconnect(): void;
	callServerTool(params: {
		name: string;
		arguments: Record<string, any>;
		/** Override host-bridge response timeout (ms). */
		timeoutMs?: number;
	}): Promise<any>;
	/** Call an existing hub REST endpoint as the current user (preferred over resource tools). */
	rest(params: RestRequestParams): Promise<RestResponse>;
	/** Upload a file to file management as the current user. */
	uploadFile(params: UploadFileParams): Promise<any>;
	/**
	 * Small persistent key/value store, mediated by the host.
	 *
	 * The app document runs in an opaque origin, so its own `localStorage` throws
	 * or is wiped between sessions. This proxies to the host's `localStorage`
	 * under a per-app namespace (`mcp-app:{appId}:{key}`): the host stamps the
	 * appId itself, so one app can neither read nor overwrite another's keys.
	 * Per browser profile, not synced across devices — keep the server the source
	 * of truth for anything that must follow the user, and use this as a fast local
	 * cache or for device-local UI preferences. Values are strings; serialize
	 * structured data yourself.
	 */
	storage: AppStorage;
	/**
	 * Declare that this app renders its own AI chat window. While it owns the surface the hub's
	 * floating launcher opens the app's chat instead of the hub's. `supported` is false on host
	 * surfaces that have no launcher to hand over (standalone page, sidebar panel) — draw your
	 * own entry point there. Ownership lasts for this iframe mount only.
	 */
	registerChatSurface(owns: boolean): Promise<{ ok: true; supported: boolean }>;
	/**
	 * Report that the app's own chat window opened or was minimized/closed. Reporting `false`
	 * brings the hub launcher back. The host waits ~1.5s for a `true` after it asks the app to
	 * open; miss that window and it takes the surface back.
	 */
	setChatOpen(open: boolean): Promise<{ ok: true }>;
	/**
	 * Ask the host to render a provider embed over a placeholder in this document.
	 *
	 * The app cannot iframe YouTube or Figma itself: this document runs in an opaque origin and
	 * those providers refuse to initialize there. The host renders the frame instead, outside
	 * this sandbox, but only for an origin a workspace admin approved for this app — the URL is
	 * reparsed and re-authorized there, so nothing sent here confers permission.
	 *
	 * A refusal comes back as `{ granted: false, reason }`, not a rejection. Prefer
	 * `useProviderEmbed`, which drives this whole handshake.
	 */
	requestProviderEmbed(url: string, rect: ProviderEmbedRect): Promise<ProviderEmbedDecision>;
	/** Tell the host the placeholder moved or resized. Fire-and-forget, safe at scroll rate. */
	setProviderEmbedRect(embedId: string, rect: ProviderEmbedRect): void;
	/** Give up an embed. Fire-and-forget; the host also drops everything on document reload. */
	teardownProviderEmbed(embedId: string): void;
	onhostcontextchanged?: (ctx: any) => void;
	/**
	 * The host (re)initialized this iframe. Anything the host tracks per mount — notably chat
	 * surface ownership — is cleared at this point and must be claimed again.
	 *
	 * Single-slot and write-only, so two features cannot both listen. Prefer
	 * `subscribeHostInitialize`; this stays for apps already using it.
	 */
	onhostinitialize?: (() => void) | undefined;
	/**
	 * Subscribe to host (re)initialization; returns an unsubscribe function.
	 *
	 * Exists because more than one feature now needs this signal — chat-surface ownership and
	 * hoisted provider embeds are both cleared by the host per document, and both must re-claim.
	 * Optional so a custom `McpApp` implementation predating it still type-checks; callers fall
	 * back to `onhostinitialize` when it is absent.
	 */
	subscribeHostInitialize?(handler: () => void): () => void;
	/** The user clicked the hub launcher — open your chat window and report `setChatOpen(true)`. */
	onhostchatopen?: (() => void) | undefined;
	/** The host needs your chat closed (its tab went inactive, or it took the surface back). */
	onhostchatclose?: ((reason: string) => void) | undefined;
}

/**
 * Non-secret host context pushed by Hub to the app iframe on context changes.
 * Backend identity is conveyed separately in a Hub-signed private dispatch
 * assertion; browser bearer/user tokens are never exposed to the iframe.
 */
export interface PrivosHostContext {
	userId?: string;
	username?: string;
	theme?: string;
	/**
	 * Resolved workspace theme colours/tokens for the current mode, keyed by the
	 * exact `--base-*` CSS custom property name (e.g. `--base-primary`,
	 * `--base-bg-main`, `--base-radius-md`, `--base-font-family`). Applied to this
	 * document's root automatically by the provider — see `applyThemeTokens` below.
	 */
	themeTokens?: Record<string, string>;
	roomId?: string;
	[key: string]: unknown;
}

export const PrivosAppContext = createContext<McpApp | null>(null);

interface PrivosAppProviderProps {
	children: ReactNode;
	/** Optional custom App instance. If not provided, uses a PostMessage-based default. */
	app?: McpApp;
	name?: string;
	version?: string;
}

// ---------------------------------------------------------------------------
// Early HOST_CONTEXT_CHANGED listener (module-scope singleton)
//
// The hub fires `ui/initialize` + the initial `HOST_CONTEXT_CHANGED` right
// after the iframe loads — before React mounts and before `connect()` can
// register the per-instance `message` listener in a useEffect. A `postMessage`
// to a window with no registered listener is silently dropped, so that first
// push (which carries `theme` and `username`, neither of which is returned by
// `mcpapp.context.get`) is lost. The UI then renders with the default theme
// until the next change push arrives (e.g. a sidebar toggle).
//
// Registering this listener at module import time — the earliest the SDK can
// act — catches that initial push and stashes it. When an app instance later
// attaches `onhostcontextchanged`, the buffered context is replayed to it.
// ---------------------------------------------------------------------------
let bufferedHostContext: any | undefined;
let activeContextHandler: ((ctx: any) => void) | undefined;

/**
 * Applies the workspace theme carried on a `HOST_CONTEXT_CHANGED` push directly
 * to this app document, so an app visually inherits the hub's theme with zero
 * app-side wiring:
 *  - `data-theme` on `<html>` is set to `theme` ('light' | 'dark') for apps that
 *    key CSS off that attribute (mirrors the hub's own convention).
 *  - each `themeTokens` entry is written as a CSS custom property on `<html>` via
 *    `style.setProperty`, so app CSS can reference `var(--base-primary)` etc.
 * Re-run on every `HOST_CONTEXT_CHANGED` (light/dark flip AND an admin/user theme
 * save that re-pushes the same mode), so live edits propagate without a reload.
 * No-op outside a DOM (SSR, or tests without jsdom) and tolerant of a context
 * that carries neither field — existing apps that never adopt theming are
 * unaffected.
 */
function applyThemeTokens(context: unknown): void {
	if (typeof document === 'undefined' || !context || typeof context !== 'object') return;
	const root = document.documentElement;
	const { theme, themeTokens } = context as { theme?: unknown; themeTokens?: unknown };

	if (typeof theme === 'string' && theme) {
		root.dataset.theme = theme;
	}
	if (themeTokens && typeof themeTokens === 'object') {
		for (const [name, value] of Object.entries(themeTokens as Record<string, unknown>)) {
			if (typeof value === 'string' && value) {
				root.style.setProperty(name, value);
			}
		}
	}
}

if (typeof window !== 'undefined') {
	window.addEventListener('message', (event: MessageEvent) => {
		// Only trust the host bridge (parent frame). Rejecting other sources stops a
		// sibling/nested frame from forging context or injecting a token.
		if (event.source !== window.parent) return;
		const data = event.data;
		if (!data || data.jsonrpc !== '2.0') return;
		if (data.method !== 'HOST_CONTEXT_CHANGED') return;

		bufferedHostContext = data.params;
		applyThemeTokens(data.params);
		if (activeContextHandler) {
			try {
				activeContextHandler(data.params);
			} catch {
				/* never let a handler throw break the host bridge listener */
			}
		}
	});
}

/** Default PostMessage-based MCP app for use inside Privos iframes */
function createDefaultApp(): McpApp {
	let connected = false;
	const pendingCalls = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	let nextId = 1;
	// ---------------------------------------------------------------------------
	// SERIAL tools/call queue (comparison / workaround path — keep commented)
	//
	// Hub relay previously reused JSON-RPC id `1` for concurrent tools/call to the
	// app WebSocket. Parallel calls then raced (wrong waiter resolved / orphan
	// timed out as "RPC timeout for tools/call"). Uncomment `toolsCallTail` and
	// the queue wiring in `callServerTool` below to serialize so only one
	// tools/call is in flight through the host at a time — useful for A/B testing
	// against the default parallel path once the hub fix is verified.
	//
	// let toolsCallTail: Promise<void> = Promise.resolve();
	// ---------------------------------------------------------------------------

	let initializeHandler: (() => void) | undefined;
	const initializeSubscribers = new Set<() => void>();
	let chatOpenHandler: (() => void) | undefined;
	let chatCloseHandler: ((reason: string) => void) | undefined;

	const notifyHostInitialize = () => {
		initializeHandler?.();
		// Copied before iterating: a handler may unsubscribe itself while re-claiming.
		[...initializeSubscribers].forEach((handler) => handler());
	};

	const handleMessage = (event: MessageEvent) => {
			// Only trust the host bridge (parent frame). Rejecting other sources stops a
			// sibling/nested frame from forging context/tool responses or injecting a token.
			if (event.source !== window.parent) return;

		const data = event.data;
		if (!data || data.jsonrpc !== '2.0') return;

		// Host-initiated notifications carry no id. Unlike the initial context push these only
		// ever follow a user action, so the listener registered by connect() is always in place.
		if (data.id === undefined) {
			try {
				if (data.method === 'ui/initialize') notifyHostInitialize();
				else if (data.method === 'ui/chat.open') chatOpenHandler?.();
				else if (data.method === 'ui/chat.close') chatCloseHandler?.(String(data.params?.reason ?? ''));
			} catch {
				/* never let a handler throw break the host bridge listener */
			}
			return;
		}

		// Handle responses to our tool calls. HOST_CONTEXT_CHANGED is handled by
		// the module-scope early listener above and routed via `activeContextHandler`.
		if (pendingCalls.has(data.id)) {
			const { resolve, reject } = pendingCalls.get(data.id)!;
			pendingCalls.delete(data.id);
			if (data.error) reject(new Error(data.error.message));
			else resolve(data.result);
		}
	};

	// Generic JSON-RPC request to the host bridge over postMessage.
	// tools/call default is above typical server-side fetch timeouts (20s) so the
	// app can surface a real upstream error instead of a generic bridge timeout.
	const DEFAULT_TOOLS_CALL_TIMEOUT_MS = 30_000;
	/** JSON-RPC notification — no id, so the host never replies and nothing is pending. */
	const sendNotification = (method: string, params: any): void => {
		window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
	};

	const sendRequest = (method: string, params: any, timeoutMs = 10000): Promise<any> => {
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pendingCalls.set(id, { resolve, reject });
			window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
			setTimeout(() => {
				if (pendingCalls.has(id)) {
					pendingCalls.delete(id);
					reject(new Error(`${method} timeout`));
				}
			}, timeoutMs);
		});
	};

	return {
		async connect() {
			if (connected) return;
			window.addEventListener('message', handleMessage);
			connected = true;
		},
		disconnect() {
			window.removeEventListener('message', handleMessage);
			connected = false;
		},
		callServerTool(params) {
			const { timeoutMs, ...rpcParams } = params;
			const run = () =>
				sendRequest(
					'tools/call',
					{ name: rpcParams.name, arguments: rpcParams.arguments ?? {} },
					timeoutMs ?? DEFAULT_TOOLS_CALL_TIMEOUT_MS,
				);
			// Default: parallel tools/call (unique bridge ids via nextId).
			return run();
			// --- SERIAL comparison path ---
			// Comment out `return run()` above, uncomment `toolsCallTail` near
			// createDefaultApp, then uncomment:
			// const result = toolsCallTail.then(run, run);
			// toolsCallTail = result.then(
			// 	() => undefined,
			// 	() => undefined,
			// );
			// return result;
		},
		rest(params) {
			return sendRequest('host/rest.request', params, params.timeoutMs ?? 10000);
		},
		uploadFile(params) {
			// Larger timeout — uploads can take a while.
			return sendRequest('host/file.upload', params, 60000);
		},
		storage: {
			async get(key: string) {
				const result = await sendRequest('host/storage.get', { key }, 5000);
				return (result?.value ?? null) as string | null;
			},
			async set(key: string, value: string) {
				await sendRequest('host/storage.set', { key, value }, 5000);
			},
			async remove(key: string) {
				await sendRequest('host/storage.remove', { key }, 5000);
			},
		},
		registerChatSurface(owns: boolean) {
			return sendRequest('host/chat.register', { owns }, 5000);
		},
		setChatOpen(open: boolean) {
			return sendRequest('host/chat.state', { open }, 5000);
		},
		requestProviderEmbed(url: string, rect: ProviderEmbedRect) {
			return sendRequest('host/embed.request', { url, rect }, 5000);
		},
		setProviderEmbedRect(embedId: string, rect: ProviderEmbedRect) {
			// A notification, not a request: these arrive at scroll rate and a round trip per frame
			// would cost more than the update is worth.
			sendNotification('host/embed.rect', { embedId, rect });
		},
		teardownProviderEmbed(embedId: string) {
			sendNotification('host/embed.teardown', { embedId });
		},
		set onhostinitialize(handler: (() => void) | undefined) {
			initializeHandler = handler;
		},
		subscribeHostInitialize(handler: () => void) {
			initializeSubscribers.add(handler);
			return () => {
				initializeSubscribers.delete(handler);
			};
		},
		set onhostchatopen(handler: (() => void) | undefined) {
			chatOpenHandler = handler;
		},
		set onhostchatclose(handler: ((reason: string) => void) | undefined) {
			chatCloseHandler = handler;
		},
		set onhostcontextchanged(handler: ((ctx: any) => void) | undefined) {
			activeContextHandler = handler;
			// Replay the buffered initial context if the hub's first
			// HOST_CONTEXT_CHANGED arrived before anyone attached a handler.
			// Always replay the latest buffer on (re)attachment so a StrictMode
			// unmount/remount or a late-attaching consumer still receives it.
			if (handler && bufferedHostContext !== undefined) {
				const buffered = bufferedHostContext;
				try {
					handler(buffered);
				} catch {
					/* ignore handler errors during replay */
				}
			}
		},
	};
}

export function PrivosAppProvider({ children, app: customApp, name, version }: PrivosAppProviderProps) {
	const appRef = useRef<McpApp>(customApp || createDefaultApp());

	useEffect(() => {
		const app = appRef.current;
		app.connect();
		return () => app.disconnect();
	}, []);

	return <PrivosAppContext.Provider value={appRef.current}>{children}</PrivosAppContext.Provider>;
}
