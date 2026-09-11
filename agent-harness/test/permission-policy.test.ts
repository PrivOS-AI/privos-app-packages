import { describe, expect, it } from 'vitest';
import { decidePermission } from '../src/acp/permission-policy.js';
import type { PermissionOption } from '@agentclientprotocol/sdk';

// Random, non-meaningful option ids on purpose: the policy must pick by
// `.kind`, never by parsing/guessing the id.
function options(): PermissionOption[] {
	return [
		{ optionId: 'xk2n9', name: 'Allow', kind: 'allow_once' },
		{ optionId: 'q7f01', name: 'Deny', kind: 'reject_once' },
	];
}

describe('decidePermission', () => {
	it('auto always allows, regardless of tool kind', () => {
		expect(decidePermission('auto', 'read', options())).toEqual({ optionId: 'xk2n9', optionKind: 'allow_once' });
		expect(decidePermission('auto', 'execute', options())).toEqual({ optionId: 'xk2n9', optionKind: 'allow_once' });
		expect(decidePermission('auto', undefined, options())).toEqual({ optionId: 'xk2n9', optionKind: 'allow_once' });
	});

	it('safe allows read/search/think/fetch and rejects everything else', () => {
		for (const kind of ['read', 'search', 'think', 'fetch'] as const) {
			expect(decidePermission('safe', kind, options())).toEqual({ optionId: 'xk2n9', optionKind: 'allow_once' });
		}
		for (const kind of ['execute', 'edit', 'delete', 'move', 'switch_mode', 'other'] as const) {
			expect(decidePermission('safe', kind, options())).toEqual({ optionId: 'q7f01', optionKind: 'reject_once' });
		}
	});

	it('deny always rejects, regardless of tool kind', () => {
		expect(decidePermission('deny', 'read', options())).toEqual({ optionId: 'q7f01', optionKind: 'reject_once' });
		expect(decidePermission('deny', 'execute', options())).toEqual({ optionId: 'q7f01', optionKind: 'reject_once' });
	});

	it('returns undefined when no option of the wanted kind is offered', () => {
		const onlyAllow: PermissionOption[] = [{ optionId: 'a1', name: 'Allow', kind: 'allow_once' }];
		expect(decidePermission('deny', 'read', onlyAllow)).toBeUndefined();
	});
});
