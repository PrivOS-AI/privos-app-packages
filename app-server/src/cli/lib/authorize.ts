import { PortalClient, PortalError } from './portal-client.js';

/**
 * A publish grant as returned by the Portal — `pvg_<authorizationId>.<mac>`,
 * used verbatim as `Authorization: Bearer <value>`. Never composed
 * client-side; the CLI only ever forwards the Portal's own string.
 */
export type PublishGrant = Readonly<{
	value: string;
	expiresAt: string;
	listingId: string;
	listingSlug: string;
}>;

export type AuthorizationRequest = Readonly<{
	manifestName: string;
	semver: string;
	archiveSha256: string;
	archiveBytes: number;
	cliVersion: string;
	listingSlug?: string;
	machineLabel?: string;
}>;

export type AuthorizationOutcome =
	| Readonly<{ kind: 'grant'; grant: PublishGrant; listing: { id: string; slug: string; name?: string } }>
	| Readonly<{ kind: 'device'; deviceCode: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number }>;

export type PollOutcome =
	| Readonly<{ state: 'PENDING' }>
	| Readonly<{ state: 'APPROVED'; grant: PublishGrant }>
	| Readonly<{ state: 'DENIED' }>
	| Readonly<{ state: 'EXPIRED' }>
	| Readonly<{ state: 'CONSUMED' }>;

/** The states {@link waitForApproval} can resolve to — `PENDING` is a polling-loop-internal state only. */
export type TerminalPollOutcome = Exclude<PollOutcome, Readonly<{ state: 'PENDING' }>>;

function normalizeGrant(raw: Record<string, unknown>): PublishGrant {
	return {
		value: String(raw.token),
		expiresAt: String(raw.expiresAt),
		listingId: String(raw.listingId),
		listingSlug: String(raw.listingSlug),
	};
}

/**
 * `POST /publish-authorizations` — anonymous (interactive/device flow) or
 * bearer `pvp_…` (publisher token, CI). A token whose scope covers the
 * resolved listing and whose `manifestName` is already bound returns
 * `{ grant, listing }` inline (`kind: 'grant'`); otherwise the Portal issues
 * a device code (`kind: 'device'`). `409 LISTING_NOT_BOUND` / `409
 * LISTING_UNRESOLVED` surface as {@link PortalError} for the caller to map
 * to the documented exit codes and remediation text.
 */
export async function createAuthorization(client: PortalClient, request: AuthorizationRequest, token?: string): Promise<AuthorizationOutcome> {
	const body: Record<string, unknown> = {
		manifestName: request.manifestName,
		semver: request.semver,
		archiveSha256: request.archiveSha256,
		archiveBytes: request.archiveBytes,
		cliVersion: request.cliVersion,
		...(request.listingSlug ? { listingSlug: request.listingSlug } : {}),
		...(request.machineLabel ? { machineLabel: request.machineLabel } : {}),
	};
	const response = await client.request<Record<string, unknown>>('/publish-authorizations', { method: 'POST', token, body });
	if (response.grant) {
		return {
			kind: 'grant',
			grant: normalizeGrant(response.grant as Record<string, unknown>),
			listing: response.listing as { id: string; slug: string; name?: string },
		};
	}
	return {
		kind: 'device',
		deviceCode: String(response.deviceCode),
		userCode: String(response.userCode),
		verificationUrl: String(response.verificationUrl),
		expiresIn: Number(response.expiresIn),
		interval: Number(response.interval),
	};
}

/** `POST /publish-authorizations/token` — RFC 8628 polling; a `slow_down` error surfaces as a `PortalError` with that code. */
export async function pollAuthorization(client: PortalClient, deviceCode: string): Promise<PollOutcome> {
	const response = await client.request<Record<string, unknown>>('/publish-authorizations/token', { method: 'POST', body: { deviceCode } });
	const state = String(response.state);
	if (state === 'APPROVED') {
		return { state: 'APPROVED', grant: normalizeGrant(response.grant as Record<string, unknown>) };
	}
	return { state: state as 'PENDING' | 'DENIED' | 'EXPIRED' | 'CONSUMED' };
}

export type WaitForApprovalOptions = Readonly<{
	intervalMs: number;
	expiresInMs: number;
	onPending?: (elapsedMs: number) => void;
	sleepImpl?: (ms: number) => Promise<void>;
}>;

/**
 * Polls until a terminal state, honoring `slow_down` by backing off (RFC
 * 8628 §3.5) and stopping once the authorization's own `expiresIn` window
 * elapses. While `APPROVED`, the Portal returns the same grant on every
 * poll, so a lost response mid-poll is recoverable by design — this loop
 * simply returns on the first non-`PENDING` state it observes.
 */
export async function waitForApproval(client: PortalClient, deviceCode: string, options: WaitForApprovalOptions): Promise<TerminalPollOutcome> {
	const sleepImpl = options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let intervalMs = options.intervalMs;
	const start = Date.now();
	const deadline = start + options.expiresInMs;

	for (;;) {
		if (Date.now() >= deadline) return { state: 'EXPIRED' };
		await sleepImpl(intervalMs);
		try {
			const outcome = await pollAuthorization(client, deviceCode);
			if (outcome.state !== 'PENDING') return outcome;
			options.onPending?.(Date.now() - start);
		} catch (error) {
			if (error instanceof PortalError && error.code?.toLowerCase() === 'slow_down') {
				intervalMs += 5_000;
				continue;
			}
			throw error;
		}
	}
}
