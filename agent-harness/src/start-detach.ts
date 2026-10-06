/**
 * `start --detach` — re-launches the bridge in its own session and returns.
 *
 * The bridge is a long-lived process, and whoever launches it decides how long
 * it lives. When an AI harness (Claude Code, OpenClaw, Hermes, ...) pairs an
 * agent on the owner's behalf it runs `start` through its own exec tool, so a
 * plain background job becomes a child of that tool: OpenClaw reaps it after
 * `tools.exec.timeoutSeconds` (30 min by default), Hermes ends it with the
 * session. `--detach` moves the bridge out of that process tree (`setsid`
 * semantics via `detached: true`, stdio to a log file, parent `unref`'d) so it
 * outlives the launcher. It is the fallback for hosts without systemd;
 * `service install` remains the recommended way to run the bridge because a
 * service manager also restarts it after a crash or reboot, which `--detach`
 * does not.
 *
 * Pure helpers (`buildDetachedArgv`, `detachedLogPath`) are separated from
 * the one function that spawns, so the argv rewrite is unit-testable.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DETACH_FLAG = '--detach';

/**
 * The argv the detached child runs: the launcher's argv minus `--detach`, so
 * the child serves turns in the foreground of its own session instead of
 * detaching again. Every other flag is preserved verbatim.
 */
export function buildDetachedArgv(argv: readonly string[]): string[] {
	return argv.filter((arg) => arg !== DETACH_FLAG);
}

/** Where the detached bridge writes stdout+stderr: next to the rooms, so `service`/`start` logs stay per agent. */
export function detachedLogPath(workspaceDir: string): string {
	return join(workspaceDir, 'bridge.log');
}

export interface SpawnDetachedInput {
	/** Absolute node binary (usually `process.execPath`). */
	nodePath: string;
	/** Absolute bridge entry script (usually `process.argv[1]`). */
	scriptPath: string;
	/** The `start ...` argv for the child (already stripped of `--detach`). */
	args: readonly string[];
	/** Log file the child's stdout and stderr are appended to. */
	logPath: string;
}

/**
 * Spawns the child in its own session with stdio redirected to `logPath` and
 * lets the parent exit without waiting for it. Returns the child's pid.
 */
export function spawnDetached(input: SpawnDetachedInput): number {
	mkdirSync(dirname(input.logPath), { recursive: true });
	const logFd = openSync(input.logPath, 'a');
	const child = spawn(input.nodePath, [input.scriptPath, ...input.args], {
		detached: true,
		stdio: ['ignore', logFd, logFd],
		env: process.env,
	});
	child.unref();
	if (child.pid === undefined) throw new Error('could not spawn the detached bridge process');
	return child.pid;
}
