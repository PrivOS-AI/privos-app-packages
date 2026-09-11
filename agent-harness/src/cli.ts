#!/usr/bin/env node
/**
 * `privos-agent-harness` — pairs with a hub, holds the outbound relay, and
 * drives a local ACP coding agent for one harness-runtime hub agent.
 * Commands: pair | start | status | doctor. See README.md for the security
 * model (default `--permissions auto` runs tool calls unattended).
 */
import { homedir, hostname } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { AcpSession } from './acp/acp-session.js';
import { ADAPTER_TABLE, resolveAdapterCommand, type AdapterId, type AdapterSpec } from './acp/adapter-table.js';
import type { PermissionPolicy } from './acp/permission-policy.js';
import { loadConfig, resolveAgentId, saveConfig, type AgentHarnessRespondTo } from './config-store.js';
import {
	HubRelayClient,
	probeUpgradeStatus,
	type AgentHarnessIsolationLevel,
} from './hub-relay-client.js';
import { resetAllSessions } from './session-store.js';
import {
	buildBundleFromLocalCheckout,
	downloadSkillsBundle,
	installSkillsBundle,
	listInstalledSkills,
	materializeRoomDir,
	materializeWorkspaceRoot,
	pruneRoomDirs,
	setRoomBusy,
	SkillsLocallyModifiedError,
	SkillsUpdateBusyError,
	writeHarnessEnvFile,
} from './skills-installer.js';
import { TurnRunner } from './turn-runner.js';
import { AdapterPool, type PooledSession } from './adapter-pool.js';
import { seedAdapterState } from './adapter-state.js';
import { resolveIsolation, runSelfTest, wrapCommand, type BaseIsolationLevel } from './isolation/index.js';
import { redact } from './redact.js';
import { BRIDGE_VERSION } from './version.js';

/** Pool cap 8 / idle reap 10 min — fixed by user decision (validation session 10), not a CLI knob. */
const ROOM_IDLE_REAP_MS = 10 * 60 * 1000;
const DEFAULT_CONTAINER_IMAGE = 'node:22-bookworm';

/** Default per-agent workspace: `~/privos-harness/<agentId>`, outside the hidden bridge config dir. */
function defaultWorkspaceDir(agentId: string): string {
	return join(process.env.HOME ?? process.env.USERPROFILE ?? '.', 'privos-harness', agentId);
}

/**
 * Downloads (or builds, for `--skills-dir`) and installs the PrivOS skills
 * bundle into `workspaceDir`. Best-effort and never throws: a hub with no
 * workspace sandbox configured, a network hiccup, or a locally-modified
 * skill (without `--force`) all print a message and leave the caller's flow
 * (`pair`/`start`/`skills`) uninterrupted.
 */
async function autoInstallSkills(params: {
	workspaceDir: string;
	source: { kind: 'url'; url: string; headers?: Record<string, string> } | { kind: 'local'; dir: string };
	mode: 'install' | 'update';
	force?: boolean;
}): Promise<void> {
	try {
		const buffer =
			params.source.kind === 'local'
				? await buildBundleFromLocalCheckout(params.source.dir)
				: await downloadSkillsBundle(params.source.url, params.source.headers);
		if (!buffer) {
			console.log('Skills bundle is not available from this hub yet; skipping (re-run "skills update" once it is).');
			return;
		}
		mkdirSync(params.workspaceDir, { recursive: true });
		const result = await installSkillsBundle(buffer, params.workspaceDir, { mode: params.mode, force: params.force });
		if (!result.installed) {
			console.log(`Skills already up to date (sandbox ${result.sandboxVersion}).`);
		} else {
			console.log(`Skills ${params.mode === 'install' ? 'installed' : 'updated'}: ${result.skillNames.length} skills (sandbox ${result.sandboxVersion}).`);
		}
	} catch (error) {
		if (error instanceof SkillsLocallyModifiedError || error instanceof SkillsUpdateBusyError) {
			console.log(`Skills update skipped: ${error.message}`);
			return;
		}
		console.log(`Skills install/update failed (${error instanceof Error ? error.message : String(error)}); continuing without updating skills.`);
	}
}

const ADAPTER_IDS = Object.keys(ADAPTER_TABLE) as AdapterId[];
const ISOLATION_FLAGS = ['auto', 'wrap', 'container', 'prompt', 'none'] as const;
const PERMISSION_POLICIES: PermissionPolicy[] = ['auto', 'safe', 'deny'];

function fail(message: string): never {
	process.stderr.write(`${redact(message)}\n`);
	process.exit(1);
}

function isLocalhostHttp(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1');
	} catch {
		return false;
	}
}

