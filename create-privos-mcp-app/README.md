# create-privos-mcp-app

CLI scaffolder for [Privos](https://privos.ai) MCP app projects. Generates a ready-to-run Express + React + TypeScript app with MCP protocol support.

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
├── package.json            # Express, React, Vite, TypeScript
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
| `GET /.well-known/mcp/manifest.json` | App metadata |
| `POST /mcp` | JSON-RPC 2.0: `initialize`, `tools/list`, `resources/read` |
| UI serving | Vite dev server (dev) or static files (prod) |

## Generated UI

Uses `@privos/app-react` hooks:

```tsx
import { PrivosAppProvider, usePrivosContext, useLists } from '@privos/app-react';
```

## Register in Privos

1. Start the app: `npm run dev`
2. In Privos Admin → Apps → Connect App
3. Enter server URL (e.g., `http://localhost:3001`)
4. Install in a room — app appears as a room tab

## Documentation

- [Developer Guide](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mini-app-platform/developer-guide.md)
- [API Reference](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mini-app-platform/api-reference.md)
- [Demo App](https://github.com/PrivOS-AI/privos-demo-hrm)

## License

MIT
