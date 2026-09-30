import { describe, expect, it } from 'vitest';

import { PortalClient, PortalError } from '../../src/cli/lib/portal-client.js';

function clientAnswering(status: number, body: unknown): PortalClient {
	const fetchImpl = (async () =>
		new Response(typeof body === 'string' ? body : JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		})) as typeof fetch;
	return new PortalClient({ origin: 'https://portal.example.test', fetchImpl, maxRetries: 0 });
}

async function errorFrom(client: PortalClient): Promise<PortalError> {
	const error = await client.request('/creator/listings/x/uploads', { method: 'POST', body: {} }).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(PortalError);
	return error as PortalError;
}

describe('PortalClient error bodies', () => {
	it('uses message and code when the Portal sends them', async () => {
		const error = await errorFrom(clientAnswering(403, { error: 'publisher_not_enabled', code: 'PUBLISHER_NOT_ENABLED', message: 'Not open yet.' }));
		expect(error.message).toBe('Not open yet.');
		expect(error.code).toBe('PUBLISHER_NOT_ENABLED');
		expect(error.status).toBe(403);
	});

	it('falls back to a string error and appends at most five finding messages', async () => {
		const findings = Array.from({ length: 7 }, (_, index) => ({ code: 'manifest_invalid', message: `problem ${index + 1}` }));
		const error = await errorFrom(clientAnswering(400, { error: 'archive_policy_violation', findings }));
		expect(error.message).toContain('archive_policy_violation');
		expect(error.message).toContain('problem 1');
		expect(error.message).toContain('problem 5');
		expect(error.message).not.toContain('problem 6');
	});

	it('keeps the status line when the body carries nothing readable', async () => {
		const error = await errorFrom(clientAnswering(400, {}));
		expect(error.message).toBe('POST /creator/listings/x/uploads failed (400)');
	});
});
