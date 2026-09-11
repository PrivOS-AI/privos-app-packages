/**
 * env.ts — Typed, whitelisted environment variable reader.
 *
 * Exposes only the env vars that skills are allowed to read.
 * In sandbox mode, credentials (PRIVOS_BOT_KEY, PRIVOS_URL) are hidden
 * because the proxy handles auth — skills should never see those values.
 */
import { isSandboxMode, proxyUrl } from './mode.js';

export const env = {
  /** Room/channel ID the skill is running in. */
  get PRIVOS_ROOM_ID(): string {
    return process.env.PRIVOS_ROOM_ID || '';
  },

  /** Bot agent ID. */
  get PRIVOS_BOT_ID(): string {
    return process.env.PRIVOS_BOT_ID || '';
  },

  /** Project ID the skill belongs to. */
  get PRIVOS_PROJECT_ID(): string {
    return process.env.PRIVOS_PROJECT_ID || '';
  },

  /** Public hub hostname (no scheme). Available in both modes. */
  get PRIVOS_HUB_HOST(): string {
    return process.env.PRIVOS_HUB_HOST || '';
  },

  /** Resolved proxy URL (always the effective value, not raw env). */
  get PROXY_URL(): string {
    return proxyUrl();
  },

  /**
   * Bot API key — only available in non-sandbox mode.
   * Returns undefined in sandbox (proxy handles auth; skills must not hold keys).
   */
  get PRIVOS_BOT_KEY(): string | undefined {
    return isSandboxMode() ? undefined : process.env.PRIVOS_BOT_KEY;
  },

  /**
   * PrivOS hub base URL — only available in non-sandbox mode.
   * Returns undefined in sandbox (use PRIVOS_HUB_HOST + hub client instead).
   */
  get PRIVOS_URL(): string | undefined {
    return isSandboxMode() ? undefined : process.env.PRIVOS_URL;
  },
} as const;
