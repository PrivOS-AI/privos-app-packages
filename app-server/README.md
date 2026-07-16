# @privos/app-server

Business-agnostic PrivOS MCP App server runtime for **Direct HTTP** and **Relay WebSocket**.

## Install

```bash
npm install @privos/app-server
# peer: express
```

## Quick start (Direct router only)

```ts
import express from 'express';
import { createDirectRouter } from '@privos/app-server';

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
} from '@privos/app-server';

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
import { verifyPrivosUser } from '@privos/app-server/auth';
```

## Scripts

- `npm run build` — emit `dist/` (JS + `.d.ts`)
- `npm test` — Vitest (in-process mock Hub only)
- `npm run typecheck`
- `npm pack` — runs `prepack` build; package contains `dist/` only
- `npx tsx scripts/probe-relay-contract.ts` — staging Phase 0 probe (requires credentials; exit 2 when blocked)

## License

MIT
