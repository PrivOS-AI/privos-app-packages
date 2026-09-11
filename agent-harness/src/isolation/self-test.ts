/**
 * Self-test for a candidate isolation level (`doctor`, and `auto` at start —
 * red-team M3: never picks a level on binary presence alone). For a scratch
 * room, spawns a shell probe under the CANDIDATE WRAPPER (the exact
 * `wrapCommand` a real room would use) and asserts, from inside: can write
 * in the room, cannot read a sibling room, cannot read the real
 * `~/.privos`/`~/.claude` (only if they exist on this machine — never
 * created by the test), can read the shared `.privos/skills` +
 * `<workspace>/IDENTITY.md` (only if already installed), and that the
 * skill-sdk imports resolve.
 *
 * Deliberate simplification (ponytail): the plan's self-test description
 * spawns the REAL adapter and drives it through `initialize` + a
 * `session/prompt` that gets the model to run a shell command. Scripting
 * that deterministically would depend on the model actually choosing to run
 * a specific command — unreliable and costs real API/subscription usage on
 * every `auto` resolution and every `doctor` run. This runs the identical
 * boundary checks directly via `/bin/sh` under the same wrapper instead,
 * which validates exactly the OS-level mechanism (the thing that actually
 * varies per host) without going through the LLM. Upgrade path: an opt-in
 * `doctor --with-adapter` that also drives the real adapter once, for a
 * belt-and-braces check before a production rollout.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AdapterSpec } from '../acp/adapter-table.js';
import { wrapCommand } from './wrap-command.js';
import { seedAdapterState } from '../adapter-state.js';

export interface SelfTestCheck {
	/** `undefined` when the underlying resource (a real `~/.claude`, an installed skills bundle, ...) does not exist on this machine — soft-skipped, not a failure. */
	skipped: boolean;
	passed: boolean;
	detail: string;
}

export interface SelfTestResult {
	level: 'wrap' | 'container';
	passed: boolean;
	detail: string;
	checks: Record<string, SelfTestCheck>;
}

const PROBE_TIMEOUT_MS = 15_000;

function binaryAvailable(command: string, args: string[] = ['--version']): boolean {
	const result = spawnSync(command, args, { stdio: 'ignore', timeout: 5_000 });
	return result.error === undefined || (result.error as NodeJS.ErrnoException).code !== 'ENOENT';
}

function ok(passed: boolean, detail: string): SelfTestCheck {
	return { skipped: false, passed, detail };
}
const SKIPPED: SelfTestCheck = { skipped: true, passed: true, detail: 'resource not present on this machine — skipped' };

const PROBE_SCRIPT = `
set -u
touch "$SELF_TEST_ROOM/write-ok" 2>/dev/null && echo SELF_TEST:WRITE_OK || echo SELF_TEST:WRITE_FAIL
if [ -n "\${SELF_TEST_SIBLING_MARKER:-}" ]; then
  if cat "$SELF_TEST_SIBLING_MARKER" >/dev/null 2>&1; then echo SELF_TEST:SIBLING_READ_OK; else echo SELF_TEST:SIBLING_READ_DENIED; fi
fi
if [ -n "\${SELF_TEST_REAL_CLAUDE_PROBE:-}" ]; then
  if cat "$SELF_TEST_REAL_CLAUDE_PROBE" >/dev/null 2>&1; then echo SELF_TEST:REAL_CLAUDE_READ_OK; else echo SELF_TEST:REAL_CLAUDE_READ_DENIED; fi
fi
if [ -n "\${SELF_TEST_PRIVOS_CONFIG_PROBE:-}" ]; then
  if cat "$SELF_TEST_PRIVOS_CONFIG_PROBE" >/dev/null 2>&1; then echo SELF_TEST:PRIVOS_CONFIG_READ_OK; else echo SELF_TEST:PRIVOS_CONFIG_READ_DENIED; fi
fi
if [ -n "\${SELF_TEST_SKILLS_PROBE:-}" ]; then
  if cat "$SELF_TEST_SKILLS_PROBE" >/dev/null 2>&1; then echo SELF_TEST:SKILLS_READ_OK; else echo SELF_TEST:SKILLS_READ_DENIED; fi
fi
if [ -n "\${SELF_TEST_IDENTITY_PROBE:-}" ]; then
  if cat "$SELF_TEST_IDENTITY_PROBE" >/dev/null 2>&1; then echo SELF_TEST:IDENTITY_READ_OK; else echo SELF_TEST:IDENTITY_READ_DENIED; fi
fi
if [ -n "\${SELF_TEST_PYTHON_SDK_PROBE:-}" ] && command -v python3 >/dev/null 2>&1; then
  python3 -c "import privos_skill" >/dev/null 2>&1 && echo SELF_TEST:PYTHON_SDK_OK || echo SELF_TEST:PYTHON_SDK_FAIL
fi
if [ -n "\${SELF_TEST_NODE_SDK_PROBE:-}" ] && command -v node >/dev/null 2>&1; then
  node -e "require('@privos_ai/skill-sdk')" >/dev/null 2>&1 && echo SELF_TEST:NODE_SDK_OK || echo SELF_TEST:NODE_SDK_FAIL
fi
`;

