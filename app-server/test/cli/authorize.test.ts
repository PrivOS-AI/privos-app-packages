import { describe, expect, it } from 'vitest';

import { PortalClient, PortalError } from '../../src/cli/lib/portal-client.js';
import { createAuthorization, pollAuthorization, waitForApproval } from '../../src/cli/lib/authorize.js';
import { FakeMarketplacePortal } from './support/fake-marketplace-portal.js';

const noopSleep = async (): Promise<void> => {};

function client(portal: FakeMarketplacePortal): PortalClient {
	return new PortalClient({ origin: 'https://fake.portal.test', fetchImpl: portal.fetch, sleepImpl: noopSleep });
}

const baseRequest = {
	manifestName: 'com.example.fixture',
	semver: '1.0.0',
	archiveSha256: 'a'.repeat(64),
	archiveBytes: 1024,
	cliVersion: '0.9.0',
};

describe('createAuthorization — anonymous device flow', () => {
	it('returns a device code, user code and verification URL', async () => {
		const portal = new FakeMarketplacePortal();
		const outcome = await createAuthorization(client(portal), baseRequest);
		expect(outcome.kind).toBe('device');
		if (outcome.kind === 'device') {
			expect(outcome.deviceCode).toMatch(/^device_/);
			expect(outcome.userCode).toBeTruthy();
			expect(outcome.verificationUrl).toContain(outcome.userCode);
		}
	});
});

describe('poll — lost-response re-poll returns the same grant', () => {
	it('returns an identical grant on repeated polls while APPROVED', async () => {
		const portal = new FakeMarketplacePortal();
		const outcome = await createAuthorization(client(portal), baseRequest);
		if (outcome.kind !== 'device') throw new Error('expected device outcome');
		portal.approve(outcome.deviceCode);

		const first = await pollAuthorization(client(portal), outcome.deviceCode);
		const second = await pollAuthorization(client(portal), outcome.deviceCode);
		expect(first.state).toBe('APPROVED');
		expect(second.state).toBe('APPROVED');
		if (first.state === 'APPROVED' && second.state === 'APPROVED') {
			expect(second.grant.value).toBe(first.grant.value);
			expect(second.grant.value).toMatch(/^pvg_/);
		}
	});
});

describe('poll — RFC 8628 slow_down', () => {
	it('backs off and eventually resolves once approved, surviving slow_down responses', async () => {
		const portal = new FakeMarketplacePortal({ slowDownForPollsUpTo: 2 });
		const outcome = await createAuthorization(client(portal), baseRequest);
		if (outcome.kind !== 'device') throw new Error('expected device outcome');
		portal.autoApproveOnPoll(outcome.deviceCode, 3);

		const result = await waitForApproval(client(portal), outcome.deviceCode, {
			intervalMs: 1,
			expiresInMs: 60_000,
			sleepImpl: noopSleep,
		});
		expect(result.state).toBe('APPROVED');
	});

	it('surfaces a bare slow_down poll as a PortalError with that code', async () => {
		const portal = new FakeMarketplacePortal({ pollRequiredGapMs: 60_000 });
		const outcome = await createAuthorization(client(portal), baseRequest);
		if (outcome.kind !== 'device') throw new Error('expected device outcome');
		await pollAuthorization(client(portal), outcome.deviceCode);

		await expect(pollAuthorization(client(portal), outcome.deviceCode)).rejects.toMatchObject({
			code: 'slow_down',
		});
	});
});

describe('waitForApproval — denied / expired', () => {
	it('resolves DENIED when the browser approver rejects the request', async () => {
		const portal = new FakeMarketplacePortal();
		const outcome = await createAuthorization(client(portal), baseRequest);
		if (outcome.kind !== 'device') throw new Error('expected device outcome');
		portal.deny(outcome.deviceCode);

		const result = await waitForApproval(client(portal), outcome.deviceCode, { intervalMs: 1, expiresInMs: 60_000, sleepImpl: noopSleep });
		expect(result.state).toBe('DENIED');
	});

	it('resolves EXPIRED once the expiresIn window elapses without approval', async () => {
		const portal = new FakeMarketplacePortal();
		const outcome = await createAuthorization(client(portal), baseRequest);
		if (outcome.kind !== 'device') throw new Error('expected device outcome');

		const result = await waitForApproval(client(portal), outcome.deviceCode, { intervalMs: 1, expiresInMs: 1, sleepImpl: noopSleep });
		expect(result.state).toBe('EXPIRED');
	});
});

