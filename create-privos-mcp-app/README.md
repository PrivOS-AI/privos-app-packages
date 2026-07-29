# create-privos-mcp-app

CLI scaffolder for [Privos](https://privos.ai) MCP app projects. Generates a ready-to-run Express + React + TypeScript app with MCP protocol support.

Version `0.2.0` adds the canonical Marketplace `privos-app.json`, a production
Dockerfile, NodeNext ESM server output and graceful container shutdown.

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

## Publish to PrivOS Marketplace

Keep `privos-app.json` and `Dockerfile` at the project root. Package the project
so both files are at the ZIP root, not inside an enclosing directory. The
Marketplace reads the package version, app identity, scopes, tools, resource
request, state model and license tiers from this manifest and validates it
server-side.

## Register in Privos

1. Start the app: `npm run dev`
2. In Privos Admin → Apps → Connect App
3. Enter server URL (e.g., `http://localhost:3001`)
4. Install in a room — app appears as a room tab

## Documentation

- [Developer Guide](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mcp-app-platform/developer-guide.md)
- [API Reference](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mcp-app-platform/api-reference.md)
- [Demo App](https://github.com/PrivOS-AI/privos-demo-hrm)

## License

MIT
