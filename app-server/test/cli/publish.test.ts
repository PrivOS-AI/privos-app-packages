import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runPublish } from '../../src/cli/commands/publish.js';
import { FakeMarketplacePortal } from './support/fake-marketplace-portal.js';
import { createGitFixtureRepo, removeFixtureRepo, standardAppFixtureFiles } from './support/git-fixture-repo.js';

const noopSleep = async (): Promise<void> => {};

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
const fixtures: string[] = [];

beforeEach(() => {
	stdoutChunks = [];
	stderrChunks = [];
	stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
		stdoutChunks.push(String(chunk));
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
		stderrChunks.push(String(chunk));
		return true;
	});
	consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		stdoutChunks.push(args.map(String).join(' '));
	});
	consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		stderrChunks.push(args.map(String).join(' '));
	});
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	consoleLogSpy.mockRestore();
	consoleErrorSpy.mockRestore();
	while (fixtures.length > 0) removeFixtureRepo(fixtures.pop()!);
});

function fixtureRepo(name: string, version: string): string {
	const dir = createGitFixtureRepo(standardAppFixtureFiles(name, version));
	fixtures.push(dir);
	return dir;
}

function capturedOutput(): string {
	return [...stdoutChunks, ...stderrChunks].join('');
}

function parseNdjson(): Array<Record<string, unknown>> {
	return stdoutChunks
		.join('')
		.split('\n')
		.filter((line) => line.trim().startsWith('{'))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('runPublish — --dry-run', () => {
	it('packages only, prints the git revision + sha256, and exits 0', async () => {
		const repo = fixtureRepo('com.example.dryrun', '1.0.0');
		const exitCode = await runPublish(['--dry-run', '--json'], { cwd: repo, env: {}, isTTY: false, sleepImpl: noopSleep });
		expect(exitCode).toBe(0);
		const events = parseNdjson();
		expect(events.some((event) => event.event === 'package')).toBe(true);
		expect(events.some((event) => event.event === 'status' && event.state === 'DRY_RUN')).toBe(true);
	});
});

describe('runPublish — usage errors', () => {
	it('exits 5 on an unrecognized flag', async () => {
		const repo = fixtureRepo('com.example.usage', '1.0.0');
		const exitCode = await runPublish(['--not-a-real-flag'], { cwd: repo, env: {}, isTTY: false });
		expect(exitCode).toBe(5);
	});

	it('exits 5 when privos-app.json is missing', async () => {
		const repo = fixtureRepo('com.example.usage2', '1.0.0');
		const exitCode = await runPublish(['--json'], { cwd: path.join(repo, 'src'), env: {}, isTTY: false, sleepImpl: noopSleep });
		expect(exitCode).toBe(5);
	});
});

describe('runPublish — interactive device flow (approve mid-poll) reaches submit', () => {
	it('exits 0 and reports a final status after approval, upload, version and submit', async () => {
		const repo = fixtureRepo('com.example.interactive', '1.0.0');
		const portal = new FakeMarketplacePortal({ defaultAutoApproveAfterPolls: 2, preflightTicksToReady: 1 });

		const exitCode = await runPublish(['--json', '--yes'], {
			cwd: repo,
			env: {},
			isTTY: false,
			fetchImpl: portal.fetch,
			sleepImpl: noopSleep,
			cliVersion: '0.9.0-test',
		});

		expect(exitCode).toBe(0);
		const events = parseNdjson();
		expect(events.some((event) => event.event === 'authorization_device')).toBe(true);
		expect(events.some((event) => event.event === 'authorization_approved')).toBe(true);
		expect(events.some((event) => event.event === 'upload_complete')).toBe(true);
		expect(events.some((event) => event.event === 'version_created')).toBe(true);
		expect(events.some((event) => event.event === 'submitted')).toBe(true);
		const finalStatus = events.filter((event) => event.event === 'status').at(-1);
		expect(finalStatus?.state).toBe('READY_FOR_REVIEW');

		const output = capturedOutput();
		for (const grantValue of portal.getAllGrantValues()) expect(output).not.toContain(grantValue);
	});
});

describe('runPublish — publisher-token flow (CI) reaches submit without a browser step', () => {
	it('exits 0 with no authorization_device event when the listing is already bound', async () => {
		const repo = fixtureRepo('com.example.tokenflow', '1.0.0');
		const portal = new FakeMarketplacePortal({ preflightTicksToReady: 1 });
		portal.seedListing({ slug: 'tokenflow', name: 'Token Flow', manifestName: 'com.example.tokenflow' });
		const token = portal.seedPublisherToken();

		const exitCode = await runPublish(['--json'], {
			cwd: repo,
			env: { PRIVOS_PUBLISHER_TOKEN: token },
			isTTY: false,
			fetchImpl: portal.fetch,
			sleepImpl: noopSleep,
		});

		expect(exitCode).toBe(0);
		const events = parseNdjson();
		expect(events.some((event) => event.event === 'authorization_device')).toBe(false);
		expect(events.some((event) => event.event === 'authorization_token')).toBe(true);
		expect(events.some((event) => event.event === 'submitted')).toBe(true);

		const output = capturedOutput();
		expect(output).not.toContain(token);
		for (const grantValue of portal.getAllGrantValues()) expect(output).not.toContain(grantValue);
	});
});

describe('runPublish — denied / expired authorization', () => {
	it('exits 3 when the browser approver denies the request', async () => {
		const repo = fixtureRepo('com.example.denied', '1.0.0');
		const portal = new FakeMarketplacePortal({});
		// The fake portal denies on the very first poll via a tiny helper: approve() is never
		// called, and we drive deny() through a poll-count trick by pre-seeding a listing and
		// immediately denying the well-known device code captured from the emitted event.
		const exitCode = await runPublishAndDenyMidPoll(repo, portal);
		expect(exitCode).toBe(3);
	});

	it('exits 3 when the authorization expires before approval', async () => {
		const repo = fixtureRepo('com.example.expired', '1.0.0');
		const portal = new FakeMarketplacePortal({ deviceExpiresInSeconds: 0 });

		const exitCode = await runPublish(['--json', '--yes'], {
			cwd: repo,
			env: {},
			isTTY: false,
			fetchImpl: portal.fetch,
			sleepImpl: noopSleep,
		});

		expect(exitCode).toBe(3);
		const events = parseNdjson();
		expect(events.some((event) => event.event === 'authorization_expired')).toBe(true);
	});
});

async function runPublishAndDenyMidPoll(repo: string, portal: FakeMarketplacePortal): Promise<number> {
	// Deny after the 1st poll using the same "auto-decision on Nth poll" mechanism as approval,
	// by wrapping fetch to intercept the freshly issued deviceCode and denying it out-of-band.
	let denied = false;
	const fetchImpl: typeof fetch = async (input, init) => {
		const response = await portal.fetch(input, init);
		if (!denied) {
			const cloned = response.clone();
			const body = (await cloned.json().catch(() => undefined)) as Record<string, unknown> | undefined;
			if (body && typeof body.deviceCode === 'string') {
				denied = true;
				portal.deny(body.deviceCode);
			}
		}
		return response;
	};
	return runPublish(['--json', '--yes'], { cwd: repo, env: {}, isTTY: false, fetchImpl, sleepImpl: noopSleep });
}

describe('runPublish — VERSION_SEMVER_EXISTS maps to exit 2', () => {
	it('exits 2 with a bump-the-version message when the semver already exists', async () => {
		const repo = fixtureRepo('com.example.semverexists', '1.0.0');
		const portal = new FakeMarketplacePortal({ defaultAutoApproveAfterPolls: 1 });
		const listing = portal.seedListing({ slug: 'semverexists', name: 'Semver Exists', manifestName: 'com.example.semverexists' });
		portal.seedVersion(listing.id, '1.0.0');

		const exitCode = await runPublish(['--json', '--yes'], {
			cwd: repo,
			env: {},
			isTTY: false,
			fetchImpl: portal.fetch,
			sleepImpl: noopSleep,
		});

		expect(exitCode).toBe(2);
		const events = parseNdjson();
		const errorEvent = events.find((event) => event.event === 'error');
		expect(errorEvent?.code).toBe('VERSION_SEMVER_EXISTS');
		expect(String(errorEvent?.message)).toMatch(/bump/i);
	});
});

describe('runPublish — LISTING_NOT_BOUND maps to exit 2', () => {
	it('exits 2 telling the publisher to approve interactively first', async () => {
		const repo = fixtureRepo('com.example.notbound', '1.0.0');
		const portal = new FakeMarketplacePortal({});
		portal.seedListing({ slug: 'notbound', name: 'Not Bound' });
		const token = portal.seedPublisherToken();

		const exitCode = await runPublish(['--json', '--listing', 'notbound'], {
			cwd: repo,
			env: { PRIVOS_PUBLISHER_TOKEN: token },
			isTTY: false,
			fetchImpl: portal.fetch,
			sleepImpl: noopSleep,
		});

		expect(exitCode).toBe(2);
		const events = parseNdjson();
		const errorEvent = events.find((event) => event.event === 'error');
		expect(errorEvent?.code).toBe('LISTING_NOT_BOUND');
		const output = capturedOutput();
		expect(output).not.toContain(token);
	});
});

describe('runPublish — PUBLISH_GRANT_MISMATCH maps to exit 2', () => {
	it('exits 2 when the Portal reports the uploaded archive does not match the authorization', async () => {
		const repo = fixtureRepo('com.example.mismatch', '1.0.0');
		const portal = new FakeMarketplacePortal({ defaultAutoApproveAfterPolls: 1, forceArchiveSha256Mismatch: true });

		const exitCode = await runPublish(['--json', '--yes'], {
			cwd: repo,
			env: {},
			isTTY: false,
			fetchImpl: portal.fetch,
			sleepImpl: noopSleep,
		});

		expect(exitCode).toBe(2);
		const events = parseNdjson();
		const errorEvent = events.find((event) => event.event === 'error');
		expect(errorEvent?.code).toBe('PUBLISH_GRANT_MISMATCH');
	});
});

describe('runPublish — secrets never appear in captured output', () => {
	it('masks the publisher token and never prints the raw grant value across all scenarios above', async () => {
		const repo = fixtureRepo('com.example.secrets', '1.0.0');
		const portal = new FakeMarketplacePortal({ preflightTicksToReady: 1 });
		portal.seedListing({ slug: 'secrets', name: 'Secrets', manifestName: 'com.example.secrets' });
		const token = portal.seedPublisherToken();

		const exitCode = await runPublish(['--json'], {
			cwd: repo,
			env: { PRIVOS_PUBLISHER_TOKEN: token },
			isTTY: false,
			fetchImpl: portal.fetch,
			sleepImpl: noopSleep,
		});

		expect(exitCode).toBe(0);
		const output = capturedOutput();
		expect(output).not.toContain(token);
		for (const grantValue of portal.getAllGrantValues()) expect(output).not.toContain(grantValue);
		const tokenEvent = parseNdjson().find((event) => event.event === 'authorization_token');
		expect(String(tokenEvent?.maskedToken)).not.toBe(token);
		expect(String(tokenEvent?.maskedToken)).toContain(token.slice(0, 8));
	});
});
