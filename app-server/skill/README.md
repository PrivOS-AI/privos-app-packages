# `privos-app-publish` Claude Skill

This directory is the packaged Claude skill for publishing PrivOS MCP apps
to the Marketplace with the `privos-app` CLI (shipped in this package's
`bin`). It is not loaded automatically — `create-privos-mcp-app` copies it
into a generated app's `.claude/skills/privos-app-publish/` at scaffold time.

- `SKILL.md` — when to use, preconditions, exact commands, `--json` event
  reading, approval-URL handoff, token-mode rules, exit codes.
- `references/errors.md` — full error-code table and remediation.

Keep this content in sync with the actual CLI flags/behavior in
`src/cli/commands/publish.ts` and `src/cli/lib/*.ts` — it is generated from
that source, not hand-invented.
