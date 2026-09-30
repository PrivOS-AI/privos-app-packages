# `privos-app publish` Error Reference

Every failure the CLI surfaces carries a `code` (visible in `--json` `error`
events and in the human-readable message) and maps to one of the exit codes
in `SKILL.md`. This table is generated from the CLI's actual error sites
(`src/cli/commands/publish.ts`, `src/cli/lib/*.ts`) and the Portal codes they map — do not hand-edit
without checking the source stays in sync.

## Manifest / packaging (exit 2 unless noted)

| Code | Cause | Remediation |
|---|---|---|
| `MANIFEST_INVALID` | `privos-app.json` fails structural lint | Run `privos-app lint` and fix the reported fields |
| `MANIFEST_IDENTITY_MISMATCH` | `name`/`version` differ between `privos-app.json` and `package.json` | Make both files agree exactly |
| `NOT_GIT_REPOSITORY` (exit 5) | `--cwd` is not inside a git repo, or has no commits | Publish from a committed git checkout |
| `DIRTY_TREE` | Uncommitted changes present, `--allow-dirty` not passed | Commit the intended files, or pass `--allow-dirty` deliberately |
| `CREDENTIAL_FILE_FOUND` | A `.env.*`, `.pem`, `.key`, `id_rsa*`, or `*credentials*` file is in the working tree | Remove or relocate the file outside the packaged tree |
| `GIT_ARCHIVE_FAILED` (exit 5) | `git read-tree`/`add`/`write-tree`/`archive` failed | Check the git error text printed alongside; usually a broken index or permissions issue |
| `INVALID_ZIP` | Produced archive has no valid ZIP central directory | Re-run; if it repeats, file a bug — not user-fixable |
| `MISSING_REQUIRED_ENTRY` | Archive is missing `privos-app.json` or `Dockerfile` at its root | Ensure both files are tracked (or present with `--allow-dirty`) at the repo root |
| `DENIED_PATH_IN_ARCHIVE` | Archive contains `node_modules`, `dist`, `dist-source`, `.git`, `.privos/skills`, `.env*`, `..` traversal, or credential-like paths | Remove those paths from the tree/`.gitattributes export-ignore` before packaging |
| `ENTRY_LIMIT_EXCEEDED` | Archive has more than 20,000 entries | Reduce tracked files or exclude generated assets |
| `FILE_SIZE_EXCEEDED` | A single file exceeds 50 MB | Remove or externalize the oversized file |
| `TOTAL_SIZE_EXCEEDED` | Archive exceeds 200 MB total | Trim the packaged tree |
| `CANCELLED` (exit 5) | User declined the interactive confirmation prompt | Re-run and confirm, or pass `--yes` |

## Authorization (exit 3 unless noted)

| Code | Cause | Remediation |
|---|---|---|
| `PUBLISHER_NOT_ENABLED` (exit 2) | Marketplace publishing is not open to this creator yet; the Portal refused the source upload before storing anything, and no version exists | Do not retry. Run the app in your own workspace as a Standalone Relay app |
| `LISTING_NOT_BOUND` (exit 2) | A publisher token was used but this listing has never had an interactively-approved first version | Run `privos-app publish` without a token once (browser approval) to bind the listing, then use the token for subsequent versions |
| `LISTING_UNRESOLVED` (exit 2) | The Portal could not resolve a listing from the manifest name | Pass `--listing <slug>` |
| `AUTHORIZATION_DENIED` | The approver declined the request on the approval page | Confirm with the user this was intentional; re-run to request a new approval if not |
| `AUTHORIZATION_EXPIRED` | Nobody approved within the authorization's TTL (15 min) | Re-run `publish`; approve promptly this time |
| `AUTHORIZATION_CONSUMED` | The device code was already used to mint a grant | Re-run `publish` to request a fresh authorization |
| `PUBLISHER_TOKEN_INVALID` / `PUBLISHER_TOKEN_REVOKED` / `PUBLISHER_TOKEN_EXPIRED` (exit 3) | `PRIVOS_PUBLISHER_TOKEN` is malformed, revoked, or past its expiry | Generate a new token in Creator Studio (step-up required) and export it in the environment |

## Upload / version / submit (exit 2 unless noted)

| Code | Cause | Remediation |
|---|---|---|
| `PUBLISH_GRANT_EXPIRED` (exit 3) | The 60-minute grant expired mid-upload | Re-run `publish` to request a new approval; do not resume a stale grant |
| `PUBLISH_GRANT_MISMATCH` | Uploaded archive sha256 or manifest name/version does not match what was approved | Re-run `publish` from a clean state — do not edit the archive after approval |
| `VERSION_SEMVER_EXISTS` | This exact semver was already published for the listing | **Bump `version` in both `privos-app.json` and `package.json`**, then re-run |
| `LISTING_CONTENT_INCOMPLETE` | A first version was refused at version creation because the listing still lacks required content; the message lists what is missing | Complete the listing in Creator Studio, then re-run `publish` (nothing was claimed) |

## Post-submit states (exit 0 — informational, not failures)

`publish` waits up to 60 s after submit for the version to leave
`PREFLIGHT_PENDING`, then prints one of:

- **`PREFLIGHT_FAILED`** — the automated preflight scan rejected the archive
  itself (manifest/runtime problems found in the uploaded content). The CLI
  prints the findings verbatim (exit 2). Fix the flagged issue, bump the
  version, and re-run `publish`.
- **`PREFLIGHT_BLOCKED_INFRA`** — preflight cannot run because of
  Portal-side build infrastructure (capacity or availability), not anything
  wrong with the submission (exit 0). It is an infrastructure state only; a
  creator who is not enabled is refused earlier with `PUBLISHER_NOT_ENABLED`.
  Tell the user this is admin-side; no local action fixes it — wait and check
  Creator Studio later.
- **`PREFLIGHT_PENDING`** (still pending after 60 s) or any other state —
  printed as-is with "follow up in Creator Studio". The CLI has no `status`
  command; all further review progress (`SCAN` → `AI_REVIEW` → human
  `APPROVE` → build) is tracked only on `client.privos.io`.
