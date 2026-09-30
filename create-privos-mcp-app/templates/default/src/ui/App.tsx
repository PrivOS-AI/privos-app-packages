/**
 * Main React app component for the MCP app UI.
 *
 * Scopes the manifest declares as optional (`lists:read`) may not be granted:
 * read them only when `usePrivosCapability` reports the grant, and show a
 * degraded state otherwise. The hook is a presentation helper, the Hub still
 * enforces the scope on every call.
 */
import { PrivosAppProvider, useLists, usePrivosCapability, usePrivosContext } from '@privos_ai/app-react';

interface ListSummary {
  _id: string;
  name: string;
}

function RoomLists({ roomId }: { roomId: string }) {
  const { data: lists, loading, error } = useLists(roomId);

  if (loading) return <p>Loading lists...</p>;
  if (error) return <p>The lists could not be read: {error.message}</p>;
  if (!lists?.length) return <p>No lists in this room.</p>;
  return (
    <ul>
      {(lists as ListSummary[]).map((list) => (
        <li key={list._id}>{list.name}</li>
      ))}
    </ul>
  );
}

function Dashboard() {
  const ctx = usePrivosContext();
  const listsAccess = usePrivosCapability('lists:read');

  return (
    <div style={{ padding: '16px', fontFamily: 'system-ui' }}>
      <h2>{{APP_NAME}}</h2>
      <p>
        Room: {ctx.roomName || 'N/A'} | User: {ctx.username || ctx.userId}
      </p>
      {!listsAccess.resolved && <p>Checking access...</p>}
      {listsAccess.resolved && !listsAccess.granted && (
        <p>This app has no access to the lists of this room, so it cannot show them. Ask a workspace admin to grant "lists:read" in the app settings.</p>
      )}
      {listsAccess.granted && <RoomLists roomId={ctx.roomId} />}
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
