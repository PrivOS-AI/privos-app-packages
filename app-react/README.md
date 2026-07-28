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
| `usePrivosContext()` | `PrivosContext` | `{ userId, username, roomId, roomName, theme, userRoles, userToken?, userTokenGeneration, refreshUserToken }` — fetches `mcpapp.context.get`, merges `HOST_CONTEXT_CHANGED`, and proactively refreshes short-lived Hub JWTs before `exp` |
| `usePrivosUserToken()` | `string \| undefined` | Signed identity JWT for forwarding to your backend |
| `useUserTokenRefreshEffects(opts)` | `void` | Advanced: exp-timer + visibility/focus triggers for custom HOST context providers (do not combine with `usePrivosContext` in the same iframe) |
| `usePrivosTool(name, args)` | `{ data, loading, error, refetch }` | Auto-fetching tool call (for reads) |
| `useLists(roomId)` | `{ data, loading, error }` | Lists in room |
| `useFiles(roomId)` | `{ data, loading, error }` | Files in room |
| `useRoom(roomId?)` | `{ data, loading, error }` | Room metadata |

## User Identity (Verified)

The hub delivers a signed RS256 JWT to the app iframe on every context update. This token lets your app's **own backend** cryptographically verify which user triggered a request — without trusting any client-supplied value.

### Frontend: forward the token

```tsx
import { usePrivosUserToken } from '@privos_ai/app-react';

function MyComponent() {
  const token = usePrivosUserToken();

  async function fetchMyData() {
    // Forward the hub-signed token; backend verifies it before trusting userId
    const res = await fetch('/api/my-data', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.json();
  }

  // ...
}
```

### Backend: verify before trusting

Use the `verifyPrivosUser` helper generated in your app's `server.ts` (powered by `jose`):

```ts
import { verifyPrivosUser } from './server'; // generated helper

app.get('/api/my-data', async (req, res) => {
  const user = await verifyPrivosUser(req.headers.authorization);
  // user.userId is now cryptographically verified — safe to use for authz
  res.json({ data: await getDataForUser(user.userId) });
});
```

Or use the generated `requirePrivosUser` Express middleware:

```ts
app.get('/api/my-data', requirePrivosUser, (req, res) => {
  res.json({ data: await getDataForUser(req.privosUser!.userId) });
});
```

**Without backend verification, never trust a userId from the request body or query string — those values are client-controlled and forgeable.**

### Token properties

| Claim | Value |
|-------|-------|
| `sub` | Stable opaque userId — use as your user key |
| `preferred_username` | Human-readable username — display only |
| `aud` | This app's `appId` — token is bound to one app, cannot be replayed elsewhere |
| `rid` | RoomId (optional, present when app is in a room tab) |
| `exp` | ~5 minutes from issue — short window limits replay risk |
| `iss` | Hub base URL |

Tokens are re-issued on `HOST_CONTEXT_CHANGED` and also proactively re-fetched via `mcpapp.context.get` shortly before JWT `exp` (and when the tab becomes visible again). Use `refreshUserToken()` / `userTokenGeneration` from `usePrivosContext()` if your UI needs to recover from `IDENTITY_INVALID` or clear identity banners after a fresher token lands.

The hub publishes its public keys at `<hubBaseUrl>/.well-known/mcp-apps/jwks.json`; `jose` caches and rotates them automatically.

### Helpers (also exported)

| Export | Use |
|--------|-----|
| `parseToolResult` | Parse MCP tool / host-bridge payloads (`isError`, `content[0].text`, nested `result`) |
| `isFresherUserToken` / `msUntilUserTokenRefresh` / … | Client-side JWT `exp` scheduling (not verification) |
| `isIdentityTokenErrorMessage` / `toolResultLooksIdentityInvalid` | Detect identity-invalid tool errors for retry / banners |

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
