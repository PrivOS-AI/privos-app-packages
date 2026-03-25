/**
 * Hook that subscribes to HOST_CONTEXT_CHANGED push for base context (userId, username, theme)
 * and calls privos.context.get for Privos-specific data (roomId, roomName, userRoles).
 * Returns merged context object.
 */
import { useEffect, useState } from 'react';

import { usePrivosApp } from './use-privos-app';

export interface PrivosContext {
	userId: string;
	username: string;
	theme: string;
	roomId: string;
	roomName: string;
	userRoles: string[];
}

const defaultContext: PrivosContext = {
	userId: '',
	username: '',
	theme: 'light',
	roomId: '',
	roomName: '',
	userRoles: [],
};

export function usePrivosContext(): PrivosContext {
	const app = usePrivosApp();
	const [context, setContext] = useState<PrivosContext>(defaultContext);

	useEffect(() => {
		// Subscribe to host context push (standard MCP Apps mechanism)
		app.onhostcontextchanged = (ctx: any) => {
			setContext((prev) => ({ ...prev, ...ctx }));
		};

		// Fetch Privos-specific context via tool call (supplement)
		app.callServerTool({ name: 'privos.context.get', arguments: {} })
			.then((result: any) => {
				const data = typeof result?.content?.[0]?.text === 'string'
					? JSON.parse(result.content[0].text)
					: result;
				setContext((prev) => ({ ...prev, ...data }));
			})
			.catch(() => { /* Context fetch failed — will rely on HOST_CONTEXT_CHANGED */ });

		return () => {
			app.onhostcontextchanged = undefined;
		};
	}, [app]);

	return context;
}
