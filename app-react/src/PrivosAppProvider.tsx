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
	onhostcontextchanged?: (ctx: any) => void;
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

if (typeof window !== 'undefined') {
	window.addEventListener('message', (event: MessageEvent) => {
		// Only trust the host bridge (parent frame). Rejecting other sources stops a
		// sibling/nested frame from forging context or injecting a token.
		if (event.source !== window.parent) return;
		const data = event.data;
		if (!data || data.jsonrpc !== '2.0') return;
		if (data.method !== 'HOST_CONTEXT_CHANGED') return;

		bufferedHostContext = data.params;
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

	const handleMessage = (event: MessageEvent) => {
			// Only trust the host bridge (parent frame). Rejecting other sources stops a
			// sibling/nested frame from forging context/tool responses or injecting a token.
			if (event.source !== window.parent) return;

		const data = event.data;
		if (!data || data.jsonrpc !== '2.0') return;

		// Handle responses to our tool calls. HOST_CONTEXT_CHANGED is handled by
		// the module-scope early listener above and routed via `activeContextHandler`.
		if (data.id !== undefined && pendingCalls.has(data.id)) {
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