function assertSecureUrl(url: string, insecure: boolean, label: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		fail(`${label} is not a valid URL: ${url}`);
	}
	if (parsed.protocol === 'http:' && !isLocalhostHttp(url) && !insecure) {
		fail(`${label} uses plain http:// to a non-localhost host. Pass --insecure if this is intentional.`);
	}
}

// ---------------------------------------------------------------------------
// pair
// ---------------------------------------------------------------------------

interface PairingGuide {
	steps: string[];
	isolationAdvice: string;
	keysUrl: string;
	skillsUrl?: string;
	respondTo: AgentHarnessRespondTo;
}

interface PairingKeys {
	agentId: string;
	hubUrl: string;
	botToken: string;
	agentRoomId: string;
}

// The hub reports a machine-readable pairing failure in the `errorType` field
// (the `error` field is a human message). See agent-harness-pairing-endpoints.ts.
function isPairingErrorCode(body: unknown, code: string): boolean {
	return typeof body === 'object' && body !== null && 'errorType' in body && (body as { errorType?: unknown }).errorType === code;
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
	const res = await fetch(url);
	const body = await res.json().catch(() => undefined);
	return { status: res.status, body };
}

function parsePairingGuide(body: unknown): PairingGuide {
	if (typeof body !== 'object' || body === null) throw new Error('Pairing guide response was not a JSON object.');
	const b = body as Record<string, unknown>;
	// The guide carries the keys/skills links, the steps and isolation advice,
	// and who may drive the agent. agentId/hubUrl/token come from the keys link.
	if (typeof b.keysUrl !== 'string') {
		throw new Error('Pairing guide response is missing keysUrl.');
	}
	const respondTo = b.respondTo;
	return {
		steps: Array.isArray(b.steps) ? b.steps.filter((s): s is string => typeof s === 'string') : [],
		isolationAdvice: typeof b.isolationAdvice === 'string' ? b.isolationAdvice : '',
		keysUrl: b.keysUrl,
		skillsUrl: typeof b.skillsUrl === 'string' ? b.skillsUrl : undefined,
		respondTo: respondTo === 'owner' || respondTo === 'agent-room-members' || respondTo === 'everyone' ? respondTo : 'owner',
	};
}

function parsePairingKeys(body: unknown): PairingKeys {
	if (typeof body !== 'object' || body === null) throw new Error('Pairing keys response was not a JSON object.');
	const b = body as Record<string, unknown>;
	if (typeof b.agentId !== 'string' || typeof b.hubUrl !== 'string' || typeof b.botToken !== 'string' || typeof b.agentRoomId !== 'string') {
		throw new Error('Pairing keys response is missing agentId, hubUrl, botToken, or agentRoomId.');
	}
	return { agentId: b.agentId, hubUrl: b.hubUrl, botToken: b.botToken, agentRoomId: b.agentRoomId };
}

