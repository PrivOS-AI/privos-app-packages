/**
 * `session/request_permission` policy. The option to select is always found
 * by `kind` (allow_once / reject_once), never by a hardcoded `optionId` — ids
 * are adapter-generated and must be treated as opaque.
 */
import type { PermissionOption, ToolKind } from '@agentclientprotocol/sdk';

export type PermissionPolicy = 'auto' | 'safe' | 'deny';

const SAFE_ALLOWED_KINDS: ReadonlySet<ToolKind> = new Set(['read', 'search', 'think', 'fetch']);

export interface PermissionDecision {
	optionId: string;
	optionKind: 'allow_once' | 'reject_once';
}

/**
 * Decides which option to select for a tool call of the given kind.
 * Returns `undefined` if no option of the required kind is offered (the
 * caller then answers `cancelled` — this should not happen with a spec
 * compliant agent, since agents must always offer both directions).
 */
export function decidePermission(policy: PermissionPolicy, toolKind: ToolKind | undefined, options: PermissionOption[]): PermissionDecision | undefined {
	const wantAllow = policy === 'auto' || (policy === 'safe' && toolKind !== undefined && SAFE_ALLOWED_KINDS.has(toolKind));
	const wantedOptionKind = wantAllow ? 'allow_once' : 'reject_once';
	const match = options.find((option) => option.kind === wantedOptionKind);
	if (!match) return undefined;
	return { optionId: match.optionId, optionKind: wantedOptionKind };
}
