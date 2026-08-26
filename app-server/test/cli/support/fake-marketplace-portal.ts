import crypto from 'node:crypto';

/**
 * In-process fake Portal implementing the publish-authorization + publish
 * routes from `plan.md`'s "Wire contracts" section, just enough to drive the
 * CLI's authorize/upload/version/submit flow end to end in tests: anonymous
 * device-code create + poll (with RFC 8628 `slow_down`), publisher-token
 * auto-approve (`LISTING_NOT_BOUND` / `LISTING_UNRESOLVED`), grant-gated
 * creator routes (`PUBLISH_GRANT_EXPIRED` / `PUBLISH_GRANT_MISMATCH`), and
 * `VERSION_SEMVER_EXISTS`.
 */

type AuthorizationState = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'CONSUMED';

type AuthorizationRow = {
	id: string;
	deviceCode: string;
	userCode: string;
	state: AuthorizationState;
	manifestName: string;
	semver: string;
	archiveSha256: string;
	archiveBytes: number;
	listingId?: string;
	grantValue?: string;
	grantExpiresAt?: number;
	intervalMs: number;
	slowDownForPollsUpTo: number;
	pollRequiredGapMs: number;
	lastPollAt?: number;
	autoApproveAfterPolls?: number;
	pollCount: number;
	versionId?: string;
};

type ListingRow = {
	id: string;
	slug: string;
	name: string;
	manifestName?: string;
};

type UploadSessionRow = {
	id: string;
	listingId: string;
	authorizationId?: string;
	parts: Buffer[];
	completed: boolean;
};

type VersionRow = {
	id: string;
	listingId: string;
	semver: string;
	uploadId: string;
	changelog: string;
	state: string;
	getListingCallsSinceSubmit: number;
	preflightTicksToReady: number;
};

type PublisherTokenRow = {
	value: string;
	listingIds: string[] | null;
	revoked: boolean;
	expiresAt: number;
};

export type FakeMarketplacePortalOptions = Readonly<{
	/** The first N polls of every new authorization return RFC 8628 `slow_down` (count-based, not wall-clock — keeps retry-loop tests fast and deterministic). Default 0 (disabled). */
	slowDownForPollsUpTo?: number;
	/** Minimum real ms between polls of the same authorization before `slow_down` fires (wall-clock based — for single-shot "polled too fast" assertions). Default 0 (disabled). */
	pollRequiredGapMs?: number;
	/** Preflight leaves PREFLIGHT_PENDING after this many `GET listing` calls following submit. Default 1. */
	preflightTicksToReady?: number;
	/** Every new anonymous device authorization auto-approves on its Nth poll (simulates "approve mid-poll" without the test needing the deviceCode in advance). */
	defaultAutoApproveAfterPolls?: number;
	/** Overrides the device flow's `expiresIn` (seconds) for fast expiry tests. Default 900. */
	deviceExpiresInSeconds?: number;
	/** Test-only: makes `complete` see an archive digest that never matches what gets uploaded, forcing `PUBLISH_GRANT_MISMATCH`. */
	forceArchiveSha256Mismatch?: boolean;
}>;

function randomToken(prefix: string, bytes = 24): string {
	return `${prefix}${crypto.randomBytes(bytes).toString('base64url')}`;
}

export class FakeMarketplacePortal {
	private readonly authorizationsByDeviceCode = new Map<string, AuthorizationRow>();
	private readonly listings = new Map<string, ListingRow>();
	private readonly uploads = new Map<string, UploadSessionRow>();
	private readonly versions = new Map<string, VersionRow>();
	private readonly publisherTokens = new Map<string, PublisherTokenRow>();
	private readonly defaultSlowDownForPollsUpTo: number;
	private readonly defaultPollRequiredGapMs: number;
	private readonly defaultPreflightTicksToReady: number;
	private readonly defaultAutoApproveAfterPolls?: number;
	private readonly deviceExpiresInSeconds: number;
	private readonly forceArchiveSha256Mismatch: boolean;
	private listingSequence = 0;
	private uploadSequence = 0;
	private versionSequence = 0;
	private authorizationSequence = 0;