async function runPair(guideUrl: string, options: { insecure?: boolean; noSkills?: boolean; skillsDir?: string }): Promise<void> {
	assertSecureUrl(guideUrl, Boolean(options.insecure), 'guideUrl');

	const guideResponse = await fetchJson(guideUrl).catch((error: unknown) => {
		fail(`Could not reach the pairing guide: ${error instanceof Error ? error.message : String(error)}`);
	});
	if (guideResponse.status === 404 || guideResponse.status === 410 || isPairingErrorCode(guideResponse.body, 'pairing_expired')) {
		fail('This pairing link has expired (links are valid for 5 minutes). Ask the owner to run "Rotate harness pairing" in Agent Settings and try again.');
	}
	if (guideResponse.status !== 200) fail(`Pairing guide request failed with HTTP ${guideResponse.status}.`);
	const guide = parsePairingGuide(guideResponse.body);

	console.log('PrivOS agent-harness pairing');
	console.log('============================');
	for (const [i, step] of guide.steps.entries()) console.log(`${i + 1}. ${step}`);
	if (guide.isolationAdvice) {
		console.log('\nIsolation advice:');
		console.log(guide.isolationAdvice);
	}
	console.log('');

	assertSecureUrl(guide.keysUrl, Boolean(options.insecure), 'the pairing keys link');
	const keysResponse = await fetchJson(guide.keysUrl).catch((error: unknown) => {
		fail(`Could not retrieve pairing keys: ${error instanceof Error ? error.message : String(error)}`);
	});
	if (isPairingErrorCode(keysResponse.body, 'pairing_expired')) {
		fail('This pairing link has expired. Ask the owner to run "Rotate harness pairing" in Agent Settings and try again.');
	}
	if (isPairingErrorCode(keysResponse.body, 'pairing_keys_already_retrieved')) {
		fail(
			'This pairing link\'s one-time keys were already retrieved by another "pair" run. ' +
				'Ask the owner to run "Rotate harness pairing" in Agent Settings to issue a fresh link.',
		);
	}
	if (keysResponse.status !== 200) fail(`Pairing keys request failed with HTTP ${keysResponse.status}.`);
	const keys = parsePairingKeys(keysResponse.body);

	if (!options.noSkills && (options.skillsDir || guide.skillsUrl)) {
		await autoInstallSkills({
			workspaceDir: defaultWorkspaceDir(keys.agentId),
			source: options.skillsDir ? { kind: 'local', dir: options.skillsDir } : { kind: 'url', url: guide.skillsUrl! },
			mode: 'install',
		});
	}

	const path = saveConfig({
		agentId: keys.agentId,
		hubUrl: keys.hubUrl,
		botToken: keys.botToken,
		agentRoomId: keys.agentRoomId,
		respondTo: guide.respondTo,
		guideUrl,
		pairedAt: new Date().toISOString(),
	});
	console.log(`Paired. Config written to ${path} (mode 0600).`);
	console.log(`Run: privos-agent-harness start --agent ${keys.agentId}`);
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

/**
 * Reports the level actually observed for THIS adapter: `wrap`/`container`
 * downgrade to `wrap-shared-state` when the adapter has no documented
 * credential file to seed a per-room state dir from (session 10) — file
 * isolation still holds, only the adapter's own credential/config state is
 * shared, same as an unsandboxed run.
 */
function reportedIsolationLevel(base: BaseIsolationLevel, spec: AdapterSpec): AgentHarnessIsolationLevel {
	if ((base === 'wrap' || base === 'container') && spec.credentialFiles.length === 0) return 'wrap-shared-state';
	return base;
}

interface StartOptions {
	agent?: string;
	adapter: AdapterId;
	command?: string;
	workspace?: string;
	isolation: (typeof ISOLATION_FLAGS)[number];
	maxRooms: string;
	containerImage: string;
	permissions: PermissionPolicy;
	idleTimeout: string;
	resetSession?: boolean;
	insecure?: boolean;
	verbose?: boolean;
	noSkills?: boolean;
	skillsDir?: string;
}

async function runStart(options: StartOptions): Promise<void> {
	const agentId = resolveAgentId(options.agent);
	const config = loadConfig(agentId);
	assertSecureUrl(config.hubUrl, Boolean(options.insecure), 'the paired hubUrl');

	if (options.resetSession) resetAllSessions(agentId);

	const workspaceDir = options.workspace ?? defaultWorkspaceDir(agentId);
	mkdirSync(workspaceDir, { recursive: true });
	materializeWorkspaceRoot(workspaceDir);

	writeHarnessEnvFile(workspaceDir, {
		PRIVOS_URL: config.hubUrl,
		PRIVOS_BOT_KEY: config.botToken,
		PRIVOS_BOT_ID: agentId,
		PRIVOS_ROOM_ID: config.agentRoomId,
		PRIVOS_PROJECT_ID: agentId,
	});

	if (!options.noSkills) {
		await autoInstallSkills({
			workspaceDir,
			source: options.skillsDir
				? { kind: 'local', dir: options.skillsDir }
				: { kind: 'url', url: `${config.hubUrl.replace(/\/+$/, '')}/api/v1/agents.harness.skills`, headers: { Authorization: `Bearer ${config.botToken}` } },
			mode: 'update',
		});
	}
	const installedSkills = listInstalledSkills(workspaceDir);

	const { command, args } = resolveAdapterCommand(options.adapter, options.command);
	const spec = { ...ADAPTER_TABLE[options.adapter], command, args };
	const maxRooms = Number(options.maxRooms);
	if (!Number.isFinite(maxRooms) || maxRooms < 1) fail('--max-rooms must be a positive integer.');
	const idleTimeoutMs = Number(options.idleTimeout) * 1000;
	if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) fail('--idle-timeout must be a positive number of seconds.');

	console.log(`agent-harness ${BRIDGE_VERSION} starting`);
	console.log(`  agent:       ${agentId}`);
	console.log(`  adapter:     ${options.adapter} (${command}${args.length ? ` ${args.join(' ')}` : ''})`);
	console.log(`  workspace:   ${workspaceDir}`);
	console.log(`  permissions: ${options.permissions}`);
	console.log(`  max-rooms:   ${maxRooms}`);
	if (options.permissions === 'auto') {
		console.log('\x1b[31mWARNING: --permissions auto runs every tool call the agent requests unattended on this machine.\x1b[0m');
		console.log('\x1b[31m         Use --permissions safe or --permissions deny for untrusted rooms.\x1b[0m');
	}

	console.log(`  resolving isolation (${options.isolation})...`);
	const { level: baseLevel, selfTests } = await resolveIsolation({
		requested: options.isolation,
		workspaceDir,
		spec,
		hubUrl: config.hubUrl,
		containerImage: options.containerImage,
		verbose: options.verbose,
	});
	for (const t of selfTests) console.log(`    ${t.level}: ${t.detail}`);
	const reportedLevel = reportedIsolationLevel(baseLevel, spec);
	console.log(`  isolation:   ${reportedLevel}${reportedLevel !== baseLevel ? ` (base ${baseLevel})` : ''}`);
	if (reportedLevel === 'prompt' || reportedLevel === 'none') {
		console.log(
			`\x1b[33mWARNING: isolation "${reportedLevel}" gives rooms no OS-level file boundary; a room's own process can read/write sibling rooms.\x1b[0m`,
		);
	}

	// Prune stale room dirs before serving anything — nothing is "live" yet.
	pruneRoomDirs(workspaceDir, new Set());

	const baseEnv: NodeJS.ProcessEnv = { ...process.env, PRIVOS_AGENT_HARNESS: '1' };
	// Skill scripts `from privos_skill import hub` / `require('@privos_ai/skill-sdk')`;
	// PYTHONPATH points at this workspace's shared install, NODE_PATH at the
	// bridge's own node_modules (where those two npm deps actually live) so
	// `require` resolves them from any skill script's cwd. `PRIVOS_SANDBOX_MODE`
	// is never set — the skills' own dual-mode env check already falls back to
	// `PRIVOS_URL`/`PRIVOS_BOT_KEY` when it's absent.
	const bridgeNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url));
	const skillSdkPythonPath = join(workspaceDir, '.privos', 'skill-sdk');
	baseEnv.PYTHONPATH = [skillSdkPythonPath, baseEnv.PYTHONPATH].filter(Boolean).join(':');
	baseEnv.NODE_PATH = [bridgeNodeModules, baseEnv.NODE_PATH].filter(Boolean).join(':');

	// Filled in once `harness.hello`'s result carries a `connectUrl` (see the
	// polling loop below) — read fresh by every room spawned after that point.
	let connectUrl: string | undefined;

	function createRoomSession(roomId: string): PooledSession {
		const roomDir = materializeRoomDir(workspaceDir, roomId);
		const roomsRoot = join(workspaceDir, 'rooms');
		const homeState = seedAdapterState(spec, roomDir);
		const homeDir = homeState.mode === 'seeded' ? join(roomDir, '.home') : undefined;
		spec.writeNativeSandboxConfig({ roomDir, roomsRoot, homeStateDir: homeState.homeStateDir, level: baseLevel });
		// The credential + room identity the PrivOS skill SDK reads. It reads the
		// PROCESS env only (privos_skill.py / @privos_ai/skill-sdk never load the
		// .env file), so these MUST go on the adapter subprocess env below — the
		// .env file is written from the same map only for humans / scripts that
		// `source` it. Bridge-managed values win over any inherited ones.
		const roomPrivosEnv = {
			PRIVOS_URL: config.hubUrl,
			PRIVOS_BOT_KEY: config.botToken,
			PRIVOS_BOT_ID: agentId,
			PRIVOS_ROOM_ID: roomId,
			PRIVOS_PROJECT_ID: agentId,
			...(connectUrl !== undefined && { PRIVOS_CONNECT_URL: connectUrl }),
		};
		writeHarnessEnvFile(roomDir, roomPrivosEnv);

		let roomCommand = command;
		let roomArgs = args;
		let roomEnv: NodeJS.ProcessEnv = { ...baseEnv, ...homeState.env, ...roomPrivosEnv };
		if (baseLevel === 'wrap' || baseLevel === 'container') {
			const wrapped = wrapCommand({
				level: baseLevel,
				workspaceDir,
				roomId,
				roomDir,
				homeDir,
				realHomeDir: homedir(),
				bridgeNodeModulesDir: bridgeNodeModules,
				containerImage: options.containerImage,
				command,
				args,
				env: roomEnv as Record<string, string>,
			});
			roomCommand = wrapped.command;
			roomArgs = wrapped.args;
			roomEnv = { ...roomEnv, ...wrapped.env };
		}

		return new AcpSession(
			{ ...spec, command: roomCommand, args: roomArgs },
			{ cwd: roomDir, env: roomEnv, verbose: Boolean(options.verbose), isolation: reportedLevel },
		);
	}

	const pool = new AdapterPool({
		maxRooms,
		idleReapMs: ROOM_IDLE_REAP_MS,
		createSession: createRoomSession,
		onReap: (roomId, reason) => {
			if (options.verbose) console.error(`[agent-harness] reaped room ${roomId} (${reason})`);
		},
		onBusyChange: (roomId, busy) => setRoomBusy(workspaceDir, roomId, busy),
	});

	const relay = new HubRelayClient({
		hubUrl: config.hubUrl,
		botToken: config.botToken,
		insecure: options.insecure,
		verbose: options.verbose,
		hello: {
			adapter: options.adapter,
			bridgeVersion: BRIDGE_VERSION,
			hostname: hostname(),
			cwd: workspaceDir,
			permissions: options.permissions,
			isolation: reportedLevel,
			...(installedSkills && { skillsManifest: { sandboxVersion: installedSkills.sandboxVersion } }),
			capabilities: { loadSession: ADAPTER_TABLE[options.adapter].expectedLoadSession },
			steering: ADAPTER_TABLE[options.adapter].steering === 'acp-extension',
		},
		handlers: {
			onTurnStart: (params) => turnRunner.onTurnStart(params),
			onTurnCancel: (params) => turnRunner.onTurnCancel(params),
			onTurnSteer: (params) => turnRunner.onTurnSteer(params),
			onResetSessions: () => turnRunner.onResetSessions(),
			onConnectionChange: (connected) => turnRunner.onConnectionChange(connected),
		},
	});

	const turnRunner = new TurnRunner({
		agentId,
		session: pool,
		policy: options.permissions,
		idleTimeoutMs,
		verbose: options.verbose,
		adapterId: options.adapter,
		roomDir: (roomId) => join(workspaceDir, 'rooms', roomId),
		workspaceDir,
	});
	turnRunner.attachRelay(relay);

	relay.start();
	// `harness.hello`'s result (agentRoomId/connectUrl/respondTo) only resolves
	// after the round trip completes, asynchronously past `relay.start()`.
	// Every room spawned after `connectUrl` resolves picks it up automatically
	// (read fresh in `createRoomSession`); already-running rooms keep the
	// value they started with until their next spawn. Gives up silently after
	// 5s; a hub with no PRIVOS_CONNECT_URL configured never sets it at all.
	void (async () => {
		for (let attempt = 0; attempt < 20; attempt++) {
			if (relay.hello?.connectUrl) {
				connectUrl = relay.hello.connectUrl;
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	})();
	void relay.whenTerminal.then((reason) => {
		const message =
			reason.kind === 'replaced'
				? `Connection replaced${reason.hostname ? ` by ${reason.hostname}` : ''} — another bridge took over this agent's pairing.`
				: reason.kind === 'revoked'
					? 'Bot key rotated or revoked — run "pair" again with a fresh guideline URL.'
					: reason.kind === 'not_a_harness_agent'
						? 'This agent is no longer a harness agent (runtime switch?). Nothing to connect to.'
						: 'Connection rejected as unauthorized.';
		console.error(`\n${message}`);
		void pool.dispose().finally(() => process.exit(1));
	});

	const shutdown = () => {
		console.log('\nShutting down...');
		relay.stop();
		void pool.dispose().finally(() => process.exit(0));
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);

	// Keep the process alive until whenTerminal / a signal ends it.
	await new Promise<void>(() => undefined);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function runStatus(options: { agent?: string }): Promise<void> {
	const agentId = resolveAgentId(options.agent);
	const config = loadConfig(agentId);
	console.log(`agent:      ${agentId}`);
	console.log(`hub:        ${config.hubUrl}`);
	console.log(`agentRoom:  ${config.agentRoomId}`);
	console.log(`respondTo:  ${config.respondTo}`);
	console.log(`pairedAt:   ${config.pairedAt}`);
	try {
		const res = await fetch(config.hubUrl, { method: 'GET' });
		console.log(`hub reachable: yes (HTTP ${res.status})`);
	} catch {
		console.log('hub reachable: no');
	}
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

function isCommandOnPath(command: string): boolean {
	const result = spawnSync(command, ['--help'], { stdio: 'ignore', timeout: 5_000 });
	return result.error === undefined || (result.error as NodeJS.ErrnoException).code !== 'ENOENT';
}

/** Runs `command --version`, returning trimmed stdout/stderr, or `undefined` if the command isn't found. */
function commandVersionOutput(command: string, args: string[]): string | undefined {
	const result = spawnSync(command, args, { encoding: 'utf-8', timeout: 5_000 });
	if (result.error) return undefined;
	return (result.stdout || result.stderr || '').trim();
}

function parseMajorMinor(versionText: string): { major: number; minor: number } | undefined {
	const match = versionText.match(/(\d+)\.(\d+)/);
	if (!match) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]) };
}

