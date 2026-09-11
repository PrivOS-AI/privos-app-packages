/**
 * macOS Seatbelt (`sandbox-exec -p <profile>`) SBPL generator for the `wrap`
 * isolation level. Empirically-verified facts this MUST honour (red-team
 * pass 3, run on a real macOS host):
 *
 * - Seatbelt matches CANONICAL paths only (`/private/var/...`, never
 *   `/var/...`) — every path is `realpath`'d before it is emitted (H2).
 * - `(deny file-write*)` also blocks `/dev/null` and ttys — explicit `/dev`
 *   allows are required alongside the room/tmp/home writable roots (H3).
 * - A `(deny file-read* (subpath "<parent>"))` with a nested
 *   `(allow file-read* (subpath "<child>"))` still blocks `chdir`/spawn into
 *   the child unless the parent also gets `(allow file-read-metadata ...)`
 *   (H1) — `<workspace>/rooms` is exactly this case (sibling rooms denied,
 *   this room re-allowed).
 * - Apple Sandbox rules are last-match-wins per operation, which is what
 *   makes the deny-then-re-allow pattern above work at all.
 *
 * Residual, documented rather than attempted here (M1): same-user daemons
 * reachable over a unix socket (Docker socket, tmux server, ssh-agent) are
 * not blocked — no verified SBPL unix-socket filter syntax to depend on;
 * `container` is the isolation level for hosts where that residual matters.
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SeatbeltProfileInput {
	/** Workspace root, e.g. `~/privos-harness/<agentId>` (realpath'd internally). */
	workspaceDir: string;
	/** This room's directory, `<workspaceDir>/rooms/<roomId>` (realpath'd internally). */
	roomDir: string;
	/**
	 * The adapter's per-room state dir (`rooms/<roomId>/.home`) when seeded,
	 * or `undefined` for a shared-state adapter (Cursor/Goose/custom) — in
	 * that case its real global state dir is left reachable through the
	 * `(allow default)` baseline, same as an unsandboxed run.
	 */
	homeDir: string | undefined;
	/** Real, un-sandboxed `$HOME` — source of the `.claude`/`.ssh`/etc deny roots. */
	realHomeDir: string;
}

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function literal(path: string): string {
	return `(literal "${path}")`;
}
function subpath(path: string): string {
	return `(subpath "${path}")`;
}

const DEV_WRITE_ALLOWS = [
	literal('/dev/null'),
	literal('/dev/tty'),
	'(regex #"^/dev/ttys")',
	subpath('/dev/fd'),
	literal('/dev/zero'),
	literal('/dev/random'),
	literal('/dev/urandom'),
	literal('/dev/dtracehelper'),
];

export function buildSeatbeltProfile(input: SeatbeltProfileInput): string {
	const workspaceDir = realpathOrSelf(input.workspaceDir);
	const roomDir = realpathOrSelf(input.roomDir);
	const homeDir = input.homeDir ? realpathOrSelf(input.homeDir) : undefined;
	const realHome = realpathOrSelf(input.realHomeDir);
	const tmp = realpathOrSelf(tmpdir());

	const privosSharedDir = join(workspaceDir, '.privos');
	const identityFile = join(workspaceDir, 'IDENTITY.md');
	const roomsRoot = join(workspaceDir, 'rooms');

	const writableSubpaths = [subpath(roomDir), subpath(tmp), ...(homeDir ? [subpath(homeDir)] : []), ...DEV_WRITE_ALLOWS];

	const denyReadSubpaths = [
		subpath(roomsRoot),
		subpath(join(realHome, '.claude')),
		literal(join(realHome, '.claude.json')),
		subpath(join(realHome, '.codex')),
		subpath(join(realHome, '.ssh')),
		subpath(join(realHome, '.aws')),
		subpath(join(realHome, '.gnupg')),
		subpath(join(realHome, '.privos')),
	];

	const allowReadSubpaths = [subpath(roomDir), subpath(privosSharedDir), literal(identityFile), ...(homeDir ? [subpath(homeDir)] : [])];

	const lines = [
		'(version 1)',
		';; Allow-most baseline (network, process, most reads) with targeted denies',
		';; below, narrowed back open only for this one room. Seatbelt rules are',
		';; last-match-wins per operation, which is what makes deny-then-re-allow work.',
		'(allow default)',
		'(deny appleevent-send)',
		'',
		';; file-write*: nothing but this room, $TMPDIR, this room\'s adapter state, and the /dev nodes Node/the adapter need.',
		'(deny file-write*)',
		`(allow file-write* ${writableSubpaths.join(' ')})`,
		'',
		';; file-read*: hide sibling rooms and every real credential/config dir, then re-open exactly this room plus the shared, read-only skills + identity file.',
		`(deny file-read* ${denyReadSubpaths.join(' ')})`,
		`(allow file-read* ${allowReadSubpaths.join(' ')})`,
		'',
		";; H1: chdir/spawn({cwd: roomDir}) needs metadata on the denied PARENT of an allowed child.",
		`(allow file-read-metadata ${literal(roomsRoot)})`,
		'',
	];
	return `${lines.join('\n')}\n`;
}
