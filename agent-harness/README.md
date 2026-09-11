# `@privos_ai/agent-harness`

Bridge CLI that pairs a PrivOS hub agent with a coding agent you already run —
Claude Code, Codex, Cursor, Goose, or any custom [Agent Client Protocol
(ACP)](https://agentclientprotocol.com) command — on your own machine. It
connects outbound to the hub over WSS, receives turns, drives your local
agent over stdio, and streams the reply back — PrivOS's own ACP bridge for
hub-driven agents.

No LLM cost lands on the tenant: the harness uses your own subscription or
API key. The hub never reaches into your machine — the bridge only ever
connects out.

## Security

**The bridge executes model-driven tool calls on your machine.** The default
permission policy, `--permissions auto`, answers every tool-call permission
request the agent asks for with "allow" — exactly like a local coding-agent
session with no supervision. If a prompt (including one crafted by someone
else in a shared room) can convince the model to run a command, that command
runs, unattended, with your user's privileges.

- Use `--permissions safe` for rooms you do not fully trust: it still allows
  read/search/think/fetch-kind tool calls but rejects everything else
  (edits, deletes, execute, etc).
- Use `--permissions deny` to reject every tool call and only get streamed
  text back.
- The bot token is placed in the adapter subprocess's environment only —
  never in argv, never in the prompt, never logged. An `env`-reading tool call
  can still put it in the model's own transcript; this is the same exposure
  the PrivOS Sandbox `.env` already accepts. Revoke with *Rotate harness
  pairing* in Agent Settings.

## Isolation

Each room the agent is mentioned in gets its own directory
(`<workspace>/rooms/<roomId>/`) and its own adapter subprocess, so a
prompt-injected file operation in one room cannot read or write another
room's files. `--isolation` selects how that boundary is enforced:

| Level | Enforcement | Platforms |
|---|---|---|
| `wrap` | An OS sandbox the bridge generates per room: macOS `sandbox-exec` (Seatbelt), Linux/WSL2 `bwrap`. Room dir + `$TMPDIR` + the room's own adapter state are writable; sibling rooms, the real `~/.claude`/`~/.codex`/`~/.ssh`/`~/.aws`/`~/.gnupg`/`~/.privos` are denied; the shared, read-only skills + `IDENTITY.md` stay readable. | macOS, Linux with unprivileged user namespaces |
| `container` | `docker run` per room; same boundary via bind mounts instead of a kernel sandbox. Needs an image with `python3` + the chosen adapter installed (`--container-image`). | anywhere Docker runs |
| `prompt` | No OS sandbox passed the self-test. Falls back to the adapter's own native sandbox (Claude Code `sandbox.enabled`, Codex `workspace-write`) plus an `<isolation_policy>` instruction in the standing preamble and room `CLAUDE.md`/`AGENTS.md`. Not real enforcement — a warning is printed and, for `respondTo` other than `owner`, the hub requires an explicit acknowledgement. | anywhere |
| `none` | No wrapper, no policy section. Explicit-only, with a red warning. | anywhere |

`--isolation auto` (the default) self-tests `wrap`, then `container`, then
falls back to `prompt` — never on binary presence alone: it actually spawns a
scratch room under the candidate wrapper and checks it can write inside the
room, cannot read a sibling room or the real credential dirs, and can still
read the shared skills + `IDENTITY.md`. Run `privos-agent-harness doctor` to
see the self-test output for this host.

Independent of the isolation level, each room's adapter process also gets
its own **adapter state** (`rooms/<roomId>/.home/`) seeded only with the
credential file that adapter needs (Claude's `.credentials.json` via
`CLAUDE_CONFIG_DIR`, Codex's `auth.json` via `CODEX_HOME`) — never its
settings, hooks, or MCP config, so a hook planted by one room's process never
loads in another room's. Adapters with no documented credential file
(Cursor, Goose, `custom`) keep their real, shared state dir and the level is
reported as `wrap-shared-state`: file isolation still holds, only that
adapter's own login/config is shared, same as an unsandboxed run.

One adapter process serves each room (pooled up to `--max-rooms`, default 8;
the least-recently-used **idle** room is reaped to make space, or the hub
gets a `harness_busy` reply if none is idle; an idle room is also reaped
after 10 minutes and its next turn starts a fresh ACP session).

## Install

Not yet published (publishing is a gated, 2FA-protected operator step). Until
then, build a tarball and install it locally:

```bash
npm run build
npm pack
npm install -g ./privos_ai-agent-harness-*.tgz
```

or run straight from the checkout with `npm link`.

## Commands

### `pair <guideUrl>`

Consumes the one-time pairing guideline URL shown in the Create Agent success
modal or posted by the bot into its agent room. Prints the same steps and
isolation advice as the guideline page, retrieves the one-time bot
credential, and writes `~/.privos/agent-harness/<agentId>.json` (mode
`0600`). Refuses a plain `http://` guide URL to a non-localhost host unless
`--insecure` is passed. A second `pair` run against the same link fails with
a clear "keys already retrieved" error pointing at *Rotate harness pairing*
in Agent Settings.

### `start`

Connects the paired agent and starts serving turns.

| Flag | Default | Notes |
|---|---|---|
| `--agent <id>` | the sole paired agent | required once more than one agent is paired |
| `--adapter <id>` | `claude` | `claude \| codex \| cursor \| goose \| custom` |
| `--command "<bin> [args]"` | adapter default | required for `--adapter custom` |
| `--workspace <dir>` | `~/privos-harness/<agentId>` | workspace root; each room's `cwd` is `<workspace>/rooms/<roomId>` |
| `--isolation <level>` | `auto` | `auto \| wrap \| container \| prompt \| none` — see Isolation |
| `--max-rooms <n>` | `8` | per-room adapter-process pool cap |
| `--container-image <image>` | `node:22-bookworm` | image for `--isolation container`; must have `python3` + the chosen adapter installed |
| `--permissions <policy>` | `auto` | `auto \| safe \| deny` — see Security |
| `--idle-timeout <seconds>` | `600` | reset on any agent activity |
| `--reset-session` | off | forget stored ACP session ids before starting |
| `--insecure` | off | allow plain `http://`/`ws://` to a non-localhost hub |
| `--verbose` | off | stream ACP updates to stderr |

### `status`

Prints the paired agent's config summary (never the bot token) and whether
the hub is currently reachable.

### `doctor`

Checks whether the adapter binary is on `PATH`, prints its auth hint and
tested version, probes the hub connection (reachable / token valid /
401 unauthorized / 403 not-a-harness-agent), and self-tests `wrap` and
`container` isolation on this host (see Isolation).

### `skills update`

Refuses (with a clear message, not a crash) while any room has a turn in
flight — the shared `.privos/skills` swap is visible to every running room's
process the instant it happens. The check works across separate CLI
invocations: `start` marks a room busy/idle as turns come and go, and
`update` reads that marker before touching disk.

## Adapters

| Adapter | Command | System prompt | Auth | Steering |
|---|---|---|---|---|
| `claude` | `claude-agent-acp` (tested 0.76.x) | `session/new._meta.systemPrompt` | `claude` CLI login or `ANTHROPIC_API_KEY` | `acp-extension` |
| `codex` | `codex-acp` | prompt-prefix | `codex` CLI login or `OPENAI_API_KEY` | `acp-extension` |
| `cursor` | `agent acp` | prompt-prefix | Cursor CLI login | none |
| `goose` | `goose acp` | top-level `systemPrompt`, falls back to prefix | provider configured; `GOOSE_MODE=auto` recommended | none |
| `custom` | `--command` (required) | prompt-prefix | depends on the command | none |

Every command is overridable with `--command "<bin> [args]"`.

**Steering** is native mid-turn message injection (`turn.steer` → ACP
`_session/steering`), used by the hub's turn coordinator to deliver a new message
into a reply already in progress. `acp-extension` adapters advertise
`_meta.steering.supported` at `initialize`; the bridge only writes a steering
request to an adapter that advertised it (it never probes) and reports the
capability in `harness.hello.steering`. Adapters marked `none` (and any
`acp-extension` adapter that does not advertise the capability at runtime) fall
back to cancel-and-remerge on the hub side.

## Architecture notes

- One outbound WSS connection per agent, authenticated with `Authorization:
  Bearer <bot token>` (never a `?token=` query string).
- One adapter process per room (pooled up to `--max-rooms`); each room's own
  turns still run through an arrival-order FIFO (AI + human chat parity), but different
  rooms run concurrently against separate processes.
- `session/load` is used to resume a room's conversation when the adapter
  advertises the `loadSession` capability; replay notifications from
  `session/load` are gated so they never appear as `turn.chunk` output.
- Reconnects with exponential backoff (1s → 60s) on any transient
  disconnect; a close code of 4409 (replaced by another bridge) or 4401
  (token revoked), or an HTTP 401/403 at the WebSocket upgrade, is terminal —
  the process prints why and exits.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
