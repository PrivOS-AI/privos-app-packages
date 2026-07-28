/**
 * Main React app component for the MCP app UI.
 */
import { PrivosAppProvider, usePrivosContext, useLists } from '@privos_ai/app-react';

function Dashboard() {
  const ctx = usePrivosContext();
  const { data: lists, loading } = useLists(ctx.roomId);

  return (
    <div style={{ padding: '16px', fontFamily: 'system-ui' }}>
      <h2>{{APP_NAME}}</h2>
      <p>Room: {ctx.roomName || 'N/A'} | User: {ctx.username || ctx.userId}</p>
      {loading && <p>Loading lists...</p>}
      {lists && (
        <ul>
          {lists.map((list: any) => (
            <li key={list._id}>{list.name}</li>
          ))}
        </ul>
      )}
      {lists?.length === 0 && <p>No lists in this room.</p>}
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
