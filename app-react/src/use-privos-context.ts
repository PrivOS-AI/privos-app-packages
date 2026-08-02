/**
 * Subscribes to non-secret HOST_CONTEXT_CHANGED data and refreshes the same
 * user-delegated context through the mediated `mcpapp.context.get` tool.
 *
 * The iframe never receives a Hub bearer/user token. Backend calls that need a
 * user identity are dispatched by Hub with a short-lived signed assertion.
 */
import { useEffect, useRef, useState } from 'react';

import { parseToolResult } from './parse-tool-result.js';
import { usePrivosApp } from './use-privos-app';

export interface PrivosContext {
	userId: string;
	username: string;
	theme: string;
	roomId: string;
	roomName: string;
	userRoles: string[];
	effectiveScopes?: string[];
	roomSlug?: string;
	appId?: string;
	appUrl?: string;
}

const defaultState: PrivosContext = {
	userId: '',
	username: '',
	theme: 'light',
	roomId: '',
	roomName: '',
	userRoles: [],
};

function mergeHostContext(previous: PrivosContext, patch: Record<string, unknown>): PrivosContext {
	const stringValue = (key: keyof PrivosContext, fallback = ''): string => {
		const candidate = patch[key];
		return typeof candidate === 'string' && candidate.trim() ? candidate : String(previous[key] ?? fallback);
	};
	return {
		userId: stringValue('userId'),
		username: stringValue('username'),
		theme: stringValue('theme', 'light'),
		roomId: stringValue('roomId'),
		roomName: stringValue('roomName'),
		userRoles: Array.isArray(patch.userRoles) ? patch.userRoles.filter((role): role is string => typeof role === 'string') : previous.userRoles,
		...(Array.isArray(patch.effectiveScopes)
			? { effectiveScopes: patch.effectiveScopes.filter((scope): scope is string => typeof scope === 'string') }
			: previous.effectiveScopes ? { effectiveScopes: previous.effectiveScopes } : {}),
		...(stringValue('roomSlug') ? { roomSlug: stringValue('roomSlug') } : {}),
		...(stringValue('appId') ? { appId: stringValue('appId') } : {}),
		...(stringValue('appUrl') ? { appUrl: stringValue('appUrl') } : {}),
	};
}

export function usePrivosContext(): PrivosContext {
	const app = usePrivosApp();
	const [context, setContext] = useState<PrivosContext>(defaultState);
	const contextRef = useRef(context);
	contextRef.current = context;

	useEffect(() => {
		const apply = (patch: Record<string, unknown>) => {
			const merged = mergeHostContext(contextRef.current, patch);
			contextRef.current = merged;
			setContext(merged);
		};
		app.onhostcontextchanged = apply;
		void app.callServerTool({ name: 'mcpapp.context.get', arguments: {} })
			.then((result) => apply(parseToolResult(result)))
			.catch(() => undefined);
		return () => {
			app.onhostcontextchanged = undefined;
		};
	}, [app]);

	return context;
}
