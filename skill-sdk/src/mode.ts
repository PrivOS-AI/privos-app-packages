/**
 * mode.ts — Environment detection helpers.
 *
 * Controls whether the SDK routes through the sandbox proxy (/egress)
 * or calls the PrivOS hub directly (non-sandbox mode).
 */

/** Returns true when running inside a sandbox VM (PRIVOS_SANDBOX_MODE=true). */
export function isSandboxMode(): boolean {
  return process.env.PRIVOS_SANDBOX_MODE === 'true';
}

/** Proxy base URL — default suits Docker Compose service name. */
export function proxyUrl(): string {
  return process.env.PROXY_URL || 'http://proxy:8557';
}

/**
 * Proxy token for x-proxy-token header.
 * Throws in sandbox mode when token is absent (misconfigured VM).
 */
export function proxyToken(): string {
  const t = process.env.PROXY_TOKEN;
  if (isSandboxMode() && !t) {
    throw new Error('PROXY_TOKEN required in sandbox mode but is not set');
  }
  return t || '';
}

/** Public hostname of the PrivOS hub (no scheme, no trailing slash). */
export function hubHost(): string {
  return process.env.PRIVOS_HUB_HOST || '';
}

/** PrivOS hub base URL used in non-sandbox mode. */
export function privosUrl(): string {
  return process.env.PRIVOS_URL || '';
}

/** Bot API key used in non-sandbox mode (Authorization: Bearer). */
export function privosBotKey(): string {
  return process.env.PRIVOS_BOT_KEY || '';
}
