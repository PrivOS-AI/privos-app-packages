/**
 * MCP app server — serves manifest, handles MCP JSON-RPC calls, and serves UI.
 */
import express from 'express';
import path from 'path';

const app = express();
app.use(express.json());

// Serve MCP manifest (metadata only)
app.get('/.well-known/mcp/manifest.json', (_req, res) => {
  res.json({
    name: '{{APP_ID}}',
    version: '1.0.0',
    title: '{{APP_NAME}}',
    description: 'A Privos MCP mini app',
    author: 'Developer',
  });
});

// MCP JSON-RPC endpoint
let requestId = 0;
app.post('/mcp', (req, res) => {
  const { method, id, params } = req.body;

  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: {
          tools: {},
          extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
        },
        serverInfo: { name: '{{APP_NAME}}', version: '1.0.0' },
      },
    });
  }

  if (method === 'notifications/initialized') {
    return res.status(202).end();
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        tools: [{
          name: '{{APP_NAME}}_dashboard',
          title: '{{APP_NAME}} Dashboard',
          description: 'Main dashboard view',
          inputSchema: { type: 'object', properties: { roomId: { type: 'string' } } },
          _meta: { ui: { resourceUri: 'ui://{{APP_NAME}}/dashboard.html' } },
        }],
      },
    });
  }

  if (method === 'resources/read') {
    const html = `<!DOCTYPE html>
<html><head><title>{{APP_NAME}}</title></head>
<body><div id="root"></div>
<script type="module" src="http://localhost:5173/src/ui/main.tsx"></script>
</body></html>`;
    return res.json({
      jsonrpc: '2.0', id,
      result: { contents: [{ uri: params?.uri, mimeType: 'text/html;profile=mcp-app', text: html }] },
    });
  }

  res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`MCP server running on http://localhost:${PORT}`));
