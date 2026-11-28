/**
 * Main React app component for the MCP app UI. It follows three habits that keep
 * an app fast; the platform guide "Building fast apps" explains them:
 *
 * 1. Read List data in the browser. `app.rest` goes from this frame through the
 *    host to the Hub as the signed-in user; the app server is not involved, so a
 *    read costs one Hub round trip. Keep server tools for work that needs a
 *    secret, a business rule or data the user may not read.
 * 2. Draw the screen first. Access checks and refreshes run in the background;
 *    whatever the user must know or decide opens a dialog over the screen.
 * 3. Offline first. Show the copy this browser saved last, then refresh it.
 *
 * Scopes the manifest declares as optional (`lists:read`, `lists:query`) may not
 * be granted: read them only when `usePrivosCapability` reports the grant. The
 * hook is a presentation helper; the Hub still enforces the scope on every call.
 */
import { useEffect, useState } from 'react';
import {
  PrivosAppProvider,
  usePrivosApp,
  usePrivosCapability,
  usePrivosContext,
  type McpApp,
  type RestRequestParams,
} from '@privos_ai/app-react';

import { NoticeDialog, type Notice } from './notice-dialog';
import { cacheKey, clearCache, useCachedRead } from './offline-cache';

interface ListSummary {
  _id: string;
  name: string;
}

interface ItemSummary {
  _id: string;
  name: string;
}

/** A Hub REST read as the signed-in user. A path the app's scopes do not cover is refused. */
async function hubRead<T>(app: McpApp, request: RestRequestParams): Promise<T> {
  const response = await app.rest(request);
  if (response.statusCode >= 400) throw new Error(`The workspace answered ${response.statusCode}.`);
  return response.body as T;
}

function savedLabel(savedAt?: string): string {
  return savedAt ? `Updated ${new Date(savedAt).toLocaleTimeString()}` : '';
}

function ListItems({ list, userId, roomId, onNotice }: { list: ListSummary; userId: string; roomId: string; onNotice(notice: Notice): void }) {
  const app = usePrivosApp();
  const itemsAccess = usePrivosCapability('lists:query');
  const denied = itemsAccess.resolved && !itemsAccess.granted;
  const items = useCachedRead<ItemSummary[]>(
    app.storage,
    denied ? undefined : cacheKey(userId, roomId, `items:${list._id}`),
    async () => {
      const body = await hubRead<{ items?: ItemSummary[] }>(app, {
        method: 'POST',
        path: 'items.query',
        body: { listId: list._id, count: 20, fields: ['name'] },
      });
      // Keep only what the screen shows: this copy is stored in the browser.
      return (body.items ?? []).map(({ _id, name }) => ({ _id, name }));
    },
    itemsAccess.granted,
  );

  useEffect(() => {
    if (denied) {
      onNotice({
        title: 'Items are not available',
        message: 'This app may not read list items in this room. A workspace admin can grant "lists:query" in the app settings.',
      });
    }
  }, [denied]);

  useEffect(() => {
    if (items.error) {
      onNotice({
        title: `"${list.name}" could not be refreshed`,
        message: items.data ? 'You are looking at the copy saved earlier.' : items.error.message,
        actionLabel: 'Retry',
        onAction: items.refresh,
      });
    }
  }, [items.error]);

  if (denied) return <p>Items are hidden: this app has no access to them.</p>;
  if (!items.data) return <p>{items.refreshing ? 'Loading items...' : ''}</p>;
  if (!items.data.length) return <p>No items in this list.</p>;
  return (
    <>
      <ul>
        {items.data.map((item) => (
          <li key={item._id}>{item.name}</li>
        ))}
      </ul>
      <small>{items.refreshing ? 'Updating...' : savedLabel(items.savedAt)}</small>
    </>
  );
}

function Dashboard() {
  const app = usePrivosApp();
  const ctx = usePrivosContext();
  const listsAccess = usePrivosCapability('lists:read');
  const [notice, setNotice] = useState<Notice>();
  const [selected, setSelected] = useState<ListSummary>();

  const ready = Boolean(ctx.userId && ctx.roomId);
  const denied = listsAccess.resolved && !listsAccess.granted;
  const listsKey = ready ? cacheKey(ctx.userId, ctx.roomId, 'lists') : undefined;
  const lists = useCachedRead<ListSummary[]>(
    app.storage,
    denied ? undefined : listsKey,
    async () => {
      const body = await hubRead<{ lists?: ListSummary[] }>(app, { method: 'GET', path: 'lists.listByRoomId', query: { roomId: ctx.roomId } });
      return (body.lists ?? []).map(({ _id, name }) => ({ _id, name }));
    },
    listsAccess.granted,
  );

  // The access check finishes after the screen is drawn. A revoked grant also drops the saved copy.
  useEffect(() => {
    if (!denied || !listsKey) return;
    void clearCache(app.storage, listsKey);
    setNotice({
      title: 'Lists are not available',
      message: 'This app may not read the lists of this room. A workspace admin can grant "lists:read" in the app settings.',
    });
  }, [denied, listsKey]);

  useEffect(() => {
    if (lists.error) {
      setNotice({
        title: 'The lists could not be refreshed',
        message: lists.data ? 'You are looking at the copy saved earlier.' : lists.error.message,
        actionLabel: 'Retry',
        onAction: lists.refresh,
      });
    }
  }, [lists.error]);

  return (
    <div style={{ padding: '16px', fontFamily: 'system-ui' }}>
      <h2>{{APP_NAME}}</h2>
      <p>
        Room: {ctx.roomName || '...'} | User: {ctx.username || ctx.userId || '...'}
      </p>
      <h3>Lists</h3>
      {denied && <p>Lists are hidden: this app has no access to them.</p>}
      {!denied && !lists.data && <p>{lists.refreshing ? 'Loading lists...' : ''}</p>}
      {lists.data?.length === 0 && <p>No lists in this room.</p>}
      {!!lists.data?.length && (
        <ul>
          {lists.data.map((list) => (
            <li key={list._id}>
              <button type="button" onClick={() => setSelected(list)} aria-pressed={selected?._id === list._id}>
                {list.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {lists.data && <small>{lists.refreshing ? 'Updating...' : savedLabel(lists.savedAt)}</small>}
      {selected && ready && (
        <>
          <h3>{selected.name}</h3>
          <ListItems key={selected._id} list={selected} userId={ctx.userId} roomId={ctx.roomId} onNotice={setNotice} />
        </>
      )}
      <NoticeDialog notice={notice} onClose={() => setNotice(undefined)} />
    </div>
  );
}

export default function App() {
  return (
    <PrivosAppProvider>
      <Dashboard />
    </PrivosAppProvider>
  );
}
