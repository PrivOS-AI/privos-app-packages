/**
 * Live UI for `npm run dev`: a Vite dev server the workspace page loads its
 * scripts from, so a UI edit shows up without a rebuild.
 *
 * The app answers `resources/read` for its own UI, so in dev it answers with a
 * tiny page that points at this Vite server (`devUiHtml`) instead of the built
 * bundle. That page carries the two things Vite would normally inject into an
 * `index.html`: the Vite client and the React refresh preamble.
 *
 * The page is shown inside the workspace, in the browser, so the browser must
 * be able to reach the Vite origin. On the machine that runs `npm run dev`
 * that is http://localhost:5173. From another machine, forward the port or
 * tunnel it and set PRIVOS_DEV_UI_ORIGIN to the address the browser uses.
 *
 * Development only: only `npm run dev` loads this module. It is not part of
 * the UI bundle that gets published.
 */
import path from 'node:path';

export const DEV_UI_PORT = 5173;

export interface DevUi {
  /** Origin the workspace page loads the UI scripts from. */
  origin: string;
  close(): Promise<void>;
}

/** The origin the browser uses: PRIVOS_DEV_UI_ORIGIN when set, else the local Vite server. */
export function resolveDevUiOrigin(env: NodeJS.ProcessEnv = process.env): URL {
  const raw = env.PRIVOS_DEV_UI_ORIGIN?.trim();
  if (!raw) return new URL(`http://localhost:${DEV_UI_PORT}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PRIVOS_DEV_UI_ORIGIN is not a URL: ${raw}`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`PRIVOS_DEV_UI_ORIGIN must be an http(s) origin without a path, such as https://dev.example.com: ${raw}`);
  }
  return url;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function devUiHtml(origin: string, title: string): string {
  const base = origin.replace(/\/$/, '');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} (dev)</title>
  <script type="module" src="${base}/@vite/client"></script>
  <script type="module">
    import RefreshRuntime from "${base}/@react-refresh";
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${base}/main.tsx"></script>
</body>
</html>`;
}

export async function startDevUi(): Promise<DevUi> {
  const origin = resolveDevUiOrigin();
  const isLocal = origin.hostname === 'localhost' && Number(origin.port || 80) === DEV_UI_PORT;
  const { createServer } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const vite = await createServer({
    // Not vite.config.ts: loading that file makes Vite write and delete a temporary module
    // next to it, which the `tsx watch` of `npm run dev` takes for a change and restarts on, forever.
    // The build config stays in vite.config.ts; keep `root` and the plugin in step with it.
    configFile: false,
    root: path.resolve(process.cwd(), 'src/ui'),
    base: '/',
    publicDir: false,
    plugins: [react()],
    // The page that loads these scripts has a workspace origin, not localhost.
    server: {
      port: DEV_UI_PORT,
      strictPort: true,
      cors: true,
      host: 'localhost',
      ...(isLocal
        ? { hmr: { protocol: 'ws', host: 'localhost', clientPort: DEV_UI_PORT } }
        : {
            allowedHosts: [origin.hostname],
            hmr: {
              protocol: origin.protocol === 'https:' ? 'wss' : 'ws',
              host: origin.hostname,
              clientPort: Number(origin.port) || (origin.protocol === 'https:' ? 443 : 80),
            },
          }),
    },
  });
  await vite.listen(DEV_UI_PORT);

  const close = () => vite.close();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void close());
  return { origin: origin.origin, close };
}
