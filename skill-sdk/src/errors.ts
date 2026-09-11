/**
 * errors.ts — Typed error classes for egress failures.
 *
 * EgressDeniedError   — proxy returned 403 (no catalog entry for domain).
 * ProxyUnreachableError — fetch to proxy failed (network/DNS).
 * UpstreamError         — upstream returned HTTP >= 400.
 */

/** Proxy returned 403: the target domain has no catalog entry for this project. */
export class EgressDeniedError extends Error {
  readonly name = 'EgressDeniedError';
  /** Target host that was blocked. */
  readonly host: string;
  /** Hint for the skill developer. */
  readonly hint: string;

  constructor(host: string) {
    super(`Egress denied: no catalog entry for host "${host}". Add the domain to the project egress catalog.`);
    this.host = host;
    this.hint = 'Use the PrivOS admin API to add a catalog entry for this domain.';
    // Restore prototype chain in compiled output (tsup / tsc target ES5 workaround)
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Network-level failure reaching the proxy (connection refused, DNS, timeout). */
export class ProxyUnreachableError extends Error {
  readonly name = 'ProxyUnreachableError';
  /** Proxy URL that could not be reached. */
  readonly proxyUrl: string;
  /** Underlying cause if available. */
  readonly cause: unknown;

  constructor(proxyUrl: string, cause?: unknown) {
    super(`Proxy unreachable at "${proxyUrl}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.proxyUrl = proxyUrl;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Upstream service returned an HTTP error status (>= 400). */
export class UpstreamError extends Error {
  readonly name = 'UpstreamError';
  /** HTTP status code from upstream. */
  readonly status: number;
  /** Target URL (host + path, no query to avoid leaking injected keys). */
  readonly target: string;
  /** Response body text if available and small enough to include. */
  readonly responseBody?: string;

  constructor(status: number, target: string, responseBody?: string) {
    super(`Upstream error ${status} from "${target}"${responseBody ? `: ${responseBody.slice(0, 200)}` : ''}`);
    this.status = status;
    this.target = target;
    this.responseBody = responseBody;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
