# create-privos-mcp-app

CLI scaffolder for [PrivOS](https://privos.io) MCP app projects. Generates a ready-to-run Express + React + TypeScript app with MCP protocol support.

Version `0.3.0` adds the canonical Marketplace `privos-app.json`, production
runtime-v3 dispatch verification, a production Dockerfile, NodeNext ESM server
output and graceful container shutdown.

## Usage

```bash
npx create-privos-mcp-app my-app
cd my-app
npm install
npm run dev
```

## What Gets Generated

```
my-app/
├── privos-app.json         # Marketplace/runtime manifest, schema version 1
├── Dockerfile              # Marketplace source-build entry point
├── package.json            # @privos_ai SDKs, Express, React, Vite, TypeScript
├── tsconfig.server.json    # Production server build
├── vite.config.ts          # UI build config
└── src/
    ├── server.ts           # MCP server (manifest + JSON-RPC + UI serving)
    └── ui/
        ├── App.tsx         # PrivosAppProvider wrapper
        └── main.tsx        # React entry point
```

## Generated Server

The Express server handles:

| Route | Purpose |
|-------|---------|
| `GET /.well-known/mcp/manifest.json` | Exact reviewed `privos-app.json` |
| `POST /mcp` | JSON-RPC 2.0: `initialize`, `tools/list`, `resources/read` |
| UI serving | Vite dev server (dev) or static files (prod) |

## Generated UI

Uses `@privos_ai/app-react` hooks:

```tsx
import { PrivosAppProvider, usePrivosContext, useLists } from '@privos_ai/app-react';
```

The generated backend uses `@privos_ai/app-server`.

## Production runtime boundary

The generated server refuses to start in production until
`PRIVOS_RUNTIME_SECURITY_MODE` is set:

- `managed-v2` requires the managed workload broker and legacy Cluster dispatch
  assertion;
- `runtime-v3` requires `PRIVOS_RUNTIME_DISPATCH_TRUST_V3`, parsed as the strict
  `{hubKid,hubPublicJwk,affinity}` configuration accepted by
  `parseRuntimeDispatchTrustV3Json`.

Set `PRIVOS_RUNTIME_ALLOW_UNSIGNED_PREACTIVATION_READINESS=true` only for a
Hub-supervised local runtime. It does not permit executable or data-bearing
methods, and Relay ignores it. Publisher readiness never uses this exception.

For `runtime-v3`, provisioning must supply the pinned Hub key and stable
pre-start affinity (workspace, deployment, app, execution mode, generation,
runtime installation, manifest digest, and resource-manifest hash). The server
never learns trust from an inbound assertion. Local runtime configuration uses
bounded process-local replay protection. Publisher configuration uses the
durable single-process file store described below.

For publisher-hosted mode, replace the placeholder
`runtimeTrustProvisioningUrl` in `privos-app.json` with the canonical public
HTTPS endpoint reviewed by Marketplace, then set:

```dotenv
PRIVOS_RUNTIME_SECURITY_MODE=runtime-v3
PRIVOS_PUBLISHER_RUNTIME_TRUST_STORE_PATH=/var/lib/my-app/privos-runtime-trust.json
PRIVOS_PUBLISHER_SINGLE_PROCESS=true
PRIVOS_PORTAL_ISSUER=portal:marketplace-broker
PRIVOS_PORTAL_JWKS_URL=https://portal.privos.io/approval-jwks
```

The generated server mounts the trust endpoint before its JSON parser, verifies
the Portal chain and Hub proof, persists atomic `PREPARED`/`ACTIVE` state, and
uses the durable record as its dispatch trust resolver and replay store. The
reference file store fails closed unless single-process mode is explicitly
selected. Multiple processes or replicas require a shared transactional
`PublisherRuntimeTrustDurableStoreV3` implementation.

## Publish to PrivOS Marketplace

Keep `privos-app.json` and `Dockerfile` at the project root. Package the project
so both files are at the ZIP root, not inside an enclosing directory. The
Marketplace reads the package version, app identity, scopes, tools, resource
request, state model and license tiers from this manifest and validates it
server-side.

## Register in Privos

1. Start the app: `npm run dev`
2. In PrivOS Admin → Apps → Connect App
3. Enter server URL (e.g., `http://localhost:3001`)
4. Review and add the app to the Hub App Library
5. Open a room and choose **Add to this room** when room access is wanted

## Documentation

- [Developer Guide](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mcp-app-platform/developer-guide.md)
- [API Reference](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mcp-app-platform/api-reference.md)
- [Demo App](https://github.com/PrivOS-AI/privos-demo-hrm)

## License

MIT
