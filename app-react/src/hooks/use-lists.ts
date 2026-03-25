/**
 * Convenience hook: fetch all lists in a room via privos.lists.getAll.
 */
import { usePrivosTool } from '../use-privos-tool';
import type { UsePrivosToolResult } from '../use-privos-tool';

export function useLists(roomId: string): UsePrivosToolResult<any[]> {
	return usePrivosTool<any[]>('privos.lists.getAll', { roomId });
}