	constructor(options: FakeMarketplacePortalOptions = {}) {
		this.defaultSlowDownForPollsUpTo = options.slowDownForPollsUpTo ?? 0;
		this.defaultPollRequiredGapMs = options.pollRequiredGapMs ?? 0;
		this.defaultPreflightTicksToReady = options.preflightTicksToReady ?? 1;
		this.defaultAutoApproveAfterPolls = options.defaultAutoApproveAfterPolls;
		this.deviceExpiresInSeconds = options.deviceExpiresInSeconds ?? 900;
		this.forceArchiveSha256Mismatch = options.forceArchiveSha256Mismatch ?? false;
	}

	seedListing(input: Readonly<{ slug: string; name: string; manifestName?: string }>): ListingRow {
		this.listingSequence += 1;
		const listing: ListingRow = { id: `listing-${this.listingSequence}`, slug: input.slug, name: input.name, manifestName: input.manifestName };
		this.listings.set(listing.id, listing);
		return listing;
	}

	seedPublisherToken(input: Readonly<{ listingIds?: string[] | null; expiresAt?: number }> = {}): string {
		const value = randomToken('pvp_');
		this.publisherTokens.set(value, { value, listingIds: input.listingIds ?? null, revoked: false, expiresAt: input.expiresAt ?? Date.now() + 30 * 24 * 60 * 60 * 1000 });
		return value;
	}

	/** Test-only: pre-populates a version so a later `createVersion` for the same `(listingId, semver)` hits `VERSION_SEMVER_EXISTS`. */
	seedVersion(listingId: string, semver: string): void {
		this.versionSequence += 1;
		this.versions.set(`version-${this.versionSequence}`, {
			id: `version-${this.versionSequence}`,
			listingId,
			semver,
			uploadId: 'seed-upload',
			changelog: '',
			state: 'PUBLISHED',
			getListingCallsSinceSubmit: 0,
			preflightTicksToReady: this.defaultPreflightTicksToReady,
		});
	}

	/** Test-only: every grant value ever minted, so a test can assert none of them leaked into captured CLI output. */
	getAllGrantValues(): string[] {
		return [...this.authorizationsByDeviceCode.values()].map((row) => row.grantValue).filter((value): value is string => Boolean(value));
	}

	/** Simulates a human clicking Approve on `client.privos.io`. */
	approve(deviceCode: string): void {
		const row = this.authorizationsByDeviceCode.get(deviceCode);
		if (!row) throw new Error(`Unknown deviceCode: ${deviceCode}`);
		this.resolveApproval(row);
	}

	deny(deviceCode: string): void {
		const row = this.authorizationsByDeviceCode.get(deviceCode);
		if (!row) throw new Error(`Unknown deviceCode: ${deviceCode}`);
		row.state = 'DENIED';
	}

	/** Test-only escape hatch: force an already-approved grant into the past so the next use reports `PUBLISH_GRANT_EXPIRED`. */
	expireGrant(deviceCode: string): void {
		const row = this.authorizationsByDeviceCode.get(deviceCode);
		if (!row?.grantExpiresAt) throw new Error(`Authorization ${deviceCode} has no active grant`);
		row.grantExpiresAt = Date.now() - 1000;
	}

	private resolveApproval(row: AuthorizationRow): void {
		if (row.state !== 'PENDING') return;
		let listing = row.listingId ? this.listings.get(row.listingId) : undefined;
		if (!listing) listing = [...this.listings.values()].find((candidate) => candidate.manifestName === row.manifestName);
		if (!listing) {
			this.listingSequence += 1;
			listing = { id: `listing-${this.listingSequence}`, slug: row.manifestName.replaceAll('.', '-'), name: row.manifestName, manifestName: row.manifestName };
			this.listings.set(listing.id, listing);
		}
		if (!listing.manifestName) listing.manifestName = row.manifestName;
		row.listingId = listing.id;
		row.state = 'APPROVED';
		row.grantValue = `pvg_${row.id}.${crypto.randomBytes(12).toString('hex')}`;
		row.grantExpiresAt = Date.now() + 60 * 60 * 1000;
	}

	private effectiveArchiveSha256(claimed: string): string {
		if (!this.forceArchiveSha256Mismatch) return claimed;
		return claimed === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
	}

	private resolveGrant(token: string): { row: AuthorizationRow } {
		const match = /^pvg_([^.]+)\./.exec(token);
		if (!match) throw new PortalHttpError(401, 'PUBLISH_GRANT_INVALID', 'Not a recognizable publish grant.');
		const row = [...this.authorizationsByDeviceCode.values()].find((candidate) => candidate.id === match[1]);
		if (!row || row.grantValue !== token) throw new PortalHttpError(401, 'PUBLISH_GRANT_INVALID', 'Publish grant not found.');
		if (!row.grantExpiresAt || row.grantExpiresAt <= Date.now()) throw new PortalHttpError(401, 'PUBLISH_GRANT_EXPIRED', 'Publish grant has expired.');
		if (row.state === 'CONSUMED') throw new PortalHttpError(401, 'PUBLISH_GRANT_EXPIRED', 'Publish grant was already consumed.');
		return { row };
	}

