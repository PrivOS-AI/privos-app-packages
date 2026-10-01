# create-privos-mcp-app

CLI scaffolder for [PrivOS](https://privos.io) MCP apps. It generates a TypeScript app that runs in your own workspace over Relay, and that passes the checks the PrivOS marketplace applies when you publish it.

Requires Node 22 or newer. The CLI warns on an older Node, and the generated app declares `engines.node >=22`.

## Usage

```bash
npx create-privos-mcp-app my-app --id com.acme.my-app
cd my-app
npm install --include=dev
git add -A && git commit -m "Initial commit"   # include package-lock.json
npm run dev
```

| Flag | Meaning |
|------|---------|
| `--id <id>` | The app id: `package.json` `name`, `privos-app.json` `name` and the host of every `ui://` URI. It must match `^[a-z0-9][a-z0-9._-]{1,127}$`, and the marketplace listing slug derived from it (lowercase, every run of other characters becomes one hyphen) must be 2-63 characters. The listing slug is globally unique, so pick an id you own, for example a reversed domain. Without the flag the id is the placeholder `com.example.<app-name>`, and the CLI says it must be replaced before publishing. |
| `--template default\|instant` | Which template to scaffold. An unknown name exits with the list of valid ones. |

`npm install --include=dev` matters: the build tools are development dependencies, and a shell that exports `NODE_ENV=production` makes a plain `npm install` skip them.

### Git

Publishing archives the repository root, so an app has to be its own repository. The scaffolder runs `git init -b main` when `git` is available and the new directory is not already inside a work tree. It never commits. Inside an existing repository, or without `git`, it says so and leaves the repository to you; a git failure never fails the scaffold. The marketplace build runs `npm ci`, so make the first commit with `package-lock.json` in it.

## Templates

### `default`: a server app (runs over Relay or on the marketplace)

```
my-app/
├── privos-app.json         # schema version 3 manifest: identity, permissions, data policy, tools
├── Dockerfile              # node:22-alpine, non-root, no npm at runtime, health check on /health
├── package.json
├── gitignore → .gitignore  # secrets, identity file, build output; never the lockfile
├── .gitattributes          # agent folders and instruction files stay out of the publish archive
├── .dockerignore
├── vite.config.ts          # UI build
├── vitest.config.ts        # tests (separate from the UI build config)
├── tsconfig.json           # typecheck: UI, scripts and tests
├── tsconfig.server.json    # server build into dist-server/
├── scripts/pair.ts         # npm run pair
├── src/
│   ├── server.ts           # serveApp entry point
│   ├── tools.ts            # tool handlers: (arguments, context) => result
│   ├── manifest.ts         # reads privos-app.json
│   ├── dev-ui.ts           # live Vite UI for npm run dev
│   └── ui/                 # React UI built on @privos_ai/app-react
└── tests/                  # manifest invariants, tool tests
```

| Script | Purpose |
|--------|---------|
| `npm run dev` | Watch mode with the UI served live from a Vite dev server. |
| `npm run pair` | Connect the app to a workspace, once. |
| `npm run build` | Build the UI into `dist/` and the server into `dist-server/`. |
| `npm start` | Run the same app with the built UI. |
| `npm test`, `npm run typecheck` | The starter tests and the type check. |
| `npm run manifest:lint:publish` | Lint the manifest with the rules `publish` applies. |
| `npm run publish:marketplace -- --dry-run` | Package the archive and print its hash; nothing is uploaded. |

The example tool (`<app>_whoami`) shows the rules for identity: take the caller and the room only from `context.actor` and `context.roomId`, never from the arguments; refuse when there is no verified actor. `tools/list` is the manifest's own tool list and `tools/call` dispatches by name.

The UI reads the lists of the room only when `usePrivosCapability('lists:read')` reports the grant, and shows a degraded state otherwise. `lists:read` is declared as an optional permission with a `degradedBehavior`, so a workspace admin can approve the app without it.

### `instant`: a UI with no server

```bash
npx create-privos-mcp-app my-app --template instant --id com.acme.my-app
```

An INSTANT app is the Vite and React UI plus a `privos-app.json` with `executionMode: "INSTANT"`, a `ui.entryPoints.roomTab` and an optional `agent` section. There is no runtime to configure, so `tools`, `port`, `resources`, `volumes` and `stateless` are rejected by the lint. `@privos_ai/app-server` is a development dependency that provides the `privos-app` commands and the SDK the preview uses.

```
my-app/
├── privos-app.json         # INSTANT manifest: no tools
├── package.json
├── vite.config.ts          # UI build (src/ui -> dist/)
├── vitest.config.ts, tsconfig.json, gitignore → .gitignore, .gitattributes
├── scripts/                # development only, never part of the published UI bundle
│   ├── pair.ts             # npm run pair
│   ├── dev-relay.ts        # npm run dev: serveApp with the live UI
│   ├── relay-manifest.ts   # privos-app.json + one UI tool per entry point, in memory
│   └── dev-ui.ts           # live Vite UI
├── src/ui/                 # React UI built on @privos_ai/app-react
└── tests/                  # manifest invariants, relay manifest tests
```

| Script | Purpose |
|--------|---------|
| `npm run pair` | Connect the preview to a workspace, once. |
| `npm run dev` | Preview the app in a workspace over Relay, with the UI served live from Vite. |
| `npm run build` | Build the UI into `dist/`. |
| `npm test`, `npm run typecheck` | The starter tests and the type check. |
| `npm run manifest:lint:publish` | Lint the manifest with the rules `publish` applies. |
| `npm run publish:marketplace -- --dry-run` | Package the archive and print its hash; nothing is uploaded. |

An INSTANT app can be previewed in a workspace over Relay with `npm run pair` and `npm run dev`, exactly like the `default` template (see the next section). A workspace finds the UI of a Relay app's tab through a tool that points at it, and an INSTANT manifest has no tools, so the preview pairs with a **relay manifest**: `privos-app.json` plus one UI-only tool per `ui.entryPoints` entry, built in memory by `scripts/relay-manifest.ts`. `privos-app.json` itself never changes and stays tool-free, as the marketplace requires. `npm run pair` and `npm run dev` build the same relay manifest, so the digest pinned at pairing never drifts on its own; a real edit of `privos-app.json` changes it, and the app reports the drift until you approve the update in the workspace. The preview serves one UI page, so every entry point has to point at the same `ui://` URI. Production for an INSTANT app stays the marketplace.

## Relay: develop in your own workspace

Relay is one path for development and production. The workspace makes no difference between the two and the protocol is the same; Relay suits development because pairing takes far less procedure than a marketplace upload. There is one pairing and one identity file.

1. Ask a workspace admin for a one-time pairing URL (Admin > Apps).
2. `npm run pair` and paste the URL when asked. It is read from standard input, so it never lands in shell history. The app announces its `privos-app.json`; an admin then approves the permissions in the workspace, and the command waits for that. It ends by writing `privos-standalone-identity.json` (mode 0600) and printing the Hub fingerprint. Check the fingerprint with the person who issued the URL.
3. `npm run dev`. The app runs in watch mode with signed dispatch and a verified caller, and the workspace page loads its UI live from Vite, so a UI edit shows up without a rebuild.
4. (`default` template) `npm run build && npm start` runs the same pairing with the built UI, for a machine that stays up. The pairing and the workspace do not change. An INSTANT app has no `start`: its production path is the marketplace.

Without an identity file, `npm run dev` starts in loopback development mode: the MCP endpoint is unsigned and there is no verified caller, so tools that need one refuse (for an INSTANT app no workspace can reach it). It prints how to pair. The app listens on `PORT` when it is set, else on the manifest `port` (`default`) or 3001 (`instant`); unset `PORT` if your shell exports one that another service uses.

Good to know:

- The live UI is loaded by the browser that shows the workspace, from `http://localhost:5173`, so that browser must run on the machine that runs Vite, or reach it through a forwarded port. For a forwarded or tunnelled origin set `PRIVOS_DEV_UI_ORIGIN`, for example `PRIVOS_DEV_UI_ORIGIN=https://dev.example.com npm run dev`.
- `privos-standalone-identity.json` and `privos-standalone-identity.pending.json` hold relay credentials and dispatch trust. The generated `.gitignore` and `.dockerignore` exclude them. Never commit them, copy them, or put their contents in an environment file. The watcher does not restart when they change.
- Edit `privos-app.json` and the app reports the difference from the approved manifest on `/ready`; approve the update from the app's settings in the workspace. Re-pairing a live app is refused.
- To pair again, uninstall the app in the workspace and delete the identity file.
- If `npm run pair` is interrupted before the approval, it leaves `privos-standalone-identity.pending.json` behind and refuses to start again. Remove the half-registered app in the workspace, delete that file, and pair with a new URL.
- **An app id is live once per workspace.** A Relay copy blocks a marketplace install of the same app id in that workspace. Uninstall the Relay copy before installing the same app from the marketplace there.

## Publish to the marketplace

```bash
npm run manifest:lint:publish
npm run publish:marketplace -- --dry-run
npm run publish:marketplace
```

The archive is `git archive HEAD` of the app repository, so commit first, and keep `privos-app.json` (and `Dockerfile` for the default template) at the root. `.gitattributes` keeps `.claude/`, other agent folders and agent instruction files out of the archive. The `default` template builds with `npm ci` and runs bare, without a workload socket or an identity file, as the marketplace build does: it serves `/.well-known/mcp/manifest.json` and `/health`, keeps `/ready` at 503 and exposes no MCP surface. Publishing works for creators the marketplace has enabled; anyone else gets an explicit error and nothing is uploaded.

## Documentation

- [privos-mcp-app skill](https://github.com/PrivOS-AI/privos-mcp-app-skill): build an app with an AI agent such as Claude Code
- [Developer Guide](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mcp-app-platform/developer-guide.md)
- [API Reference](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mcp-app-platform/api-reference.md)
- [Reference app](https://github.com/PrivOS-AI/privos-mcp-app-demo) and [INSTANT reference app](https://github.com/PrivOS-AI/privos-okr-instant-app)

## License

MIT
