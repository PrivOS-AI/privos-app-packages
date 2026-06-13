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
	callServerTool(params: { name: string; arguments: Record<string, any> }): Promise<any>;
	/** Call an existing hub REST endpoint as the current user (preferred over resource tools). */
	rest(params: RestRequestParams): Promise<RestResponse>;
	/** Upload a file to file management as the current user. */
	uploadFile(params: UploadFileParams): Promise<any>;
	onhostcontextchanged?: (ctx: any) => void;
}

export const PrivosAppContext = createContext<McpApp | null>(null);

interface PrivosAppProviderProps {
	children: ReactNode;
	/** Optional custom App instance. If not provided, uses a PostMessage-based default. */
	app?: McpApp;
	name?: string;
	version?: string;
}

/** Default PostMessage-based MCP app for use inside Privos iframes */
function createDefaultApp(): McpApp {
	let connected = false;
	const pendingCalls = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	let nextId = 1;
	let contextHandler: ((ctx: any) => void) | undefined;

	const handleMessage = (event: MessageEvent) => {
		const data = event.data;
		if (!data || data.jsonrpc !== '2.0') return;

		// Handle responses to our tool calls
		if (data.id !== undefined && pendingCalls.has(data.id)) {
			const { resolve, reject } = pendingCalls.get(data.id)!;
			pendingCalls.delete(data.id);
			if (data.error) reject(new Error(data.error.message));
			else resolve(data.result);
		}

		// Handle HOST_CONTEXT_CHANGED push
		if (data.method === 'HOST_CONTEXT_CHANGED' && contextHandler) {
			contextHandler(data.params);
		}
	};

	// Generic JSON-RPC request to the host bridge over postMessage.
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
			return sendRequest('tools/call', params);
		},
		rest(params) {
			return sendRequest('host/rest.request', params, params.timeoutMs ?? 10000);
		},
		uploadFile(params) {
			// Larger timeout — uploads can take a while.
			return sendRequest('host/file.upload', params, 60000);
		},
		set onhostcontextchanged(handler: ((ctx: any) => void) | undefined) {
			contextHandler = handler;
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
