/**
 * Adapter -> spawn command table. Every entry is overridable by `--command`;
 * `custom` requires it. `systemPromptTransport` decides how acp-session.ts
 * delivers the standing preamble: `_meta` (Claude's `session/new._meta.systemPrompt`),
 * `top-level` (Goose's `params.systemPrompt`, falling back to `prefix` if
 * rejected), or `prefix` (first content block of the first `session/prompt`).
 *
 * Phase 8 additions: `credentialFiles`/`homeEnvVar`/`homeSubdir`/`realStateDir`
 * describe the generic per-room adapter-state seeding (adapter-state.ts) —
 * empty `credentialFiles` means the adapter has no documented credential file
 * and keeps its real, shared state dir (isolation level reads
 * `wrap-shared-state`, session 10). `writeNativeSandboxConfig` toggles the
 * adapter's OWN sandbox on (`prompt`, the only enforcement left) or off
 * (`wrap`/`container`, nested sandboxes are EPERM — red-team H4).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentHarnessIsolationLevel } from '../hub-relay-client.js';

export type AdapterId = 'claude' | 'codex' | 'cursor' | 'goose' | 'agy' | 'custom';
export type SystemPromptTransport = 'meta' | 'top-level' | 'prefix';

export interface NativeSandboxConfigParams {
	roomDir: string;
	/** `<workspace>/rooms` — the directory every sibling room lives under; denied to the adapter's own native sandbox under `prompt`. */
	roomsRoot: string;
	/** The per-room state dir this adapter was seeded into (`adapter-state.ts`), or `undefined` when it runs with shared/real state. */
	homeStateDir: string | undefined;
	level: AgentHarnessIsolationLevel;
}

export interface AdapterSpec {
	id: AdapterId;
	/** Human-readable pinned/tested version, printed by `doctor`. */
	testedVersion: string;
	command: string;
	args: string[];
	systemPromptTransport: SystemPromptTransport;
	/** Shown by `doctor` as the auth hint for this adapter. */
	authHint: string;
	/** How to get `command` onto PATH — printed when `start`/`doctor` cannot find it. */
	installHint: string;
	/**
	 * Declared (not yet verified) `loadSession` expectation, reported in
	 * `harness.hello` before the adapter has ever been spawned/initialized.
	 * The real capability from the adapter's `initialize` response is what
	 * actually gates `session/load` at runtime (acp-session.ts) — this is
	 * informational only, for the hub's connect message and `doctor`.
	 */
	expectedLoadSession: boolean;
	/**
	 * Phase-04: declared native mid-turn steer support, advertised in
	 * `harness.hello.steering` — informational only, never the runtime gate.
	 * `acp-extension` means the adapter is EXPECTED to answer
	 * `_session/steering`; the real per-process capability is what
	 * `AcpSession` captures from `InitializeResponse._meta.steering.supported`
	 * at `initialize` (never probed — codex-acp answers an unknown method with
	 * a bare `{}` success, which would be misread as delivered).
	 */
	steering: 'acp-extension' | 'none';
	/** Files (relative to `realStateDir()`) copied 0600 into a fresh per-room state dir. Empty = no known credential file. */
	credentialFiles: string[];
	/** Env var pointing this adapter at a per-room state dir; `undefined` = no dedicated var (generic `$HOME` only). */
	homeEnvVar?: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME';
	/** Subdirectory name (under the room's `.home/`) this adapter's state lives in, mirroring its real layout (e.g. `.claude`, `.codex`). */
	homeSubdir?: string;
	/** The adapter's real, global state dir today — source of `credentialFiles`, never mounted into a sandbox. */
	realStateDir: () => string;
	/** Writes (or removes) this adapter's own native-sandbox config for one room. No-op for adapters with no documented native sandbox. */
	writeNativeSandboxConfig: (params: NativeSandboxConfigParams) => void;
}

const NOOP_NATIVE_SANDBOX = (): void => undefined;

function writeClaudeSettings(params: NativeSandboxConfigParams): void {
	const settingsPath = join(params.roomDir, '.claude', 'settings.json');
	mkdirSync(dirname(settingsPath), { recursive: true });
	const sandbox =
		params.level === 'prompt'
			? { enabled: true, filesystem: { denyRead: [params.roomsRoot], allowRead: ['.'] } }
			: { enabled: false };
	writeFileSync(settingsPath, `${JSON.stringify({ sandbox }, null, 2)}\n`);
}

function writeCodexConfig(params: NativeSandboxConfigParams): void {
	// Codex reads `config.toml` from `$CODEX_HOME`; when this room shares the
	// real global Codex state (`homeStateDir` undefined — no credential file
	// seeded for it, which never happens for `codex` today but kept generic),
	// there is nowhere room-local to put this without touching the user's own
	// config, so it is skipped.
	if (!params.homeStateDir) return;
	mkdirSync(params.homeStateDir, { recursive: true });
	const configPath = join(params.homeStateDir, 'config.toml');
	const body =
		params.level === 'prompt'
			? `sandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nwritable_roots = ["${params.roomDir}"]\n`
			: `sandbox_mode = "danger-full-access"\n`;
	writeFileSync(configPath, body);
}