	private resolvePublisherToken(token: string): PublisherTokenRow {
		const row = this.publisherTokens.get(token);
		if (!row || row.revoked) throw new PortalHttpError(401, 'PUBLISHER_TOKEN_REVOKED', 'Publisher token is invalid or revoked.');
		if (row.expiresAt <= Date.now()) throw new PortalHttpError(401, 'PUBLISHER_TOKEN_EXPIRED', 'Publisher token has expired.');
		return row;
	}

	private createAuthorization(body: Record<string, unknown>, token?: string): Record<string, unknown> {
		const manifestName = String(body.manifestName);
		const semver = String(body.semver);
		const listingSlug = typeof body.listingSlug === 'string' ? body.listingSlug : undefined;

		if (token) {
			const tokenRow = this.resolvePublisherToken(token);
			let listing = [...this.listings.values()].find((candidate) => candidate.manifestName === manifestName);
			if (!listing && listingSlug) listing = [...this.listings.values()].find((candidate) => candidate.slug === listingSlug);
			if (!listing) throw new PortalHttpError(409, 'LISTING_UNRESOLVED', 'Listing could not be resolved from manifestName or listingSlug.');
			if (tokenRow.listingIds && !tokenRow.listingIds.includes(listing.id)) {
				throw new PortalHttpError(403, 'PUBLISHER_TOKEN_SCOPE', 'Publisher token does not cover this listing.');
			}
			if (!listing.manifestName) throw new PortalHttpError(409, 'LISTING_NOT_BOUND', 'Listing has no bound manifestName; the first publish must be interactive.');

			this.authorizationSequence += 1;
			const row: AuthorizationRow = {
				id: `auth-${this.authorizationSequence}`,
				deviceCode: randomToken('device_'),
				userCode: 'TOKN-AUTO',
				state: 'PENDING',
				manifestName,
				semver,
				archiveSha256: this.effectiveArchiveSha256(String(body.archiveSha256)),
				archiveBytes: Number(body.archiveBytes),
				listingId: listing.id,
				intervalMs: 5000,
				slowDownForPollsUpTo: this.defaultSlowDownForPollsUpTo,
				pollRequiredGapMs: this.defaultPollRequiredGapMs,
				pollCount: 0,
			};
			this.authorizationsByDeviceCode.set(row.deviceCode, row);
			this.resolveApproval(row);
			return { grant: { token: row.grantValue, expiresAt: new Date(row.grantExpiresAt!).toISOString(), listingId: listing.id, listingSlug: listing.slug }, listing: { id: listing.id, slug: listing.slug, name: listing.name } };
		}

		this.authorizationSequence += 1;
		const row: AuthorizationRow = {
			id: `auth-${this.authorizationSequence}`,
			deviceCode: randomToken('device_'),
			userCode: `USER-${this.authorizationSequence}`,
			state: 'PENDING',
			manifestName,
			semver,
			archiveSha256: this.effectiveArchiveSha256(String(body.archiveSha256)),
			archiveBytes: Number(body.archiveBytes),
			intervalMs: 1,
			slowDownForPollsUpTo: this.defaultSlowDownForPollsUpTo,
			pollRequiredGapMs: this.defaultPollRequiredGapMs,
			pollCount: 0,
			autoApproveAfterPolls: this.defaultAutoApproveAfterPolls,
		};
		this.authorizationsByDeviceCode.set(row.deviceCode, row);
		return {
			deviceCode: row.deviceCode,
			userCode: row.userCode,
			verificationUrl: `https://client.privos.test/marketplace/publish?user_code=${row.userCode}`,
			expiresIn: this.deviceExpiresInSeconds,
			interval: row.intervalMs / 1000 || 1,
		};
	}

	/** Configures the Nth poll of `deviceCode` to auto-approve, simulating a human approving mid-poll. */
	autoApproveOnPoll(deviceCode: string, afterPolls: number): void {
		const row = this.authorizationsByDeviceCode.get(deviceCode);
		if (!row) throw new Error(`Unknown deviceCode: ${deviceCode}`);
		row.autoApproveAfterPolls = afterPolls;
	}

