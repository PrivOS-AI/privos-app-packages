/**
 * Context provider that initializes the MCP App connection and provides it to the tree.
 * Wraps the standard App class from @modelcontextprotocol/ext-apps.
 */
import { createContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/** Minimal MCP App interface (mirrors @modelcontextprotocol/ext-apps App class) */
export interface McpApp {
	connect(): Promise<void>;
	disconnect(): void;
	callServerTool(params: { name: string; arguments: Record<string, any> }): Promise<any>;
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
		async callServerTool(params) {
			const id = nextId++;
			return new Promise((resolve, reject) => {
				pendingCalls.set(id, { resolve, reject });
				window.parent.postMessage({ jsonrpc: '2.0', id, method: 'tools/call', params }, '*');
				setTimeout(() => {
					if (pendingCalls.has(id)) {
						pendingCalls.delete(id);
						reject(new Error('Tool call timeout'));
					}
				}, 10000);
			});
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
