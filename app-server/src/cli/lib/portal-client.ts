/**
 * Thin fetch wrapper for the `/api/cloud/marketplace/*` publish routes: JSON
 * request/response, retry-after-driven backoff on transient 429/5xx, and a
 * typed {@link PortalError} carrying the Portal's `code` for callers that
 * branch on specific wire-contract error codes (`VERSION_SEMVER_EXISTS`,
 * `PUBLISH_GRANT_EXPIRED`, `PUBLISH_GRANT_MISMATCH`, `LISTING_NOT_BOUND`,
 * `LISTING_UNRESOLVED`, RFC 8628 `slow_down`, …).
 */
export class PortalError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly code?: string,
		public readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = 'PortalError';
	}
}

export type PortalRequestInit = Readonly<{
	method?: string;
	/** Bearer token: publisher token (`pvp_…`), publish grant (`pvg_…`), or none (anonymous create). */
	token?: string;
	body?: unknown;
}>;

export type PortalClientOptions = Readonly<{
	origin: string;
	basePath?: string;
	fetchImpl?: typeof fetch;
	maxRetries?: number;
	sleepImpl?: (ms: number) => Promise<void>;
}>;

const DEFAULT_BASE_PATH = '/api/cloud/marketplace';
const DEFAULT_MAX_RETRIES = 5;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRetryAfterMs(header: string | null): number | undefined {
	if (!header) return undefined;
	if (/^\d+$/.test(header)) return Number(header) * 1000;
	const parsed = Date.parse(header);
	if (Number.isNaN(parsed)) return undefined;
	return Math.max(0, parsed - Date.now());
}

export class PortalClient {
	private readonly origin: string;
	private readonly basePath: string;
	private readonly fetchImpl: typeof fetch;
	private readonly maxRetries: number;
	private readonly sleepImpl: (ms: number) => Promise<void>;

	constructor(options: PortalClientOptions) {
		this.origin = options.origin.replace(/\/+$/, '');
		this.basePath = options.basePath ?? DEFAULT_BASE_PATH;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.sleepImpl = options.sleepImpl ?? defaultSleep;
	}

	async request<T>(path: string, init: PortalRequestInit = {}): Promise<T> {
		const method = init.method ?? 'GET';
		const url = `${this.origin}${this.basePath}${path}`;
		let attempt = 0;
		for (;;) {
			const response = await this.fetchImpl(url, {
				method,
				headers: {
					...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
					...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
				},
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			});
			const text = await response.text();
			let parsed: unknown;
			try {
				parsed = text ? JSON.parse(text) : {};
			} catch {
				parsed = { raw: text.slice(0, 500) };
			}
			if (response.ok) return parsed as T;

			const record = parsed as Record<string, unknown> | undefined;
			const code = typeof record?.code === 'string' ? record.code : undefined;
			const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
			const transient = response.status === 429 || (response.status >= 500 && response.status < 600);
			if (transient && attempt < this.maxRetries) {
				const backoffMs = retryAfterMs ?? Math.min(30_000, 1_000 * 2 ** attempt);
				await this.sleepImpl(backoffMs);
				attempt += 1;
				continue;
			}
			const message = typeof record?.message === 'string' ? record.message : `${method} ${path} failed (${response.status})`;
			throw new PortalError(message, response.status, code, retryAfterMs);
		}
	}
}
