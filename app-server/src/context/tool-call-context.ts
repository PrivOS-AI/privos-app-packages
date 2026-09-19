import type { VerifiedRuntimeAuthorizationV3 } from '../workload/dispatch-assertion.js';

/**
 * How a `VerifiedActor` was established:
 * - `'dispatch-assertion'` — a Hub-signed dispatch assertion carried an
 *   embedded `actor` claim (managed Cluster ingress, Direct transport only).
 * - `'user-token'` — a separate Hub-signed RS256 user JWT was verified
 *   against the Hub JWKS (Direct bearer header, or Relay
 *   `_meta.privosUser.userToken`).
 * Apps that want stricter policy for one provenance than the other can branch
 * on this field; `context.transport` narrows it further (e.g. relay + user-token).
 */
export type VerifiedActorProvenance = 'dispatch-assertion' | 'user-token';

export interface VerifiedActor {
	/** JWT `sub` — stable opaque user id. */
	userId: string;
	/** JWT `preferred_username` when present — display only. */
	username?: string;
	/** JWT `rid` when present. */
	roomId?: string;
	/**
	 * The caller's OWN role names in `roomId` (`owner` | `moderator` | `leader` | …), lifted
	 * from the Hub-signed `room_roles` claim. Present only when the app was granted the
	 * `rooms:roles:read` scope AND the token carries a `rid`; `[]` means a plain member.
	 * Gate room-owner/moderator actions on this, e.g. `actor.roomRoles?.includes('owner')`.
	 */
	roomRoles?: string[];
	/**
	 * The caller's OWN workspace role names, lifted from the Hub-signed `workspace_roles`
	 * claim (contains `admin` for a workspace admin). Present only when the app was granted
	 * the `rooms:roles:read` scope. Gate workspace-admin actions on this, e.g.
	 * `actor.workspaceRoles?.includes('admin')`.
	 */
	workspaceRoles?: string[];
	/** Raw claims subset safe for app policy (no token string). */
	claims: Readonly<Record<string, unknown>>;
	/** How this actor was established — see {@link VerifiedActorProvenance}. */
	provenance: VerifiedActorProvenance;
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
	/** Immutable Hub runtime authorization verified at the final HTTP/Relay boundary. */
	readonly runtimeAuthorization?: VerifiedRuntimeAuthorizationV3;
	/**
	 * Scope for duplicate in-flight JSON-RPC id detection.
	 * Direct: MCP-Session-Id or per-request ephemeral id.
	 * Relay: WebSocket connection generation.
	 */
	sessionScope: string;
	/** Aborted when the runtime request timeout fires. Handlers should honor when possible. */
	signal?: AbortSignal;
}