	private pollAuthorization(body: Record<string, unknown>): Record<string, unknown> {
		const deviceCode = String(body.deviceCode);
		const row = this.authorizationsByDeviceCode.get(deviceCode);
		if (!row) return { state: 'EXPIRED' };

		row.pollCount += 1;
		if (row.pollCount <= row.slowDownForPollsUpTo) {
			throw new PortalHttpError(400, 'slow_down', 'Polling faster than the authorized interval.');
		}
		if (row.pollRequiredGapMs > 0 && row.lastPollAt !== undefined && Date.now() - row.lastPollAt < row.pollRequiredGapMs) {
			throw new PortalHttpError(400, 'slow_down', 'Polling faster than the authorized interval.');
		}
		row.lastPollAt = Date.now();

		if (row.state === 'PENDING' && row.autoApproveAfterPolls !== undefined && row.pollCount >= row.autoApproveAfterPolls) {
			this.resolveApproval(row);
		}

		if (row.state === 'APPROVED') {
			return { state: 'APPROVED', grant: { token: row.grantValue, expiresAt: new Date(row.grantExpiresAt!).toISOString(), listingId: row.listingId, listingSlug: this.listings.get(row.listingId!)?.slug } };
		}
		return { state: row.state };
	}

	private createUploadSession(listingId: string, token: string, body: Record<string, unknown>): Record<string, unknown> {
		const { row: authRow } = this.resolveGrant(token);
		if (authRow.listingId !== listingId) throw new PortalHttpError(403, 'PUBLISH_GRANT_SCOPE', 'Grant does not cover this listing.');
		this.uploadSequence += 1;
		const upload: UploadSessionRow = { id: `upload-${this.uploadSequence}`, listingId, authorizationId: authRow.id, parts: [], completed: false };
		this.uploads.set(upload.id, upload);
		void body;
		return { upload: { id: upload.id } };
	}

	private putPart(uploadId: string, token: string, body: Record<string, unknown>): Record<string, unknown> {
		this.resolveGrant(token);
		const upload = this.uploads.get(uploadId);
		if (!upload) throw new PortalHttpError(404, 'UPLOAD_NOT_FOUND', 'Upload session not found.');
		upload.parts.push(Buffer.from(String(body.dataBase64), 'base64'));
		return {};
	}

	private completeUpload(uploadId: string, token: string): Record<string, unknown> {
		const { row: authRow } = this.resolveGrant(token);
		const upload = this.uploads.get(uploadId);
		if (!upload) throw new PortalHttpError(404, 'UPLOAD_NOT_FOUND', 'Upload session not found.');
		const assembled = Buffer.concat(upload.parts);
		const sha256 = crypto.createHash('sha256').update(assembled).digest('hex');
		if (upload.authorizationId && sha256 !== authRow.archiveSha256) {
			throw new PortalHttpError(409, 'PUBLISH_GRANT_MISMATCH', 'Uploaded archive does not match the approved authorization.');
		}
		upload.completed = true;
		const manifestDigest = `sha256:${crypto.createHash('sha256').update(`canonical:${sha256}`).digest('hex')}`;
		return { sha256, uploadId, manifestDigest, manifest: { name: authRow.manifestName, version: authRow.semver } };
	}

	private createVersion(listingId: string, token: string, body: Record<string, unknown>): Record<string, unknown> {
		const { row: authRow } = this.resolveGrant(token);
		const semver = String(body.semver);
		const existing = [...this.versions.values()].find((version) => version.listingId === listingId && version.semver === semver);
		if (existing) throw new PortalHttpError(409, 'VERSION_SEMVER_EXISTS', `Version ${semver} already exists for this listing.`);
		this.versionSequence += 1;
		const version: VersionRow = {
			id: `version-${this.versionSequence}`,
			listingId,
			semver,
			uploadId: String(body.uploadId),
			changelog: String(body.changelog ?? ''),
			state: 'UPLOADED',
			getListingCallsSinceSubmit: 0,
			preflightTicksToReady: this.defaultPreflightTicksToReady,
		};
		this.versions.set(version.id, version);
		authRow.versionId = version.id;
		return { version: { id: version.id, semver: version.semver, state: version.state } };
	}

