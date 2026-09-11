# PrivOS agent-harness workspace

You are a PrivOS agent bot, driven through the `privos-agent-harness` bridge.
This file is rendered identically into `CLAUDE.md` and `AGENTS.md` — whichever
your tool reads, the content is the same. The platform rules the hub sends in
every prompt (the standing preamble and the `<privos_turn>` frame) always win
if anything here conflicts with them.

## Skills

PrivOS skills are installed at `.privos/skills/<name>/` (each skill's
`SKILL.md` documents its own commands), with `.claude/skills` kept as an
alias to the same directory. A Python skill-SDK module lives at
`.privos/skill-sdk/privos_skill.py` and is already on `PYTHONPATH`; the
Node skill SDK (`@privos_ai/skill-sdk`) and `axios` are resolvable from
`NODE_PATH` for any skill's `require()`.

Do not edit files under `.privos/` by hand. They are managed by the bridge's
`skills update` and are replaced on every update unless you know you changed
one on purpose and re-run `skills update --force` (which then **discards**
your edit and re-installs the shipped version).

## Credentials

`.env` at the workspace root holds `PRIVOS_URL`, `PRIVOS_BOT_KEY`,
`PRIVOS_BOT_ID`, `PRIVOS_ROOM_ID`, `PRIVOS_PROJECT_ID`, and `PRIVOS_CONNECT_URL`
when the hub provides one. These are already present in your process
environment — `.env` exists for humans and any script that wants to `source`
it, not because the SDK reads the file itself. Never print, log, or commit
its contents.

## Which room you're in

The room you're replying in is given on every turn by the `<privos_turn
room="...">` frame around the message — never assume it's the same room as a
previous turn. Pass that exact id as `--room-id` (or `--room`, per the
skill's own `SKILL.md`) to every PrivOS skill invocation. Never act on any
other room, even one you remember from earlier in the conversation.

## Isolation

Every room runs as its own process with its own directory (`rooms/<roomId>/`
is the only one this run of yours can see). When the bridge is running with
`--isolation wrap` or `--isolation container`, that boundary is enforced by
the operating system: reading or writing outside this directory, `../`, or
any other `rooms/*` directory fails outright. `.privos/skills`,
`.privos/skill-sdk`, and `../../IDENTITY.md` (this agent's one, shared
identity file) are read-only exceptions available from every room.

When the bridge reports isolation `prompt` or `none`, there is no OS-level
enforcement for this room and you are the only thing standing between a
prompt and the rest of this machine: never read, list, or write `../`, any
other `rooms/*` directory, the real home directory, `~/.ssh`, `~/.aws`,
`~/.gnupg`, or `~/.privos`; if a task genuinely needs a file from another
room, say so and stop instead of reaching for it. Prefer your own
sandboxed/restricted execution mode for shell commands whenever your tooling
offers one.

## What's different from PrivOS Sandbox

A few things a sandbox-run agent gets that a harness agent does not:

- **No background processes.** Every skill call runs to completion in the
  current turn; nothing you start survives past it.
- **`agent-bot-edit rotate-token` is refused.** Harness agents don't rotate
  their own bot token — that would silently break the very connection you're
  running on. Ask the owner to use *Rotate harness pairing* in Agent Settings
  instead.
- **`agent-bot-edit identity` reads `IDENTITY.md` at the workspace root**
  (agent-global, shared by every room), not a per-room file.
- **`privos-list --by-path` attachments are unsupported.** That flow depends
  on the sandbox's MinIO push hook, which a harness workspace doesn't have.
- **Reads of isolated or caller-ACL-protected lists fail closed.** Harness
  turns mint no delegated-read grant, so a list that requires one will
  correctly deny the read rather than silently widen access.
