# Privos App Packages

Packages for building apps on the [Privos](https://privos.ai) platform.

## Packages

| Package | Description |
|---------|-------------|
| [`@privos/app-react`](./app-react/) | React hooks for Privos MCP apps — `usePrivosContext`, `usePrivosTool`, `useLists`, etc. |
| [`create-privos-mcp-app`](./create-privos-mcp-app/) | CLI scaffolder — `npx create-privos-mcp-app my-app` |

## Quick Start

```bash
# Scaffold a new app
npx create-privos-mcp-app my-app
cd my-app && npm install && npm run dev
```

## What Is a Privos App?

A standalone MCP server (Express + React) that integrates with Privos Chat rooms:

- Serves MCP manifest at `/.well-known/mcp/manifest.json`
- Handles JSON-RPC on `/mcp` (initialize, tools/list, resources/read)
- Renders React UI in Privos room tabs via sandboxed iframe
- Calls Privos tools (lists, files, messages) via PostMessage bridge
- Syncs theme (light/dark) with Privos host in real-time

## Documentation

- [App Platform Overview](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mini-app-platform/overview.md)
- [Developer Guide](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mini-app-platform/developer-guide.md)
- [API Reference](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mini-app-platform/api-reference.md)
- [React SDK Reference](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mini-app-platform/react-sdk-reference.md)

## Demo App

See [privos-demo-hrm](https://github.com/PrivOS-AI/privos-demo-hrm) for a working example.

## License

MIT