function lastLine(text: string): string {
	return text.trim().split('\n').pop() ?? '';
}

async function runDoctor(options: { agent?: string; adapter: AdapterId; command?: string; workspace?: string; containerImage?: string }): Promise<void> {
	const spec = ADAPTER_TABLE[options.adapter];
	console.log(`adapter:      ${options.adapter} (tested ${spec.testedVersion})`);
	console.log(`auth hint:    ${spec.authHint}`);

	let command: string;
	try {
		({ command } = resolveAdapterCommand(options.adapter, options.command));
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	console.log(`command:      ${command} — ${isCommandOnPath(command) ? 'found on PATH' : 'NOT FOUND on PATH'}`);

	console.log('');
	console.log('runtime checks (python3 >= 3.9, node >= 22, bash — required by the PrivOS skills):');
	const python3Version = commandVersionOutput('python3', ['--version']);
	const python3Parsed = python3Version ? parseMajorMinor(python3Version) : undefined;
	const python3Ok = python3Parsed !== undefined && (python3Parsed.major > 3 || (python3Parsed.major === 3 && python3Parsed.minor >= 9));
	console.log(`  python3:  ${python3Version ? `${python3Version}${python3Ok ? ' (OK)' : ' (need >= 3.9)'}` : 'NOT FOUND on PATH'}`);

	const nodeVersionRaw = commandVersionOutput('node', ['--version']);
	const nodeParsed = nodeVersionRaw ? parseMajorMinor(nodeVersionRaw.replace(/^v/, '')) : undefined;
	const nodeOk = nodeParsed !== undefined && nodeParsed.major >= 22;
	console.log(`  node:     ${nodeVersionRaw ? `${nodeVersionRaw}${nodeOk ? ' (OK)' : ' (need >= 22)'}` : 'NOT FOUND on PATH'}`);
	console.log(`  bash:     ${isCommandOnPath('bash') ? 'found on PATH' : 'NOT FOUND on PATH'}`);

	let resolvedAgentId: string;
	try {
		resolvedAgentId = resolveAgentId(options.agent);
	} catch (error) {
		console.log(`\npairing:      ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const config = loadConfig(resolvedAgentId);
	console.log(`\nhub:          ${config.hubUrl}`);
	const wsUrl = `${config.hubUrl.replace(/^http/, 'ws')}/api/v1/agents.harness.relay`;
	const status = await probeUpgradeStatus(wsUrl, { Authorization: `Bearer ${config.botToken}` });
	if (status === null) console.log('token/hub:    reachable, upgrade would succeed');
	else if (status === 401) console.log('token/hub:    UNAUTHORIZED (401) — bot token invalid, run "pair" again');
	else if (status === 403) console.log('token/hub:    FORBIDDEN (403) — agent is not a harness agent');
	else console.log(`token/hub:    unexpected HTTP ${status} at upgrade`);

	// Smoke imports with the exact env `start` would build for this workspace,
	// so a broken/uninstalled skills bundle or a stale NODE_PATH shows up here
	// instead of surfacing mid-turn as an opaque "Cannot find module".
	const workspaceDir = options.workspace ?? defaultWorkspaceDir(resolvedAgentId);
	const skillSdkPythonPath = join(workspaceDir, '.privos', 'skill-sdk');
	const bridgeNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url));

	console.log('\nskill-sdk smoke imports:');
	const pythonSmoke = spawnSync('python3', ['-c', 'import privos_skill'], {
		env: { ...process.env, PYTHONPATH: [skillSdkPythonPath, process.env.PYTHONPATH].filter(Boolean).join(':') },
		encoding: 'utf-8',
		timeout: 5_000,
	});
	console.log(`  python3 -c "import privos_skill":         ${pythonSmoke.status === 0 ? 'OK' : `FAILED${pythonSmoke.stderr ? ` — ${lastLine(pythonSmoke.stderr)}` : ''}`}`);

	const nodeSmoke = spawnSync('node', ['-e', "require('@privos_ai/skill-sdk')"], {
		env: { ...process.env, NODE_PATH: [bridgeNodeModules, process.env.NODE_PATH].filter(Boolean).join(':') },
		encoding: 'utf-8',
		timeout: 5_000,
	});
	console.log(`  node -e "require('@privos_ai/skill-sdk')": ${nodeSmoke.status === 0 ? 'OK' : `FAILED${nodeSmoke.stderr ? ` — ${lastLine(nodeSmoke.stderr)}` : ''}`}`);

	console.log('\nisolation self-test (per level; auto picks the first that passes this exact check):');
	const specWithCommand = { ...spec, command };
	for (const level of ['wrap', 'container'] as const) {
		const result = await runSelfTest(level, {
			workspaceDir,
			spec: specWithCommand,
			hubUrl: config.hubUrl,
			containerImage: options.containerImage ?? DEFAULT_CONTAINER_IMAGE,
		});
		console.log(`  ${level}: ${result.passed ? 'PASS' : 'FAIL'} — ${result.detail}`);
		for (const [name, check] of Object.entries(result.checks)) {
			if (check.skipped) continue;
			console.log(`    ${check.passed ? 'ok  ' : 'FAIL'} ${name}: ${check.detail}`);
		}
	}
	console.log(`  prompt: always available (no OS sandbox; native adapter sandbox + <isolation_policy> preamble only)`);
	console.log(`  effective reported level for this adapter: ${reportedIsolationLevel('wrap', specWithCommand)} under wrap, ${reportedIsolationLevel('container', specWithCommand)} under container`);
}

// ---------------------------------------------------------------------------
// program
// ---------------------------------------------------------------------------

const program = new Command();
program.name('privos-agent-harness').description('Bridge CLI pairing a PrivOS hub agent with a local ACP coding agent.').version(BRIDGE_VERSION);

program
	.command('pair')
	.argument('<guideUrl>', 'pairing guideline URL from the agent-room message or the success modal')
	.option('--insecure', 'allow plain http:// / ws:// to a non-localhost host')
	.option('--no-skills', 'skip installing the PrivOS skills bundle')
	.option('--skills-dir <dir>', 'install skills from a local privos-sandbox checkout instead of the hub (for skill development)')
	.action((guideUrl: string, opts: { insecure?: boolean; skills?: boolean; skillsDir?: string }) =>
		runPair(guideUrl, { insecure: opts.insecure, noSkills: opts.skills === false, skillsDir: opts.skillsDir }).catch((e: unknown) =>
			fail(String(e instanceof Error ? e.message : e)),
		),
	);

program
	.command('start')
	.option('--agent <id>', 'agent id to run (default: the sole paired agent)')
	.option('--adapter <id>', `ACP adapter: ${ADAPTER_IDS.join('|')}`, 'claude')
	.option('--command <cmd>', 'override the adapter spawn command, e.g. "agy-acp --flag"')
	.option('--workspace <dir>', 'workspace directory (default ~/privos-harness/<agentId>)')
	.option('--isolation <level>', `isolation level: ${ISOLATION_FLAGS.join('|')}`, 'auto')
	.option('--max-rooms <n>', 'per-room adapter-process pool cap', '8')
	.option('--container-image <image>', 'image for --isolation container (must have python3 + the chosen adapter installed)', DEFAULT_CONTAINER_IMAGE)
	.option('--permissions <policy>', `permission policy: ${PERMISSION_POLICIES.join('|')}`, 'auto')
	.option('--idle-timeout <seconds>', 'idle timeout in seconds', '600')
	.option('--reset-session', 'forget stored ACP session ids before starting')
	.option('--insecure', 'allow plain http:// / ws:// to a non-localhost hub')
	.option('--verbose', 'stream ACP updates to stderr')
	.option('--no-skills', 'skip auto-updating the PrivOS skills bundle on start')
	.option('--skills-dir <dir>', 'update skills from a local privos-sandbox checkout instead of the hub (for skill development)')
	.action((opts: Record<string, unknown>) => {
		const adapter = opts.adapter as string;
		if (!ADAPTER_IDS.includes(adapter as AdapterId)) fail(`--adapter must be one of: ${ADAPTER_IDS.join(', ')}`);
		const isolation = opts.isolation as string;
		if (!ISOLATION_FLAGS.includes(isolation as (typeof ISOLATION_FLAGS)[number])) fail(`--isolation must be one of: ${ISOLATION_FLAGS.join(', ')}`);
		const permissions = opts.permissions as string;
		if (!PERMISSION_POLICIES.includes(permissions as PermissionPolicy)) fail(`--permissions must be one of: ${PERMISSION_POLICIES.join(', ')}`);
		return runStart({
			agent: opts.agent as string | undefined,
			adapter: adapter as AdapterId,
			command: opts.command as string | undefined,
			workspace: opts.workspace as string | undefined,
			isolation: isolation as (typeof ISOLATION_FLAGS)[number],
			maxRooms: opts.maxRooms as string,
			containerImage: opts.containerImage as string,
			permissions: permissions as PermissionPolicy,
			idleTimeout: opts.idleTimeout as string,
			resetSession: opts.resetSession as boolean | undefined,
			insecure: opts.insecure as boolean | undefined,
			verbose: opts.verbose as boolean | undefined,
			noSkills: opts.skills === false,
			skillsDir: opts.skillsDir as string | undefined,
		}).catch((e: unknown) => fail(String(e instanceof Error ? e.message : e)));
	});

// ---------------------------------------------------------------------------
// skills install|update|list
// ---------------------------------------------------------------------------

interface SkillsCommandOptions {
	agent?: string;
	workspace?: string;
	skillsDir?: string;
	force?: boolean;
}

function resolveSkillsWorkspaceDir(options: { agent?: string; workspace?: string }): { agentId: string; workspaceDir: string } {
	const agentId = resolveAgentId(options.agent);
	return { agentId, workspaceDir: options.workspace ?? defaultWorkspaceDir(agentId) };
}

async function runSkillsInstall(options: SkillsCommandOptions): Promise<void> {
	const { agentId, workspaceDir } = resolveSkillsWorkspaceDir(options);
	const config = loadConfig(agentId);
	await autoInstallSkills({
		workspaceDir,
		source: options.skillsDir
			? { kind: 'local', dir: options.skillsDir }
			: { kind: 'url', url: `${config.hubUrl.replace(/\/+$/, '')}/api/v1/agents.harness.skills`, headers: { Authorization: `Bearer ${config.botToken}` } },
		mode: 'install',
		force: options.force,
	});
}

async function runSkillsUpdate(options: SkillsCommandOptions): Promise<void> {
	const { agentId, workspaceDir } = resolveSkillsWorkspaceDir(options);
	const config = loadConfig(agentId);
	await autoInstallSkills({
		workspaceDir,
		source: options.skillsDir
			? { kind: 'local', dir: options.skillsDir }
			: { kind: 'url', url: `${config.hubUrl.replace(/\/+$/, '')}/api/v1/agents.harness.skills`, headers: { Authorization: `Bearer ${config.botToken}` } },
		mode: 'update',
		force: options.force,
	});
}

function runSkillsList(options: { agent?: string; workspace?: string }): void {
	const { workspaceDir } = resolveSkillsWorkspaceDir(options);
	const info = listInstalledSkills(workspaceDir);
	if (!info) {
		console.log(`No skills installed in ${workspaceDir} yet. Run "privos-agent-harness skills install".`);
		return;
	}
	console.log(`workspace:       ${workspaceDir}`);
	console.log(`sandboxVersion:  ${info.sandboxVersion}`);
	console.log(`skills (${info.skillNames.length}): ${info.skillNames.join(', ')}`);
}

const skillsCommand = program.command('skills').description('Manage the PrivOS skills bundle installed in the harness workspace.');

skillsCommand
	.command('install')
	.option('--agent <id>', 'agent id (default: the sole paired agent)')
	.option('--workspace <dir>', 'workspace directory (default ~/privos-harness/<agentId>)')
	.option('--skills-dir <dir>', 'install from a local privos-sandbox checkout instead of the hub')
	.action((opts: SkillsCommandOptions) => runSkillsInstall(opts).catch((e: unknown) => fail(String(e instanceof Error ? e.message : e))));

skillsCommand
	.command('update')
	.option('--agent <id>', 'agent id (default: the sole paired agent)')
	.option('--workspace <dir>', 'workspace directory (default ~/privos-harness/<agentId>)')
	.option('--skills-dir <dir>', 'update from a local privos-sandbox checkout instead of the hub')
	.option('--force', 'overwrite locally-modified skill files')
	.action((opts: SkillsCommandOptions) => runSkillsUpdate(opts).catch((e: unknown) => fail(String(e instanceof Error ? e.message : e))));

skillsCommand
	.command('list')
	.option('--agent <id>', 'agent id (default: the sole paired agent)')
	.option('--workspace <dir>', 'workspace directory (default ~/privos-harness/<agentId>)')
	.action((opts: { agent?: string; workspace?: string }) => {
		try {
			runSkillsList(opts);
		} catch (e: unknown) {
			fail(String(e instanceof Error ? e.message : e));
		}
	});

program
	.command('status')
	.option('--agent <id>', 'agent id to inspect (default: the sole paired agent)')
	.action((opts: { agent?: string }) => runStatus(opts).catch((e: unknown) => fail(String(e instanceof Error ? e.message : e))));

program
	.command('doctor')
	.option('--agent <id>', 'agent id to inspect (default: the sole paired agent)')
	.option('--adapter <id>', `ACP adapter: ${ADAPTER_IDS.join('|')}`, 'claude')
	.option('--command <cmd>', 'override the adapter spawn command')
	.option('--workspace <dir>', 'workspace directory to smoke-test (default ~/privos-harness/<agentId>)')
	.option('--container-image <image>', 'image to self-test --isolation container against', DEFAULT_CONTAINER_IMAGE)
	.action((opts: { agent?: string; adapter: string; command?: string; workspace?: string; containerImage?: string }) => {
		if (!ADAPTER_IDS.includes(opts.adapter as AdapterId)) fail(`--adapter must be one of: ${ADAPTER_IDS.join(', ')}`);
		return runDoctor({
			agent: opts.agent,
			adapter: opts.adapter as AdapterId,
			command: opts.command,
			workspace: opts.workspace,
			containerImage: opts.containerImage,
		}).catch((e: unknown) => fail(String(e instanceof Error ? e.message : e)));
	});

program.parseAsync(process.argv).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
