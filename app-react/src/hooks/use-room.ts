/**
 * Convenience hook: fetch room metadata via privos.rooms.get.
 * Uses roomId from usePrivosContext if not provided.
 */
import { usePrivosTool } from '../use-privos-tool';
import { usePrivosContext } from '../use-privos-context';
import type { UsePrivosToolResult } from '../use-privos-tool';

export function useRoom(roomId?: string): UsePrivosToolResult<any> {
	const context = usePrivosContext();
	const id = roomId || context.roomId;
	return usePrivosTool('privos.rooms.get', { roomId: id });
}
