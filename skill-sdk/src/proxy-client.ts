/**
 * proxy-client.ts — Low-level egress fetch wrapper.
 *
 * egressFetch() is the single exit point for all outbound requests:
 *   - Sandbox mode: POST to proxy /egress with x-proxy-token header.
 *   - Non-sandbox mode: direct fetch with provided options.
 *
 * Error mapping:
 *   403 from proxy  → EgressDeniedError
 *   Network failure → ProxyUnreachableError
 *   HTTP >= 400     → UpstreamError (only for non-streaming callers that check)
 */
import { isSandboxMode, proxyUrl, proxyToken } from './mode.js';
import { EgressDeniedError, ProxyUnreachableError } from './errors.js';

export interface EgressOptions {
  method?: string;
  headers?: Record<string, string>;
  /** String or base64-encoded body. The proxy body field accepts string only. */
  body?: string;
}

/**
 * Core egress function. Returns the raw Response for callers to inspect.
 * Does NOT throw on upstream HTTP errors — callers decide how to handle status.
 * DOES throw EgressDeniedError (proxy 403) and ProxyUnreachableError (network).
 */
export async function egressFetch(url: string, opts: EgressOptions = {}): Promise<Response> {
  if (isSandboxMode()) {
    return sandboxFetch(url, opts);
  }
  return directFetch(url, opts);
}

// ── Sandbox path ─────────────────────────────────────────────────────────────

async function sandboxFetch(url: string, opts: EgressOptions): Promise<Response> {
  const proxy = proxyUrl();
  const token = proxyToken(); // throws if PROXY_TOKEN is missing

  const egressBody = JSON.stringify({
    url,
    method: opts.method ?? 'GET',
    headers: opts.headers ?? {},
    body: opts.body ?? undefined,
  });

  let response: Response;
  try {
    response = await fetch(`${proxy}/egress`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-proxy-token': token,
      },
      body: egressBody,
    });
  } catch (err) {
    throw new ProxyUnreachableError(proxy, err);
  }

  if (response.status === 403) {
    // Extract host from URL for the error message
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      // keep raw url as host hint
    }
    throw new EgressDeniedError(host);
  }

  return response;
}

// ── Non-sandbox (direct) path ─────────────────────────────────────────────────

async function directFetch(url: string, opts: EgressOptions): Promise<Response> {
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: opts.headers ?? {},
  };

  if (opts.body !== undefined && init.method !== 'GET' && init.method !== 'HEAD') {
    init.body = opts.body;
  }

  // In non-sandbox mode, network errors propagate as-is (skill carries its own infra).
  return fetch(url, init);
}
