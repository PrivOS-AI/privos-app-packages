# @privos/app-react

React hooks for building apps on the [Privos](https://privos.ai) platform. Thin wrapper around MCP Apps protocol PostMessage transport.

## Install

```bash
npm install @privos/app-react
```

## Usage

```tsx
import { PrivosAppProvider, usePrivosContext, useLists, usePrivosApp } from '@privos/app-react';

function MyApp() {
  const { roomId, userId, theme } = usePrivosContext();
  const { data: lists, loading } = useLists(roomId);
  const app = usePrivosApp();

  async function createItem() {
    await app.callServerTool({
      name: 'privos.lists.createItem',
      arguments: { listId: 'abc', title: 'New item' },
    });
  }

  return (
    <div>
      <p>Room: {roomId} | Theme: {theme}</p>
      {loading ? <p>Loading...</p> : lists?.map(l => <div key={l._id}>{l.name}</div>)}
      <button onClick={createItem}>Add Item</button>
    </div>
  );
}

export default function App() {
  return (
    <PrivosAppProvider>
      <MyApp />
    </PrivosAppProvider>
  );
}
```

## Hooks

| Hook | Returns | Description |
|------|---------|-------------|
| `usePrivosApp()` | `McpApp` | MCP app instance for `callServerTool()` |
| `usePrivosContext()` | `PrivosContext` | `{ userId, username, roomId, roomName, theme, userRoles }` |
| `usePrivosTool(name, args)` | `{ data, loading, error, refetch }` | Auto-fetching tool call (for reads) |
| `useLists(roomId)` | `{ data, loading, error }` | Lists in room |
| `useFiles(roomId)` | `{ data, loading, error }` | Files in room |
| `useRoom(roomId?)` | `{ data, loading, error }` | Room metadata |

## Provider

Wrap your app root with `PrivosAppProvider`. It creates a PostMessage-based MCP connection to the Privos host iframe.

```tsx
<PrivosAppProvider>
  <YourApp />
</PrivosAppProvider>
```

## Reads vs Mutations

- **Reads**: Use `usePrivosTool` or convenience hooks — auto-fetches on mount
- **Mutations**: Use `usePrivosApp()` then call `app.callServerTool()` in event handlers

## Theme

`usePrivosContext().theme` returns `'light'` or `'dark'`, updated in real-time when the Privos user toggles theme. See [Theme Integration docs](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mcp-app-platform/developer-guide.md#7-theme-sync-lightdark-mode).

## License

MIT
