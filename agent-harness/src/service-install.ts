/**
 * `service install|uninstall|status` — runs the bridge as a **systemd user
 * service** so it survives logout/reboot and restarts on failure, without the
 * operator hand-writing a unit (and getting the node/adapter PATH wrong, which
 * is the usual failure).
 *
 * User service (not system): it inherits the operator's own `~/.claude`
 * pairing/login and the bridge's per-agent config under `$HOME`, which a
 * root/other-user system unit would not see. `loginctl enable-linger` keeps it
 * running with no active login session.
 *
 * The unit builder (`buildSystemdUnit`) is pure and testable; only
 * `installSystemdService`/`uninstallSystemdService` touch disk and `systemctl`.
 * Linux-only for install (systemd); `--print` emits the unit on any platform so
 * a macOS operator can adapt it to launchd.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { homedir, userInfo, platform } from 'node:os';
import { dirname, join } from 'node:path';

export interface SystemdUnitParams {
	/** Human description line; the agent id is embedded so multiple services are distinguishable. */
	agentId: string;
	/** Absolute node binary that runs the bridge (usually `process.execPath`). */
	nodePath: string;
	/** Absolute path to the bridge entry script (usually `process.argv[1]`). */
	scriptPath: string;
	/** The `start ...` argv (everything after the script path). */
	startArgs: string[];
	/** Directories to prepend to the unit's `PATH` (node bin dir + the adapter's dir), before the system defaults. */
	pathDirs: string[];
	/** Optional env file (secrets like ANTHROPIC_API_KEY) — referenced with a leading `-` so a missing file is not fatal. */
	envFile: string;
}

/** Shell-quotes a single argv token for an `ExecStart=` line (systemd splits on spaces unless quoted). */
function quoteArg(arg: string): string {
	return /[^A-Za-z0-9_@%+=:,./-]/.test(arg) ? `"${arg.replace(/(["\\])/g, '\\$1')}"` : arg;
}

/** Builds the full `.service` unit text. Pure — no IO. */
export function buildSystemdUnit(params: SystemdUnitParams): string {
	const defaultPath = ['/usr/local/bin', '/usr/bin', '/bin'];
	// Prepend caller dirs, drop dupes/empties, keep first occurrence order.
	const seen = new Set<string>();
	const pathValue = [...params.pathDirs, ...defaultPath].filter((d) => d && !seen.has(d) && (seen.add(d), true)).join(':');
	const execStart = [params.nodePath, params.scriptPath, ...params.startArgs].map(quoteArg).join(' ');
	return `[Unit]
Description=PrivOS agent-harness bridge (agent ${params.agentId})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=${pathValue}
EnvironmentFile=-${params.envFile}
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5

[Install]
WantedBy=default.target
`;
}

/** `~/.config/systemd/user/<name>.service` */
function unitPath(unitName: string): string {
	return join(homedir(), '.config', 'systemd', 'user', `${unitName}.service`);
}

/** Resolves the directory containing `command` on PATH, or `undefined` if not found (so the unit's PATH can include the adapter's dir). */
function commandDir(command: string): string | undefined {
	const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf-8', timeout: 5_000 });
	if (res.status !== 0 || !res.stdout) return undefined;
	const first = res.stdout.split('\n')[0]?.trim();
	return first ? dirname(first) : undefined;
}

export interface ServiceInstallInput {
	agentId: string;
	unitName: string;
	/** The `start ...` argv this service should run. */
	startArgs: string[];
	/** Adapter spawn command, resolved to a PATH dir for the unit. */
	adapterCommand: string;
	/** Run `loginctl enable-linger` so the service survives logout. */
	linger: boolean;
	/** Run `systemctl --user enable --now` after writing the unit. */
	enable: boolean;
	/** Print the unit to stdout instead of writing/enabling (works on any platform). */
	print: boolean;
}

/** Writes + enables the systemd user unit. Returns the path written (or undefined for `--print`). */
export function installSystemdService(input: ServiceInstallInput): string | undefined {
	const nodePath = process.execPath;
	const scriptPath = process.argv[1] ?? '';
	const pathDirs = [dirname(nodePath), commandDir(input.adapterCommand)].filter((d): d is string => Boolean(d));
	const envFile = join(homedir(), '.config', `${input.unitName}.env`);
	const unit = buildSystemdUnit({ agentId: input.agentId, nodePath, scriptPath, startArgs: input.startArgs, pathDirs, envFile });

	if (input.print) {
		process.stdout.write(unit);
		return undefined;
	}
	if (platform() !== 'linux') {
		throw new Error(`"service install" installs a systemd user unit and only runs on Linux. On ${platform()} run "service install --print" and adapt the output to your init system (e.g. launchd).`);
	}

	const path = unitPath(input.unitName);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, unit, { mode: 0o644 });
	process.stdout.write(`wrote ${path}\n`);

	if (input.linger) {
		const linger = spawnSync('loginctl', ['enable-linger', userInfo().username], { encoding: 'utf-8', timeout: 10_000 });
		if (linger.status !== 0) {
			process.stderr.write(`warning: could not enable linger (service will stop at logout): ${(linger.stderr || linger.error?.message || '').trim()}\n`);
		}
	}
	runSystemctl(['daemon-reload']);
	if (input.enable) {
		runSystemctl(['enable', '--now', input.unitName]);
		process.stdout.write(`\nstarted. Follow logs with:\n  journalctl --user -u ${input.unitName} -f\n`);
	} else {
		process.stdout.write(`\ninstalled (not started). Start it with:\n  systemctl --user enable --now ${input.unitName}\n`);
	}
	process.stdout.write(`\nAuth: put ANTHROPIC_API_KEY (or the adapter's key) in ${envFile} (chmod 600), or ensure an active adapter CLI login exists for this user.\n`);
	return path;
}

export function uninstallSystemdService(unitName: string): void {
	if (platform() !== 'linux') throw new Error('"service uninstall" only runs on Linux (systemd).');
	// `disable --now` stops and removes the enable symlink; ignore failure if it was never enabled.
	runSystemctl(['disable', '--now', unitName], { allowFailure: true });
	const path = unitPath(unitName);
	if (existsSync(path)) {
		rmSync(path, { force: true });
		process.stdout.write(`removed ${path}\n`);
	} else {
		process.stdout.write(`no unit at ${path}\n`);
	}
	runSystemctl(['daemon-reload']);
}

export function statusSystemdService(unitName: string): void {
	if (platform() !== 'linux') throw new Error('"service status" only runs on Linux (systemd).');
	const res = spawnSync('systemctl', ['--user', '--no-pager', 'status', unitName], { stdio: 'inherit' });
	// `status` exits non-zero for a stopped/failed unit — that is informational, not an error to throw on.
	if (res.error) throw res.error;
}

function runSystemctl(args: string[], opts: { allowFailure?: boolean } = {}): void {
	const res = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf-8', timeout: 15_000 });
	if (res.status !== 0 && !opts.allowFailure) {
		throw new Error(`systemctl --user ${args.join(' ')} failed: ${(res.stderr || res.error?.message || '').trim()}`);
	}
}

/** Default unit name for an agent: stable, filesystem-safe, and unique per agent. */
export function defaultUnitName(agentId: string): string {
	return `privos-agent-harness-${agentId}`.replace(/[^A-Za-z0-9_.-]/g, '-');
}
