/**
 * external-client.ts — Egress wrapper for non-hub external URLs.
 *
 * In sandbox mode:  routes through proxy /egress (proxy injects catalog credentials).
 * In non-sandbox:   direct fetch (skill carries its own auth in opts.headers).
 *
 * Skills should use this for third-party APIs (GitHub, Stripe, Slack, etc.).
 * Hub calls should use hub-client instead.
 */
import { egressFetch, type EgressOptions } from './proxy-client.js';

export interface ExternalFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Request body as string. JSON must be serialized by caller. */
  body?: string;
}

export const external = {
  /**
   * Fetch any external URL via the configured egress path.
   *
   * Sandbox:     POST to proxy /egress — proxy validates catalog + injects creds.
   * Non-sandbox: direct fetch — skill must supply auth headers if required.
   *
   * Returns raw Response. Throws ProxyUnreachableError or EgressDeniedError on
   * proxy-level failures. Upstream HTTP errors (>= 400) are returned as Response.
   */
  async fetch(url: string, opts: ExternalFetchOptions = {}): Promise<Response> {
    const egressOpts: EgressOptions = {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
    };
    return egressFetch(url, egressOpts);
  },
};
