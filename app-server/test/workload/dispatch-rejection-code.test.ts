import { describe, expect, it } from 'vitest';

import { dispatchRejectionCode, dispatchRejectionReason } from '../../src/workload/dispatch-assertion.js';

describe('dispatchRejectionCode', () => {
	it('maps every verifier failure to its reason-specific code', () => {
		expect(dispatchRejectionCode(new Error('dispatch_assertion_missing'))).toBe('DISPATCH_ASSERTION_MISSING');
		expect(dispatchRejectionCode(new Error('dispatch_assertion_ambiguous'))).toBe('DISPATCH_ASSERTION_AMBIGUOUS');
		expect(dispatchRejectionCode('dispatch_assertion_unexpected')).toBe('DISPATCH_ASSERTION_UNEXPECTED');
		expect(dispatchRejectionCode(new Error('dispatch_assertion_replayed'))).toBe('DISPATCH_ASSERTION_REPLAYED');
		expect(dispatchRejectionCode(new Error('dispatch_assertion_time_invalid'))).toBe('DISPATCH_ASSERTION_EXPIRED');
		expect(dispatchRejectionCode(new Error('dispatch_assertion_body_mismatch'))).toBe('DISPATCH_ASSERTION_BODY_MISMATCH');
		expect(dispatchRejectionCode(new Error('dispatch_assertion_binding_mismatch'))).toBe('DISPATCH_ASSERTION_BINDING_MISMATCH');
		expect(dispatchRejectionCode(new Error('runtime_dispatch_trust_invalid'))).toBe('DISPATCH_TRUST_INVALID');
		expect(dispatchRejectionCode(new Error('runtime_dispatch_trust_mismatch'))).toBe('DISPATCH_TRUST_INVALID');
	});

	it('collapses unknown or malformed reasons to DISPATCH_ASSERTION_INVALID so no internal string leaks', () => {
		expect(dispatchRejectionCode(new Error('dispatch_assertion_invalid'))).toBe('DISPATCH_ASSERTION_INVALID');
		expect(dispatchRejectionCode(new Error('dispatch_assertion_replay_store_full'))).toBe('DISPATCH_ASSERTION_INVALID');
		expect(dispatchRejectionCode(new Error('dispatch_assertion_actor_invalid'))).toBe('DISPATCH_ASSERTION_INVALID');
		expect(dispatchRejectionCode(new TypeError('boom'))).toBe('DISPATCH_ASSERTION_INVALID');
		expect(dispatchRejectionCode(undefined)).toBe('DISPATCH_ASSERTION_INVALID');
		expect(dispatchRejectionCode({ message: 'dispatch_assertion_missing' })).toBe('DISPATCH_ASSERTION_INVALID');
		// Object.prototype keys must not resolve to a function (JSON.stringify would drop `code` entirely).
		for (const key of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
			expect(dispatchRejectionCode(new Error(key))).toBe('DISPATCH_ASSERTION_INVALID');
			expect(JSON.parse(JSON.stringify({ code: dispatchRejectionCode(key) })).code).toBe('DISPATCH_ASSERTION_INVALID');
		}
	});

	it('keeps only the verifier reasons for logs and clamps anything else to `other`', () => {
		expect(dispatchRejectionReason(new Error('runtime_dispatch_trust_invalid'))).toBe('runtime_dispatch_trust_invalid');
		expect(dispatchRejectionReason(new Error('runtime_dispatch_trust_mismatch'))).toBe('runtime_dispatch_trust_mismatch');
		expect(dispatchRejectionReason('dispatch_assertion_unexpected')).toBe('dispatch_assertion_unexpected');
		expect(dispatchRejectionReason(new Error('dispatch_assertion_invalid'))).toBe('dispatch_assertion_invalid');
		expect(dispatchRejectionReason(new Error(''))).toBe('dispatch_assertion_invalid');
		expect(dispatchRejectionReason(null)).toBe('dispatch_assertion_invalid');
		// Operational signals stay distinguishable in the log even though the wire code is generic.
		expect(dispatchRejectionReason(new Error('dispatch_assertion_replay_store_full'))).toBe('dispatch_assertion_replay_store_full');
		expect(dispatchRejectionReason(new Error('fetch failed: https://internal.broker/token'))).toBe('other');
		expect(dispatchRejectionReason(new Error('toString'))).toBe('other');
	});
});
