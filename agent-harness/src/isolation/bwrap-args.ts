/**
 * Linux/WSL2 `bwrap` (bubblewrap) argument generator for the `wrap`
 * isolation level. Ordering is load-bearing (red-team M2): every `--tmpfs`
 * over a PARENT directory must come BEFORE the `--bind`/`--ro-bind` of any
 * CHILD inside it, or bwrap mounts them in argument order and the bind gets
 * shadowed by the later tmpfs. `--unshare-all --share-net` isolates every
 * namespace except networking (the hub connection and any HTTP the agent
 * makes still need net); `--die-with-parent` prevents an orphaned sandboxed
 * process if the bridge itself dies.
 *
 * Requires unprivileged user namespaces, which are unavailable on Ubuntu
 * >= 24.04 by default and inside unprivileged containers — the self-test
 * (`self-test.ts`) is what actually detects this and falls the level to
 * `container`/`prompt` rather than this module guessing.
 */
import { join } from 'node:path';

export interface BwrapArgsInput {
	/** Workspace root, e.g. `~/privos-harness/<agentId>`. */
	workspaceDir: string;
	/** This room's directory, `<workspaceDir>/rooms/<roomId>`. */
	roomDir: string;
	/** The adapter's per-room state dir, or `undefined` for a shared-state adapter (its real state dir is left reachable — not tmpfs'd here). */
	homeDir: string | undefined;
	/** Real, un-sandboxed `$HOME` — source of the tmpfs'd `.ssh`/`.aws`/etc dirs. */
	realHomeDir: string;
}

/** Env vars the doc calls for once a room's process runs read-only-`$HOME` under bwrap (L2). */
export const BWRAP_EXTRA_ENV: Record<string, string> = {
	PYTHONDONTWRITEBYTECODE: '1',
	DISABLE_AUTOUPDATER: '1',
};

export function buildBwrapArgs(input: BwrapArgsInput): string[] {
	const privosSharedDir = join(input.workspaceDir, '.privos');
	const identityFile = join(input.workspaceDir, 'IDENTITY.md');
	const roomsRoot = join(input.workspaceDir, 'rooms');

	const args = [
		'--unshare-all',
		'--share-net',
		'--die-with-parent',
		'--ro-bind',
		'/',
		'/',
		'--proc',
		'/proc',
		'--dev',
		'/dev',
		'--tmpfs',
		'/tmp',
		'--tmpfs',
		'/run',
		'--tmpfs',
		'/var/run',
		'--tmpfs',
		join(input.realHomeDir, '.ssh'),
		'--tmpfs',
		join(input.realHomeDir, '.aws'),
		'--tmpfs',
		join(input.realHomeDir, '.gnupg'),
		'--tmpfs',
		join(input.realHomeDir, '.privos'),
		'--tmpfs',
		join(input.realHomeDir, '.claude'),
		'--tmpfs',
		join(input.realHomeDir, '.codex'),
		// tmpfs over the PARENT (rooms/) before binding the CHILD (this room) — M2.
		'--tmpfs',
		roomsRoot,
		'--bind',
		input.roomDir,
		input.roomDir,
		'--ro-bind',
		privosSharedDir,
		privosSharedDir,
		'--ro-bind',
		identityFile,
		identityFile,
	];
	if (input.homeDir) args.push('--bind', input.homeDir, input.homeDir);
	return args;
}
