---
name: privos-app-publish
description: Publish a PrivOS MCP app to the Marketplace using the `privos-app` CLI (package, lint, upload, version, submit) with either interactive browser approval or a CI publisher token.
user-invocable: true
when_to_use: "Invoke when the user asks to publish, release, or ship a new version of an MCP app to the PrivOS Marketplace."
category: publishing
keywords: [privos-app, marketplace, publish, mcp-app, cli]
license: MIT
argument-hint: "[app directory]"
metadata:
  author: privos
  version: "1.0.0"
---

# PrivOS App Publish Skill

Runs `privos-app publish` correctly from an MCP app folder. The CLI (shipped
in `@privos_ai/app-server`, bin `privos-app`) is the only supported publish
path — it is a scripted `npm publish`-shaped flow: package → lint → authorize
→ upload → version → submit. Do not hand-drive Portal API calls or resurrect
the retired `.mjs` publish scripts.

## When to Use

- The user asks to publish, release, or ship a new version of an MCP app to
  the PrivOS Marketplace.
- The user asks to check why a publish failed (see `references/errors.md`).

Not for: editing listing content, pricing, screenshots, or Stripe Connect
(all Creator Studio, web-only) — the CLI never touches those.

## Preconditions (verify before running)

1. **Clean git tree.** `privos-app publish` refuses a dirty working tree
   unless `--allow-dirty` is passed. Prefer committing first; only use
   `--allow-dirty` when the user explicitly wants an uncommitted snapshot
   packaged.
2. **Version bumped in BOTH files.** `privos-app.json` `version` and
   `package.json` `version` must be equal (the CLI fast-fails otherwise,
   `MANIFEST_IDENTITY_MISMATCH`) and must be a semver that has never been
   published for this listing before — re-publishing an existing semver fails
   with `VERSION_SEMVER_EXISTS`. Always bump both fields together.
3. **Manifest passes structural lint.** Run `privos-app lint` (or let
   `publish` run it — it lints as step 1) before attempting a full publish.
4. **Catalog check.** Confirm this is genuinely a new version of an existing
   listing or a legitimately new app — do not re-run publish blindly after a
   failure without reading the error.

## Exact Commands

Run from the app's root directory (where `privos-app.json` lives):

```bash
# Preview only — packages the archive, prints its sha256, does not authorize or upload
npx privos-app publish --dry-run

# Interactive (default): prints an approval URL, waits for browser approval
npx privos-app publish

# Non-interactive / CI: requires PRIVOS_PUBLISHER_TOKEN in the environment
PRIVOS_PUBLISHER_TOKEN=pvp_xxx npx privos-app publish --yes

# Machine-readable event stream (one NDJSON object per line on stdout)
npx privos-app publish --json
```

Useful flags: `--listing <slug>` (when the listing can't be resolved from the
manifest name), `--changelog <text>` / `--changelog-file <path>`,
`--allow-dirty`, `--portal <origin>` (default `https://portal.privos.io`),
`--machine-label <text>` (shown on the approval page, never the hostname by
default), `--cwd <path>`, `-h/--help`.

## Reading `--json` Output

Each line is one JSON object with an `event` field, emitted in this order:
`lint` → `package` → (`authorization_token` | `authorization_device` →
`authorization_approved`) → `upload_progress` (repeated) → `upload_complete`
→ `version_created` → `submitted` → `status`. A run that fails emits `error`
with `code` and `message` instead of continuing. Never print or log a `grant`
or token value beyond what the CLI itself already masks — the CLI does not
emit raw secrets in any event.

## Handing the Approval URL to the User

**The agent cannot click the approval link.** On `authorization_device`,
print the `verificationUrl` and `userCode` verbatim to the user and ask them
to open it in their own browser and log in to `client.privos.io` — do not
attempt to fetch, curl, or "visit" the URL yourself. The CLI polls
automatically after printing it; do not re-run `publish` while it is waiting.
If the user says they approved but the CLI is still waiting, tell them to
recheck they approved the correct listing/version shown on the page —
approval is not automatic on click, it depends on identity match.

## Token Mode (CI / Non-Interactive)

`PRIVOS_PUBLISHER_TOKEN` must come from the environment only — never ask the
user to paste a `pvp_…` token into chat, never write one into a command
argument, file, or log. If the user wants CI mode but has no token yet, tell
them to generate one from Creator Studio (a step-up action: email code or
magic link, plus TOTP if their account has 2FA) and export it in their own
shell/CI secret store before re-running. Token mode only works after the
listing's first version was approved once interactively (see
`LISTING_NOT_BOUND` below).

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Submitted (or reached a benign non-blocking status; see `references/errors.md`) |
| 2 | Blocked by policy (manifest invalid, dirty tree, denied archive path, semver reused, preflight failed) |
| 3 | Authorization denied, expired, or already consumed |
| 4 | Network or Portal error |
| 5 | Usage error (bad flags, cancelled prompt, not a git repository) |

## After Submit

The CLI has no `status` or `whoami` command. Once `submitted` prints, review
progress (`PREFLIGHT_PENDING` → `SCAN` → `AI_REVIEW` → human `APPROVE` →
build) is tracked only in Creator Studio on `client.privos.io`. Tell the user
to check there — do not invent a polling loop or guess at review state.

See `references/errors.md` for the full error-code table and remediation,
including `VERSION_SEMVER_EXISTS`, `PREFLIGHT_FAILED` vs
`PREFLIGHT_BLOCKED_INFRA` vs incomplete listing content.
