/**
 * Hook to access the MCP App instance from PrivosAppProvider context.
 */
import { useContext } from 'react';

import { PrivosAppContext } from './PrivosAppProvider';
import type { McpApp } from './PrivosAppProvider';

export function usePrivosApp(): McpApp {
	const app = useContext(PrivosAppContext);
	if (!app) {
		throw new Error('usePrivosApp must be used within a PrivosAppProvider');
	}
	return app;
}
