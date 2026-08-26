import { PortalClient } from './portal-client.js';

/** Portal's `express.json()` body limit is 10 MB; base64 inflates bytes ~1.37x, so 5 MB parts stay well under it. */
export const DEFAULT_PART_SIZE_BYTES = 5 * 1024 * 1024;

export type UploadSession = Readonly<{ uploadId: string }>;

export async function createUploadSession(
	client: PortalClient,
	token: string,
	listingId: string,
	request: Readonly<{ fileName: string; totalBytes: number; paths: readonly string[] }>,
): Promise<UploadSession> {
	const response = await client.request<Record<string, unknown>>(`/creator/listings/${listingId}/uploads`, {
		method: 'POST',
		token,
		body: {
			fileName: request.fileName,
			totalBytes: request.totalBytes,
			kind: 'APP_SOURCE',
			paths: request.paths,
		},
	});
	const upload = response.upload as Record<string, unknown> | undefined;
	const uploadId = upload?.id;
	if (typeof uploadId !== 'string' || !uploadId) throw new Error('Portal did not return an upload session id.');
	return { uploadId };
}

/**
 * Uploads `buffer` as base64 parts, one at a time (sequential — never
 * concurrent), retrying transient 5xx/429 per-part via {@link PortalClient}'s
 * own retry-after backoff.
 */
export async function uploadPartsSequentially(
	client: PortalClient,
	token: string,
	uploadId: string,
	buffer: Buffer,
	partSizeBytes: number = DEFAULT_PART_SIZE_BYTES,
	onProgress?: (part: number, totalParts: number) => void,
): Promise<number> {
	const totalParts = Math.max(1, Math.ceil(buffer.length / partSizeBytes));
	for (let index = 0; index < totalParts; index += 1) {
		const start = index * partSizeBytes;
		const end = Math.min(buffer.length, start + partSizeBytes);
		const chunk = buffer.subarray(start, end);
		await client.request(`/creator/uploads/${uploadId}/parts/${index + 1}`, {
			method: 'PUT',
			token,
			body: { dataBase64: chunk.toString('base64') },
		});
		onProgress?.(index + 1, totalParts);
	}
	return totalParts;
}

export type CompleteUploadResult = Readonly<{
	sha256: string;
	uploadId: string;
	manifestDigest: string;
	manifest: Record<string, unknown>;
}>;

export async function completeUpload(client: PortalClient, token: string, uploadId: string): Promise<CompleteUploadResult> {
	const response = await client.request<Record<string, unknown>>(`/creator/uploads/${uploadId}/complete`, { method: 'POST', token, body: {} });
	return {
		sha256: String(response.sha256),
		uploadId: String(response.uploadId ?? uploadId),
		manifestDigest: String(response.manifestDigest),
		manifest: (response.manifest as Record<string, unknown>) ?? {},
	};
}

export type CreatedVersion = Readonly<{ id: string; semver: string; state: string }>;

export async function createVersion(
	client: PortalClient,
	token: string,
	listingId: string,
	request: Readonly<{ semver: string; uploadId: string; changelog: string }>,
): Promise<CreatedVersion> {
	const response = await client.request<Record<string, unknown>>(`/creator/listings/${listingId}/versions`, { method: 'POST', token, body: request });
	const version = response.version as Record<string, unknown>;
	return { id: String(version.id), semver: String(version.semver), state: String(version.state) };
}

export async function submitVersion(client: PortalClient, token: string, listingId: string, versionId: string): Promise<void> {
	await client.request(`/creator/listings/${listingId}/submit`, { method: 'POST', token, body: { versionId } });
}

export type ListingVersion = Readonly<{ id: string; semver: string; state: string }> & Record<string, unknown>;
export type ListingDetail = Readonly<{ listing: Record<string, unknown>; versions: readonly ListingVersion[]; events?: readonly Record<string, unknown>[] }>;

export async function getListingDetail(client: PortalClient, token: string, listingId: string): Promise<ListingDetail> {
	return client.request<ListingDetail>(`/creator/listings/${listingId}`, { method: 'GET', token });
}

export type WaitForPreflightOptions = Readonly<{
	timeoutMs?: number;
	pollMs?: number;
	sleepImpl?: (ms: number) => Promise<void>;
}>;

/** Polls listing detail up to `timeoutMs` (default 60 s) while the version sits in `PREFLIGHT_PENDING`. */
export async function waitForPreflight(
	client: PortalClient,
	token: string,
	listingId: string,
	versionId: string,
	options: WaitForPreflightOptions = {},
): Promise<ListingVersion | undefined> {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const pollMs = options.pollMs ?? 1_000;
	const sleepImpl = options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const deadline = Date.now() + timeoutMs;

	let detail = await getListingDetail(client, token, listingId);
	let version = detail.versions.find((item) => item.id === versionId);
	while (version?.state === 'PREFLIGHT_PENDING' && Date.now() < deadline) {
		await sleepImpl(pollMs);
		detail = await getListingDetail(client, token, listingId);
		version = detail.versions.find((item) => item.id === versionId);
	}
	return version;
}