function runProbe(
	level: 'wrap' | 'container',
	params: {
		workspaceDir: string;
		spec: AdapterSpec;
		containerImage: string;
		roomId: string;
		roomDir: string;
		homeDir: string | undefined;
		probeEnv: Record<string, string>;
	},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const bridgeNodeModulesDir = join(process.cwd(), 'node_modules');
	const { command, args, env: wrapperEnv } = wrapCommand({
		level,
		workspaceDir: params.workspaceDir,
		roomId: params.roomId,
		roomDir: params.roomDir,
		homeDir: params.homeDir,
		realHomeDir: homedir(),
		bridgeNodeModulesDir,
		containerImage: params.containerImage,
		command: 'sh',
		args: ['-c', PROBE_SCRIPT],
		// For `container`, this becomes the `-e KEY=VALUE` flags docker needs to
		// see the probe markers inside the container's own env; for `wrap` it is
		// unused (sandbox-exec/bwrap inherit the outer spawn's env directly).
		env: params.probeEnv,
	});
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: params.roomDir,
			env: { ...process.env, ...wrapperEnv, ...params.probeEnv },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
		const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS);
		timer.unref?.();
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}` });
		});
	});
}

function parseMarkers(stdout: string): Record<string, string> {
	const out: Record<string, string> = {};
	// Marker format is `SELF_TEST:NAME_STATUS`; split on the LAST underscore group
	// that is a known status word to avoid guessing name boundaries.
	const statusWords = ['OK', 'FAIL', 'DENIED'];
	for (const line of stdout.split('\n')) {
		const m = line.match(/^SELF_TEST:(.+)$/);
		if (!m?.[1]) continue;
		const token = m[1];
		const status = statusWords.find((s) => token.endsWith(`_${s}`));
		if (!status) continue;
		const name = token.slice(0, -(status.length + 1));
		out[name] = status;
	}
	return out;
}

export async function runSelfTest(
	level: 'wrap' | 'container',
	params: { workspaceDir: string; spec: AdapterSpec; hubUrl: string; containerImage: string; verbose?: boolean },
): Promise<SelfTestResult> {
	if (level === 'wrap') {
		if (platform() === 'darwin' && !binaryAvailable('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'])) {
			return { level, passed: false, detail: 'sandbox-exec is not usable on this host', checks: {} };
		}
		if (platform() === 'linux' && !binaryAvailable('bwrap')) {
			return { level, passed: false, detail: 'bwrap is not installed on this host', checks: {} };
		}
		if (platform() !== 'darwin' && platform() !== 'linux') {
			return { level, passed: false, detail: `no "wrap" implementation for platform "${platform()}"`, checks: {} };
		}
	} else {
		if (!binaryAvailable('docker', ['info'])) {
			return { level, passed: false, detail: 'docker is not installed or the daemon is unreachable', checks: {} };
		}
	}

	const roomsRoot = join(params.workspaceDir, 'rooms');
	mkdirSync(roomsRoot, { recursive: true });
	const suffix = randomUUID().slice(0, 8);
	const roomA = join(roomsRoot, `.self-test-a-${suffix}`);
	const roomB = join(roomsRoot, `.self-test-b-${suffix}`);
	mkdirSync(roomA, { recursive: true });
	mkdirSync(roomB, { recursive: true });
	const siblingMarker = join(roomB, 'marker.txt');
	writeFileSync(siblingMarker, 'sibling-room-secret');

	const homeState = seedAdapterState(params.spec, roomA);

	const realClaudeDir = join(homedir(), '.claude');
	const realClaudeProbe = existsSync(realClaudeDir) ? findAnyFile(realClaudeDir) : undefined;
	const privosConfigDir = join(homedir(), '.privos');
	const privosConfigProbe = existsSync(privosConfigDir) ? findAnyFile(privosConfigDir) : undefined;
	const skillsDir = join(params.workspaceDir, '.privos', 'skills');
	const skillsProbeFile = existsSync(skillsDir) ? findAnyFile(skillsDir) : undefined;
	const identityFile = join(params.workspaceDir, 'IDENTITY.md');
	const identityProbe = existsSync(identityFile) ? identityFile : undefined;
	const skillSdkPy = join(params.workspaceDir, '.privos', 'skill-sdk', 'privos_skill.py');
	const pythonSdkAvailable = existsSync(skillSdkPy);
	const nodeSdkAvailable = existsSync(join(process.cwd(), 'node_modules', '@privos_ai', 'skill-sdk'));

	try {
		const probeEnv: Record<string, string> = {
			SELF_TEST_ROOM: roomA,
			...(siblingMarker ? { SELF_TEST_SIBLING_MARKER: siblingMarker } : {}),
			...(realClaudeProbe ? { SELF_TEST_REAL_CLAUDE_PROBE: realClaudeProbe } : {}),
			...(privosConfigProbe ? { SELF_TEST_PRIVOS_CONFIG_PROBE: privosConfigProbe } : {}),
			...(skillsProbeFile ? { SELF_TEST_SKILLS_PROBE: skillsProbeFile } : {}),
			...(identityProbe ? { SELF_TEST_IDENTITY_PROBE: identityProbe } : {}),
			...(pythonSdkAvailable ? { SELF_TEST_PYTHON_SDK_PROBE: '1', PYTHONPATH: join(params.workspaceDir, '.privos', 'skill-sdk') } : {}),
			...(nodeSdkAvailable ? { SELF_TEST_NODE_SDK_PROBE: '1', NODE_PATH: join(process.cwd(), 'node_modules') } : {}),
			...homeState.env,
		};

		const { code, stdout, stderr } = await runProbe(level, {
			workspaceDir: params.workspaceDir,
			spec: params.spec,
			containerImage: params.containerImage,
			roomId: `.self-test-a-${suffix}`,
			roomDir: roomA,
			homeDir: homeState.homeStateDir ? join(roomA, '.home') : undefined,
			probeEnv,
		});
		const markers = parseMarkers(stdout);

		const checks: Record<string, SelfTestCheck> = {
			write: ok(markers.WRITE === 'OK', markers.WRITE === 'OK' ? 'wrote inside the room' : `could not write inside the room (exit ${code}; ${stderr.trim().slice(0, 300)})`),
			siblingRoomDenied: siblingMarker
				? ok(markers.SIBLING_READ === 'DENIED', `sibling room read: ${markers.SIBLING_READ ?? 'no result'}`)
				: SKIPPED,
			realClaudeDenied: realClaudeProbe ? ok(markers.REAL_CLAUDE_READ === 'DENIED', `real ~/.claude read: ${markers.REAL_CLAUDE_READ ?? 'no result'}`) : SKIPPED,
			privosConfigDenied: privosConfigProbe
				? ok(markers.PRIVOS_CONFIG_READ === 'DENIED', `real ~/.privos read: ${markers.PRIVOS_CONFIG_READ ?? 'no result'}`)
				: SKIPPED,
			skillsReadable: skillsProbeFile ? ok(markers.SKILLS_READ === 'OK', `shared skills read: ${markers.SKILLS_READ ?? 'no result'}`) : SKIPPED,
			identityReadable: identityProbe ? ok(markers.IDENTITY_READ === 'OK', `IDENTITY.md read: ${markers.IDENTITY_READ ?? 'no result'}`) : SKIPPED,
			pythonSkillSdk: pythonSdkAvailable ? ok(markers.PYTHON_SDK === 'OK', `python3 -c "import privos_skill": ${markers.PYTHON_SDK ?? 'no result'}`) : SKIPPED,
			nodeSkillSdk: nodeSdkAvailable ? ok(markers.NODE_SDK === 'OK', `node -e "require('@privos_ai/skill-sdk')": ${markers.NODE_SDK ?? 'no result'}`) : SKIPPED,
		};

		const passed = Object.values(checks).every((c) => c.skipped || c.passed);
		const failedNames = Object.entries(checks)
			.filter(([, c]) => !c.skipped && !c.passed)
			.map(([name]) => name);
		return {
			level,
			passed,
			detail: passed ? `${level} self-test passed` : `${level} self-test failed: ${failedNames.join(', ')}`,
			checks,
		};
	} finally {
		rmSync(roomA, { recursive: true, force: true });
		rmSync(roomB, { recursive: true, force: true });
	}
}

/** Finds any one regular file directly under `dir` (non-recursive is enough — we only need something to attempt a read of). */
function findAnyFile(dir: string): string | undefined {
	try {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isFile()) return full;
		}
	} catch {
		/* best-effort probe discovery only */
	}
	return undefined;
}
