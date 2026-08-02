# @privos_ai/app-server

Business-agnostic PrivOS MCP App server runtime for **Direct HTTP** and **Relay WebSocket**.

## Install

```bash
npm install @privos_ai/app-server
# peer: express
```

## Quick start (Direct router only)

```ts
import express from 'express';
import { createDirectRouter } from '@privos_ai/app-server';

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(
  createDirectRouter({
    descriptor: { id: 'com.example.app', name: 'Example', version: '1.0.0' },
    handler: async (request) => {
      if (request.method === 'tools/list') return { tools: [] };
      throw Object.assign(new Error('Method not found'), { code: -32601 });
    },
  }),
);
```

## Quick start (HTTP ingress helper)

For Relay+HTTP dual mode or a minimal Direct binary — health/ready/listen included:

```ts
import {
  startHttpIngress,
  resolveHttpIngressListen,
  connectRelay,
} from '@privos_ai/app-server';

const listen = resolveHttpIngressListen({ defaultPort: 8080 });
const shared = {
  descriptor: { id: 'com.example.app', name: 'Example', version: '1.0.0' },
  handler: async (request) => {
    if (request.method === 'tools/list') return { tools: [] };
    throw Object.assign(new Error('Method not found'), { code: -32601 });
  },
};

if (listen.enabled) {
  await startHttpIngress({
    ...shared,
    port: listen.port,
    publicUrl: listen.publicUrl,
    ready: {
      check: async () => ({ ok: true, body: { /* app checks */ } }),
    },
    // Optional: mount /ui, static assets, webhooks before listen
    configure: async (app) => {
      // app.use('/ui', …)
    },
  });
}

connectRelay({ ...shared, privosUrl, clientId, clientSecret });
```

Env: `HTTP_INGRESS`, `HTTP_PORT` / `PORT`, `PUBLIC_URL`.

Runtime owns `initialize`, `notifications/*`, and the configured primary UI resource.  
Your handler owns `tools/list`, `tools/call`, and custom resources.

## Auth

```ts
import { verifyPrivosUser } from '@privos_ai/app-server/auth';
```

## Secretless workload identity

Production Cluster installs mount a per-installation Unix socket. The runtime creates an
ephemeral P-256 DPoP key in memory, attests through that socket, and refreshes a short-lived,
sender-constrained token without writing credentials to disk or environment variables.

```ts
import { getWorkloadIdentityClient } from '@privos_ai/app-server/workload';

const identity = getWorkloadIdentityClient();
const capabilities = await identity.getEffectiveCapabilities();
const stop = identity.onCapabilitiesChanged((next) => {
  // Disable optional features when next.scopes no longer contains their scope.
});

identity.requireCapability('basic:information');
const response = await identity.authorizedRequest('/api/v1/mcp-apps.context', {
  requiredScope: 'basic:information',
});
```

`authorizedFetch` only sends authorization to the Hub origin supplied by the broker. It retries
one 401 automatically only for safe/idempotent methods; POST/PATCH require an explicit
`retryMode: 'idempotent'`. `authorizedRequest` maps 403 to `WorkloadPermissionDeniedError` so
optional-feature degradation is stable. Do not convert a workload token into a user identity;
user-delegated operations stay in the iframe host bridge.

Direct production ingress should use `workloadSecurity: 'required'`; this validates the
Hub-signed, body-bound dispatch assertion before `/mcp` reaches application code. Relay pairing
and client credentials remain an explicit development compatibility mode only.

## Manifest v2 preflight

```bash
npx privos-app-lint ./privos-app.json
```

The command rejects mixed legacy/v2 permission declarations and prints deterministic
`canonicalManifestHash` and `publisherPermissionDeclarationHash` values. The latter covers the
publisher declaration only; Hub/Portal compute the authoritative permission contract hash with
the versioned server-owned catalog and immutable image digest.

## Scripts

- `npm run build` — emit `dist/` (JS + `.d.ts`)
- `npm test` — Vitest (in-process mock Hub only)
- `npm run typecheck`
- `npm pack` — runs `prepack` build; package contains `dist/` only
- `npx tsx scripts/probe-relay-contract.ts` — staging Phase 0 probe (requires credentials; exit 2 when blocked)

## License

MIT
