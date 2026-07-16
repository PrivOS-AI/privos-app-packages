#!/usr/bin/env npx tsx
/**
 * Staging-only probe for Direct/Relay MCP caller envelopes.
 *
 * This is intentionally NOT a mock-based Phase 0 substitute.
 * Status: blocked until staging credentials are provided.
 *
 * Required env (when unblocked):
 *   PRIVOS_URL
 *   DIRECT_MCP_URL
 *   RELAY_CLIENT_ID / RELAY_CLIENT_SECRET
 *   Optional: PRIVOS_USER_JWT for authenticated Direct samples
 *
 * Output policy: field shapes / types / lengths / hashes only — never token values.
 */
const required = ['PRIVOS_URL', 'DIRECT_MCP_URL', 'RELAY_CLIENT_ID', 'RELAY_CLIENT_SECRET'] as const;
const missing = required.filter((k) => !process.env[k]?.trim());

if (missing.length) {
	console.error(
		'[probe-relay-contract] Phase 0 blocked — missing env: ' + missing.join(', ') + '\n' +
			'Do not invent envelopes from mocks. Obtain staging operator access, then re-run.',
	);
	process.exit(2);
}

console.error(
	'[probe-relay-contract] Credentials present but interactive sample capture is not automated yet.\n' +
		'Next: implement redacted capture against live Hub (separate from CI).',
);
process.exit(2);
