export interface VerifiedActor {
	/** JWT `sub` — stable opaque user id. */
	userId: string;
	/** JWT `preferred_username` when present — display only. */
	username?: string;
	/** JWT `rid` when present. */
	roomId?: string;
	/** Raw claims subset safe for app policy (no token string). */
	claims: Readonly<Record<string, unknown>>;
}

export type IdentityState = 'verified' | 'missing' | 'invalid';

export interface ToolCallContext {
	transport: 'direct' | 'relay';
	requestId?: string | number | null;
	actor?: VerifiedActor;
	roomId?: string;
	appId?: string;
	traceId?: string;
	identityState: IdentityState;
	/**
	 * Scope for duplicate in-flight JSON-RPC id detection.
	 * Direct: MCP-Session-Id or per-request ephemeral id.
	 * Relay: WebSocket connection generation.
	 */
	sessionScope: string;
	/** Aborted when the runtime request timeout fires. Handlers should honor when possible. */
	signal?: AbortSignal;
}