describe('createAuthorization — publisher token', () => {
	it('auto-approves inline with a grant when the listing is bound', async () => {
		const portal = new FakeMarketplacePortal();
		const listing = portal.seedListing({ slug: 'fixture-app', name: 'Fixture App', manifestName: baseRequest.manifestName });
		const token = portal.seedPublisherToken();

		const outcome = await createAuthorization(client(portal), baseRequest, token);
		expect(outcome.kind).toBe('grant');
		if (outcome.kind === 'grant') {
			expect(outcome.grant.value).toMatch(/^pvg_/);
			expect(outcome.listing.id).toBe(listing.id);
		}
	});

	it('rejects with 409 LISTING_NOT_BOUND when the listing has no bound manifestName', async () => {
		const portal = new FakeMarketplacePortal();
		portal.seedListing({ slug: 'fixture-app', name: 'Fixture App' });
		const token = portal.seedPublisherToken();

		await expect(createAuthorization(client(portal), { ...baseRequest, listingSlug: 'fixture-app' }, token)).rejects.toMatchObject({
			status: 409,
			code: 'LISTING_NOT_BOUND',
		});
	});

	it('rejects with 409 LISTING_UNRESOLVED when no listing matches manifestName or listingSlug', async () => {
		const portal = new FakeMarketplacePortal();
		const token = portal.seedPublisherToken();

		await expect(createAuthorization(client(portal), baseRequest, token)).rejects.toMatchObject({
			status: 409,
			code: 'LISTING_UNRESOLVED',
		});
	});
});

describe('grant lifecycle — PUBLISH_GRANT_EXPIRED', () => {
	it('reports 401 PUBLISH_GRANT_EXPIRED once the grant is past its TTL', async () => {
		const portal = new FakeMarketplacePortal();
		const outcome = await createAuthorization(client(portal), baseRequest);
		if (outcome.kind !== 'device') throw new Error('expected device outcome');
		portal.approve(outcome.deviceCode);
		const approved = await pollAuthorization(client(portal), outcome.deviceCode);
		if (approved.state !== 'APPROVED') throw new Error('expected APPROVED');
		portal.expireGrant(outcome.deviceCode);

		await expect(
			client(portal).request('/creator/listings/does-not-matter/uploads', {
				method: 'POST',
				token: approved.grant.value,
				body: { fileName: 'a.zip', totalBytes: 1, paths: [] },
			}),
		).rejects.toMatchObject({ status: 401, code: 'PUBLISH_GRANT_EXPIRED' });
	});
});

describe('PortalClient — retry-after backoff', () => {
	it('retries a transient 429 honoring retry-after and eventually succeeds', async () => {
		let calls = 0;
		const fetchImpl: typeof fetch = async () => {
			calls += 1;
			if (calls === 1) return new Response(JSON.stringify({ code: 'RATE_LIMITED' }), { status: 429, headers: { 'retry-after': '0' } });
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		};
		const portalClient = new PortalClient({ origin: 'https://fake.portal.test', fetchImpl, sleepImpl: noopSleep });
		const result = await portalClient.request('/anything');
		expect(result).toEqual({ ok: true });
		expect(calls).toBe(2);
	});

	it('surfaces a non-transient error as a PortalError with the server code', async () => {
		const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ code: 'VERSION_SEMVER_EXISTS', message: 'exists' }), { status: 409 });
		const portalClient = new PortalClient({ origin: 'https://fake.portal.test', fetchImpl, sleepImpl: noopSleep });
		await expect(portalClient.request('/anything')).rejects.toBeInstanceOf(PortalError);
		await expect(portalClient.request('/anything')).rejects.toMatchObject({ status: 409, code: 'VERSION_SEMVER_EXISTS' });
	});
});
