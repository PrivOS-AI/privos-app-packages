# @privos_ai/app-react

React hooks for building apps on the [Privos](https://privos.ai) platform. Thin wrapper around MCP Apps protocol PostMessage transport.

## Install

```bash
npm install @privos_ai/app-react
```

## Usage

```tsx
import { PrivosAppProvider, usePrivosContext, useLists, usePrivosApp } from '@privos_ai/app-react';

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
| `usePrivosContext()` | `PrivosContext` | Non-secret user/room/theme display context fetched through `mcpapp.context.get` and merged with `HOST_CONTEXT_CHANGED` |
| `usePrivosCapability(scope)` | `{ resolved, granted, scope }` | Presentation helper for deterministic optional-feature degradation; Hub still authorizes every call |
| `usePrivosTool(name, args)` | `{ data, loading, error, refetch }` | Auto-fetching tool call (for reads) |
| `useLists(roomId)` | `{ data, loading, error }` | Lists in room |
| `useFiles(roomId)` | `{ data, loading, error }` | Files in room |
| `useRoom(roomId?)` | `{ data, loading, error }` | Room metadata |
| `useAppChatSurface(opts)` | `{ supported, isOpen, open, close }` | Render your own AI chat window instead of the hub's |

## Owning the AI chat surface

By default the hub renders its own AI chat and your app can only steer it. If your app ships
its own chat design, `useAppChatSurface` claims the surface: clicking the hub's floating
launcher then opens *your* chat window and the launcher hides until you close it.

```tsx
const { resolved, supported, close } = useAppChatSurface({
  onOpen: () => setChatVisible(true),
  onClose: () => setChatVisible(false),
});

// Wire your minimize button to close() so the hub launcher comes back.
<button onClick={close}>Minimize</button>

// `supported` is false where the host has no launcher to hand over (standalone /app/:appId
// page, sidebar panel) — render your own entry point there. Wait for `resolved`: before the
// host answers, `supported` is still false and you would paint a second launcher next to the
// hub's own. Call open() too, so the host knows to hide its launcher if it has one.
{resolved && !supported && (
  <button onClick={() => { setChatVisible(true); open(); }}>Ask AI</button>
)}
```

Rules worth knowing:

- **Per mount.** Ownership is dropped on iframe reload, tab switch, and unmount. Nothing is
  persisted and no manifest field is involved. The hook re-claims automatically when the host
  reinitializes the iframe, so you do not have to handle the reload case yourself.
- **Acknowledge quickly.** The host waits ~1.5s after `ui/chat.open` for the app to confirm.
  The hook acks for you; if you drive the bridge by hand, call `setChatOpen(true)` promptly or
  the host takes the surface back, restores its own launcher, and sends you
  `ui/chat.close { reason: 'timeout' }`.
- **Wire your minimize button to `close()`** so the hub launcher reappears.
- **One consumer per app.** The underlying handlers are single-slot: mounting `useAppChatSurface`
  twice means the second instance wins and unmounting it withdraws ownership for both.
- The AI backend is unchanged — your chat window still reaches the hub AI through the bridge.

## User-delegated identity

The iframe receives display context, not a bearer or user token. Calls made through
`app.rest()`, `uploadFile()`, and `callServerTool()` remain mediated by Hub, which
intersects the installation grant with the current user's native ACL.

When Hub privately dispatches a backend tool call, it places the verified actor in
the short-lived, body-bound Hub dispatch assertion. The app-server workload SDK
validates that assertion before application code runs. A workload token is an app
principal and can never be converted into a user identity.

Do not accept `userId` from iframe request bodies as authorization evidence and do
not ask the browser to forward Hub credentials to an app backend.

### Helpers (also exported)

| Export | Use |
|--------|-----|
| `parseToolResult` | Parse MCP tool / host-bridge payloads (`isError`, `content[0].text`, nested `result`) |

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
