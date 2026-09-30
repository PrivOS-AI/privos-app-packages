/**
 * `npm run dev`: previews this INSTANT app in a workspace over Relay.
 *
 * It runs `serveApp` with the UI served live from a Vite dev server, and with
 * the relay manifest (`privos-app.json` plus one UI-only tool per entry point,
 * built in memory, see relay-manifest.ts). Pair the app once with
 * `npm run pair` first. Without a pairing it starts in loopback development
 * mode, where nothing can reach it from a workspace, and says so.
 *
 * Development only. A published INSTANT app is the UI bundle and
 * `privos-app.json`; this server is not part of it.
 */
import { serveApp } from '@privos_ai/app-server';

import { devUiHtml, startDevUi } from './dev-ui.js';
import { buildDescriptor, buildRelayManifest, handleRelayRequest, loadManifest, relayUiUri } from './relay-manifest.js';

// `npm run dev` is development whatever the shell exports: a NODE_ENV=production
// left over in the environment would otherwise switch the SDK to its production rules.
process.env.NODE_ENV = 'development';

function listenPort(): number {
  const port = Number(process.env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT is not a valid port number: ${process.env.PORT}`);
  }
  return port;
}

async function main(): Promise<void> {
  const relayManifest = () => buildRelayManifest(loadManifest());
  const initial = relayManifest();

  const devUi = await startDevUi();
  const handle = await serveApp({
    descriptor: buildDescriptor(initial),
    ui: { uri: relayUiUri(initial), renderHtml: () => devUiHtml(devUi.origin, initial.title) },
    createHandler: () => handleRelayRequest,
    port: listenPort(),
    // Fresh on every check, so a real edit of privos-app.json shows up as drift in /ready.
    resolveManifest: relayManifest,
    configure: (app) => {
      app.get('/.well-known/mcp/manifest.json', (_req, res) => res.json(relayManifest()));
    },
  });

  console.log(`Live UI from ${devUi.origin}; the browser that shows the workspace must reach that address (PRIVOS_DEV_UI_ORIGIN overrides it).`);
  if (handle.mode === 'development') {
    console.log('No identity file: running in loopback development mode, which no workspace can reach.');
    console.log('To preview this app in a workspace, pair it once: npm run pair');
  }
}

main().catch((error) => {
  console.error('Failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
