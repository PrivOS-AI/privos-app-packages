# create-privos-mcp-app

CLI scaffolder for [PrivOS](https://privos.io) MCP app projects. Generates a ready-to-run Express + React + TypeScript app with MCP protocol support.

Version `0.3.0` adds the canonical Marketplace `privos-app.json`, production
runtime-v3 dispatch verification, a production Dockerfile, NodeNext ESM server
output and graceful container shutdown.

Version `0.5.0` fixes production UIs rendering blank: the generated server now
serves the built UI through `@privos_ai/app-server`'s `serveBuiltUi` helper
instead of returning the raw Vite `index.html`. See
[Production UI: assets served by the Hub](#production-ui-assets-served-by-the-hub)
below — apps scaffolded from `0.4.0` or earlier keep the bug until upgraded.

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
        ├── App.tsx            # PrivosAppProvider wrapper
        ├── main.tsx           # React entry point; sets the boot flag the shell's watchdog waits for
        └── lazy-boundary.tsx  # Error boundary for React.lazy panels — "Reload" on a stale chunk
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

## Production UI: assets served by the Hub

`npm run build` produces `dist/index.html` (the shell) plus content-hashed
files under `dist/assets/` (Vite `base: './'`, `build.manifest: true`,
`sourcemap: false`; no `publicDir` — everything the UI needs must ship as a
hashed `assets/` file). The generated server never serves `dist/assets`
itself: at production boot it constructs `serveBuiltUi({ distDir, appSlug })`
once, and that instance answers `resources/read` for both the shell
(`ui://<app>/dashboard.html`) and each asset (`ui://<app>/assets/<file>`) —
the Hub fetches assets over the same MCP transport as the shell, caches them,
and re-serves them from its own origin behind a short-lived per-user token so
the `about:srcdoc` frame can load them cross-origin. This requires a Hub that
understands the `<meta name="privos-ui-assets" content="relay">` opt-in the
shell carries and the asset-relay route — **requires Hub ≥ tenant.N**. On an
older Hub the shell's inline boot watchdog shows a "Retry" panel after
10 seconds instead of rendering blank.

`serveBuiltUi` validates the build at construction and throws (crashing the
process at boot, not on the first request) if:

- any `<script>`/`<link>` tag in `index.html` is not `./assets/…` or
  `assets/…` (the app was built without `base: './'`);
- a file under `dist/assets` does not match the content-hashed filename rule
  `name-<hash>.ext` (hash ≥ 8 chars) with an allowed extension (`js`, `css`,
  `svg`, `json`, `woff`, `woff2`, `ttf`, `png`, `jpg`, `jpeg`, `gif`, `webp`,
  `avif`, `ico`, `wasm`, `gz`);
- a `.map` file is present under `dist/assets` (sourcemaps must never be
  published — the build already disables them);
- an asset exceeds 2 MB.

Files that don't match the filename rule or aren't listed in the build's
assets manifest are never served, even if they exist on disk.

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

## Changing privos-app.json after pairing

Edit `privos-app.json` and restart — the server sets `manifest` on the
descriptor it passes to `connectRelay` (`src/server.ts:222`), so app-server
echoes the loaded manifest and the Hub's Refresh detects the change. Re-pairing
a live app is refused; use Hub Admin → Apps → your app → Settings → Refresh
to review and approve the update instead.

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
