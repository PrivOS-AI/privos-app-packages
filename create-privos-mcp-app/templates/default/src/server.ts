/**
 * Entry point for every way this app runs: `npm run dev`, `npm start` and the
 * production image all start the same app. `serveApp` picks the transport from
 * what it finds on the machine:
 *
 *  - managed: the platform mounted a workload socket (marketplace install).
 *  - standalone-production: this app was paired (`npm run pair`) and the
 *    identity file is next to it; MCP then rides a Relay connection to the
 *    workspace with signed dispatch and a verified caller.
 *  - development: neither, and NODE_ENV is not production. The MCP endpoint is
 *    unsigned and bound to loopback, for trying the app on this machine only.
 *
 * `npm run dev` adds `--dev-ui`: the workspace then loads the UI live from a
 * Vite dev server. Without that flag the built UI (`npm run build`) is served.
 */
import { fileURLToPath } from 'node:url';

import express from 'express';
import {
  resolveRuntimeMode,
  RuntimeModeError,
  serveApp,
  serveBuiltUi,
  type UiResourceProvider,
} from '@privos_ai/app-server';

import { buildDescriptor, dashboardUri, loadManifest } from './manifest.js';
import { handleMcpRequest } from './tools.js';

const DEV_UI = process.argv.includes('--dev-ui');
// `npm run dev` is development whatever the shell exports: a NODE_ENV=production
// left over in the environment would otherwise switch the SDK to its production rules.
if (DEV_UI) process.env.NODE_ENV = 'development';

function listenPort(): number {
  const port = Number(process.env.PORT || loadManifest().port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT is not a valid port number: ${process.env.PORT}`);
  }
  return port;
}

/**
 * Production with no identity: the marketplace build node runs the image bare,
 * with no workload socket and no identity file, and only needs the manifest to
 * be served. The app serves that and `/health`, and keeps `/ready` at 503, so
 * there is no MCP surface and a real misconfiguration still shows as not ready.
 */
function startManifestOnlySurface(reason: string): void {
  const port = listenPort();
  const app = express();
  app.get('/.well-known/mcp/manifest.json', (_req, res) => res.json(loadManifest()));
  app.get('/health', (_req, res) => res.status(200).json({ ok: true, status: 'alive', degraded: true }));
  app.get('/ready', (_req, res) =>
    res.status(503).json({ ok: false, status: 'not_ready', reason: 'PRODUCTION_WITHOUT_IDENTITY' }),
  );
  const server = app.listen(port, '0.0.0.0', () => {
    console.error(`No runtime identity: ${reason}`);
    console.error(`Serving the manifest only on :${port}. There is no MCP surface until a workload socket or a paired identity file is present.`);
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => server.close());
}

async function createUi(): Promise<{ ui: UiResourceProvider; note: string }> {
  const manifest = loadManifest();
  const uri = dashboardUri(manifest);
  if (DEV_UI) {
    const { devUiHtml, startDevUi } = await import('./dev-ui.js');
    const devUi = await startDevUi();
    return {
      ui: { uri, renderHtml: () => devUiHtml(devUi.origin, manifest.title) },
      note: `Live UI from ${devUi.origin}; the browser that shows the workspace must reach that address (PRIVOS_DEV_UI_ORIGIN overrides it).`,
    };
  }
  // Constructed once, at boot: it validates the whole build (hashed assets, no source maps)
  // so a broken build stops the process here instead of showing a blank frame later.
  let built: ReturnType<typeof serveBuiltUi>;
  try {
    built = serveBuiltUi({ distDir: fileURLToPath(new URL('../dist', import.meta.url)), appSlug: manifest.name });
  } catch (error) {
    throw new Error(`The built UI is not usable (${error instanceof Error ? error.message : error}). Run "npm run build" first.`);
  }
  return {
    ui: {
      uri,
      renderHtml: () => built.renderHtml(),
      readAsset: (assetUri: string) => built.readAsset(assetUri),
      readAssetsManifest: () => built.readAssetsManifest(),
      assetUriPrefix: built.assetUriPrefix,
    },
    note: 'Serving the built UI from dist/.',
  };
}

async function main(): Promise<void> {
  try {
    resolveRuntimeMode();
  } catch (error) {
    if (error instanceof RuntimeModeError && error.code === 'PRODUCTION_WITHOUT_IDENTITY') {
      startManifestOnlySurface(error.message);
      return;
    }
    throw error;
  }

  const { ui, note } = await createUi();
  const handle = await serveApp({
    descriptor: buildDescriptor(),
    ui,
    createHandler: () => handleMcpRequest,
    port: listenPort(),
    resolveManifest: loadManifest,
    configure: (app) => {
      // Serves the manifest exactly as reviewed, ahead of the MCP router. A paired app has no router.
      app.get('/.well-known/mcp/manifest.json', (_req, res) => res.json(loadManifest()));
    },
  });

  console.log(note);
  if (handle.mode === 'development') {
    console.log('No identity file: running in loopback development mode. Calls are unsigned and there is no verified caller,');
    console.log('so tools that need a caller refuse. To open this app in a workspace, pair it once: npm run pair');
  }
}

main().catch((error) => {
  console.error('Failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
