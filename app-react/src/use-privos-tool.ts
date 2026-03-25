/**
 * Generic hook for calling any Privos MCP tool.
 * Returns { data, loading, error, refetch } pattern.
 */
import { useCallback, useEffect, useState } from 'react';

import { usePrivosApp } from './use-privos-app';

export interface UsePrivosToolResult<T = any> {
	data: T | null;
	loading: boolean;
	error: Error | null;
	refetch: () => void;
}

export function usePrivosTool<T = any>(toolName: string, args: Record<string, any>): UsePrivosToolResult<T> {
	const app = usePrivosApp();
	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);
	const argsKey = JSON.stringify(args);

	const fetchData = useCallback(async () => {
		// Skip fetch if any required arg value is empty/falsy
		const hasEmptyArgs = Object.values(args).some((v) => v === '' || v === null || v === undefined);
		if (hasEmptyArgs) {
			setLoading(false);
			return;
		}

		setLoading(true);
		setError(null);
		try {
			const result = await app.callServerTool({ name: toolName, arguments: args });
			const parsed = typeof result?.content?.[0]?.text === 'string'
				? JSON.parse(result.content[0].text)
				: result;
			setData(parsed as T);
		} catch (err: any) {
			setError(err);
		} finally {
			setLoading(false);
		}
	}, [app, toolName, argsKey]);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	return { data, loading, error, refetch: fetchData };
}
