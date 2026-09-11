/**
 * index.ts — Public API surface for @privos_ai/skill-sdk.
 *
 * Skills import from this package:
 *   import { hub, external, env } from '@privos_ai/skill-sdk';
 *   import { EgressDeniedError, ProxyUnreachableError, UpstreamError } from '@privos_ai/skill-sdk';
 */

// High-level clients
export { hub } from './hub-client.js';
export type { SseMessage } from './hub-client.js';
export { external } from './external-client.js';
export type { ExternalFetchOptions } from './external-client.js';

// Typed env whitelist
export { env } from './env.js';

// Low-level egress (for advanced skill use)
export { egressFetch } from './proxy-client.js';
export type { EgressOptions } from './proxy-client.js';

// Error classes
export { EgressDeniedError, ProxyUnreachableError, UpstreamError } from './errors.js';

// Mode helpers (for skills that need runtime mode inspection)
export { isSandboxMode, proxyUrl, hubHost, privosUrl } from './mode.js';