	private submitVersion(listingId: string, token: string, body: Record<string, unknown>): Record<string, unknown> {
		const { row: authRow } = this.resolveGrant(token);
		const versionId = String(body.versionId);
		const version = this.versions.get(versionId);
		if (!version || version.listingId !== listingId) throw new PortalHttpError(404, 'VERSION_NOT_FOUND', 'Version not found.');
		if (authRow.versionId && authRow.versionId !== versionId) throw new PortalHttpError(403, 'PUBLISH_GRANT_SCOPE', 'Grant does not cover this version.');
		version.state = 'PREFLIGHT_PENDING';
		version.getListingCallsSinceSubmit = 0;
		authRow.state = 'CONSUMED';
		return {};
	}

	private getListingDetail(listingId: string): Record<string, unknown> {
		const listing = this.listings.get(listingId);
		if (!listing) throw new PortalHttpError(404, 'LISTING_NOT_FOUND', 'Listing not found.');
		const versions = [...this.versions.values()].filter((version) => version.listingId === listingId);
		for (const version of versions) {
			if (version.state === 'PREFLIGHT_PENDING') {
				version.getListingCallsSinceSubmit += 1;
				if (version.getListingCallsSinceSubmit >= version.preflightTicksToReady) version.state = 'READY_FOR_REVIEW';
			}
		}
		return { listing: { id: listing.id, slug: listing.slug, name: listing.name }, versions: versions.map((version) => ({ id: version.id, semver: version.semver, state: version.state })) };
	}

	/** `typeof fetch`-compatible handler to pass as `PortalClientOptions.fetchImpl`. */
	fetch: typeof globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
		const method = (init?.method ?? 'GET').toUpperCase();
		const token = extractBearerToken(init?.headers);
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

		try {
			const result = this.route(url.pathname, method, token, body);
			return jsonResponse(200, result);
		} catch (error) {
			if (error instanceof PortalHttpError) return jsonResponse(error.status, { code: error.code, message: error.message });
			throw error;
		}
	};

	private route(pathname: string, method: string, token: string | undefined, body: Record<string, unknown>): Record<string, unknown> {
		const base = '/api/cloud/marketplace';
		if (pathname === `${base}/publish-authorizations` && method === 'POST') return this.createAuthorization(body, token);
		if (pathname === `${base}/publish-authorizations/token` && method === 'POST') return this.pollAuthorization(body);

		const uploadsMatch = /^\/api\/cloud\/marketplace\/creator\/listings\/([^/]+)\/uploads$/.exec(pathname);
		if (uploadsMatch && method === 'POST') return this.createUploadSession(uploadsMatch[1]!, token ?? '', body);

		const partsMatch = /^\/api\/cloud\/marketplace\/creator\/uploads\/([^/]+)\/parts\/\d+$/.exec(pathname);
		if (partsMatch && method === 'PUT') return this.putPart(partsMatch[1]!, token ?? '', body);

		const completeMatch = /^\/api\/cloud\/marketplace\/creator\/uploads\/([^/]+)\/complete$/.exec(pathname);
		if (completeMatch && method === 'POST') return this.completeUpload(completeMatch[1]!, token ?? '');

		const versionsMatch = /^\/api\/cloud\/marketplace\/creator\/listings\/([^/]+)\/versions$/.exec(pathname);
		if (versionsMatch && method === 'POST') return this.createVersion(versionsMatch[1]!, token ?? '', body);

		const submitMatch = /^\/api\/cloud\/marketplace\/creator\/listings\/([^/]+)\/submit$/.exec(pathname);
		if (submitMatch && method === 'POST') return this.submitVersion(submitMatch[1]!, token ?? '', body);

		const listingMatch = /^\/api\/cloud\/marketplace\/creator\/listings\/([^/]+)$/.exec(pathname);
		if (listingMatch && method === 'GET') return this.getListingDetail(listingMatch[1]!);

		throw new PortalHttpError(404, 'NOT_FOUND', `No fake route for ${method} ${pathname}`);
	}
}

class PortalHttpError extends Error {
	constructor(public readonly status: number, public readonly code: string, message: string) {
		super(message);
	}
}

function extractBearerToken(headers: RequestInit['headers']): string | undefined {
	if (!headers) return undefined;
	const record = headers instanceof Headers ? Object.fromEntries(headers.entries()) : (headers as Record<string, string>);
	const authorization = record.Authorization ?? record.authorization;
	if (!authorization) return undefined;
	const match = /^Bearer (.+)$/.exec(authorization);
	return match?.[1];
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