export const ADAPTER_TABLE: Record<AdapterId, AdapterSpec> = {
	claude: {
		id: 'claude',
		testedVersion: '0.76.x',
		command: 'claude-agent-acp',
		args: [],
		systemPromptTransport: 'meta',
		authHint: 'requires either an active `claude` CLI login or ANTHROPIC_API_KEY in the environment',
		installHint: 'npm install -g @zed-industries/claude-agent-acp',
		expectedLoadSession: true,
		steering: 'acp-extension',
		credentialFiles: ['.credentials.json'],
		homeEnvVar: 'CLAUDE_CONFIG_DIR',
		homeSubdir: '.claude',
		realStateDir: () => join(homedir(), '.claude'),
		writeNativeSandboxConfig: writeClaudeSettings,
	},
	codex: {
		id: 'codex',
		testedVersion: 'latest',
		command: 'codex-acp',
		args: [],
		systemPromptTransport: 'prefix',
		authHint: 'requires either OPENAI_API_KEY in the environment or a `codex` CLI login',
		installHint: 'npm install -g @zed-industries/codex-acp',
		expectedLoadSession: false,
		steering: 'acp-extension',
		credentialFiles: ['auth.json'],
		homeEnvVar: 'CODEX_HOME',
		homeSubdir: '.codex',
		realStateDir: () => join(homedir(), '.codex'),
		writeNativeSandboxConfig: writeCodexConfig,
	},
	cursor: {
		id: 'cursor',
		testedVersion: 'latest',
		command: 'agent',
		args: ['acp'],
		systemPromptTransport: 'prefix',
		authHint: 'requires the Cursor CLI (`agent`) to be logged in',
		installHint: 'curl https://cursor.com/install -fsS | bash',
		expectedLoadSession: false,
		steering: 'none',
		// No documented per-adapter credential file — keeps shared/real state;
		// isolation level for this adapter reads `wrap-shared-state` (session 10).
		credentialFiles: [],
		realStateDir: () => homedir(),
		writeNativeSandboxConfig: NOOP_NATIVE_SANDBOX,
	},
	goose: {
		id: 'goose',
		testedVersion: 'latest',
		command: 'goose',
		args: ['acp'],
		systemPromptTransport: 'top-level',
		authHint: 'requires goose to be configured with a provider; GOOSE_MODE=auto is recommended',
		installHint: 'see https://block.github.io/goose/docs/getting-started/installation',
		expectedLoadSession: false,
		// Goose's `_goose/unstable/session/steer` needs a run id from
		// `session/update` metadata that this bridge doesn't capture -- not
		// built (plan.md); the cancel+merge fallback covers Goose users.
		steering: 'none',
		credentialFiles: [],
		realStateDir: () => homedir(),
		writeNativeSandboxConfig: NOOP_NATIVE_SANDBOX,
	},
	agy: {
		id: 'agy',
		testedVersion: 'latest',
		// Google Antigravity `agy` has no native ACP mode; a community adapter wraps
		// its `--output-format=stream-json` headless mode (e.g. `agy-agent-acp`).
		// Override the concrete binary with `--command` until one is pinned.
		command: 'agy-agent-acp',
		args: [],
		systemPromptTransport: 'prefix',
		authHint: 'requires an Antigravity login in the system keyring (`agy auth`)',
		installHint: 'install a `agy` ACP adapter (e.g. npm i -g agy-agent-acp) and log in with `agy auth`',
		expectedLoadSession: false,
		steering: 'none',
		// agy keeps its auth in the OS keyring, so there is no credential file to
		// copy into the isolated home — shared/real state, like cursor.
		credentialFiles: [],
		realStateDir: () => homedir(),
		writeNativeSandboxConfig: NOOP_NATIVE_SANDBOX,
	},
	custom: {
		id: 'custom',
		testedVersion: 'n/a',
		command: '',
		args: [],
		systemPromptTransport: 'prefix',
		authHint: 'depends on the custom command supplied via --command',
		installHint: 'supply an executable on PATH via --command',
		expectedLoadSession: false,
		steering: 'none',
		credentialFiles: [],
		realStateDir: () => homedir(),
		writeNativeSandboxConfig: NOOP_NATIVE_SANDBOX,
	},
};

/** Resolves the spawn command/args for an adapter, honouring `--command` overrides. */
export function resolveAdapterCommand(
	adapterId: AdapterId,
	commandOverride: string | undefined,
): { command: string; args: string[] } {
	if (commandOverride) {
		const parts = commandOverride.trim().split(/\s+/).filter(Boolean);
		const [command, ...args] = parts;
		if (!command) throw new Error('--command must not be empty');
		return { command, args };
	}
	const spec = ADAPTER_TABLE[adapterId];
	if (adapterId === 'custom' && !spec.command) {
		throw new Error('--adapter custom requires --command "<bin> [args]"');
	}
	return { command: spec.command, args: [...spec.args] };
}

/** `true` once at least one file exists to seed a per-room state dir from (see `adapter-state.ts`). */
export function adapterHasCredentialFiles(spec: AdapterSpec): boolean {
	return spec.credentialFiles.length > 0 && existsSync(spec.realStateDir());
}
