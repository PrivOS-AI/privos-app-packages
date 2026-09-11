/**
 * Seeds a per-room adapter state directory (`rooms/<roomId>/.home/`) so that
 * a room's adapter process never touches the user's real, shared
 * `~/.claude`/`~/.codex`/`~/.ssh`/etc — only the credential files the
 * adapter table explicitly declares (`credentialFiles[]`) are copied in,
 * 0600, never settings/hooks/MCP configs or global instructions (the hook
 * vector — red-team H5). Applied unconditionally, independent of the OS
 * isolation level: it is a cheap, always-on room boundary for adapter state
 * even under `prompt`/`none` where there is no OS sandbox.
 *
 * Adapters with no documented credential file (`credentialFiles: []`) are
 * left alone entirely — `mode: 'shared'` — and keep reading/writing their
 * real global state dir, which is also why the OS-isolation profile
 * generators never deny it (`(allow default)` covers it implicitly).
 */
import { copyFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AdapterSpec } from './acp/adapter-table.js';

export interface SeededAdapterState {
	mode: 'seeded' | 'shared';
	/** The per-room state dir this adapter's own subdir lives in (`homeStateDir` for `writeNativeSandboxConfig`), only set when `mode === 'seeded'` and the adapter declares a `homeSubdir`. */
	homeStateDir: string | undefined;
	/** Env overrides to apply to this room's process only (`HOME`, and `CLAUDE_CONFIG_DIR`/`CODEX_HOME` when applicable). Empty for shared-state adapters. */
	env: Record<string, string>;
}

const OPTIONAL_DOTFILES = ['.gitconfig', '.npmrc'];

export function seedAdapterState(spec: AdapterSpec, roomDir: string): SeededAdapterState {
	if (spec.credentialFiles.length === 0) {
		return { mode: 'shared', homeStateDir: undefined, env: {} };
	}
	const home = join(roomDir, '.home');
	const stateRoot = spec.homeSubdir ? join(home, spec.homeSubdir) : home;
	mkdirSync(stateRoot, { recursive: true });

	const realStateDir = spec.realStateDir();
	let copiedAny = false;
	for (const relPath of spec.credentialFiles) {
		const src = join(realStateDir, relPath);
		if (!existsSync(src)) continue;
		const dest = join(stateRoot, relPath);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(src, dest);
		chmodSync(dest, 0o600);
		copiedAny = true;
	}
	if (!copiedAny) {
		// The adapter table declares a credential file, but this machine has
		// none yet (never logged in) — nothing to seed; fall back to shared so
		// `start` still works and the real login flow (if any) is unaffected.
		return { mode: 'shared', homeStateDir: undefined, env: {} };
	}

	// Best-effort dev ergonomics; never a credential, safe to share read-only-ish.
	for (const name of OPTIONAL_DOTFILES) {
		const src = join(homedir(), name);
		if (!existsSync(src)) continue;
		try {
			copyFileSync(src, join(home, name));
		} catch {
			/* best-effort only */
		}
	}

	const env: Record<string, string> = { HOME: home };
	if (spec.homeEnvVar) env[spec.homeEnvVar] = stateRoot;
	return { mode: 'seeded', homeStateDir: stateRoot, env };
}
