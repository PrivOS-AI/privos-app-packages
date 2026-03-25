/**
 * Convenience hook: fetch all files in a room via privos.files.getAll.
 */
import { usePrivosTool } from '../use-privos-tool';
import type { UsePrivosToolResult } from '../use-privos-tool';

export function useFiles(roomId: string): UsePrivosToolResult<any[]> {
	return usePrivosTool<any[]>('privos.files.getAll', { roomId });
}
