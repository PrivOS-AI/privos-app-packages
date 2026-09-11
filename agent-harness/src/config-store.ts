/**
 * Persists one harness pairing per agent at `~/.privos/agent-harness/<agentId>.json`,
 * mode 0600. This file holds the bot token (the only durable secret the bridge
 * keeps at rest) — never printed, never logged, redacted everywhere by
 * `redact.ts` as a defense in depth in case a bug puts it in an error message.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AgentHarnessRespondTo = 'owner' | 'agent-room-members' | 'everyone';

export interface HarnessConfig {
	agentId: string;
	hubUrl: string;
	botToken: string;
	agentRoomId: string;
	respondTo: AgentHarnessRespondTo;
	/** Guide URL the config was minted from, kept for `status`/`doctor` diagnostics. */
	guideUrl: string;
	pairedAt: string;
}

function configDir(): string {
	return join(homedir(), '.privos', 'agent-harness');
}

export function configPath(agentId: string): string {
	return join(configDir(), `${agentId}.json`);
}

export function configExists(agentId: string): boolean {
	return existsSync(configPath(agentId));
}

export function saveConfig(config: HarnessConfig): string {
	const dir = configDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = configPath(config.agentId);
	// Write then chmod: some platforms ignore the `mode` passed to writeFileSync
	// for an existing file, so set permissions explicitly after writing.
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

export function loadConfig(agentId: string): HarnessConfig {
	const path = configPath(agentId);
	if (!existsSync(path)) {
		throw new Error(`No harness pairing found for agent "${agentId}" at ${path}. Run "privos-agent-harness pair <guideUrl>" first.`);
	}
	const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<HarnessConfig>;
	if (
		typeof raw.agentId !== 'string' ||
		typeof raw.hubUrl !== 'string' ||
		typeof raw.botToken !== 'string' ||
		typeof raw.agentRoomId !== 'string' ||
		typeof raw.respondTo !== 'string'
	) {
		throw new Error(`Harness config at ${path} is malformed. Re-run "pair" to regenerate it.`);
	}
	return raw as HarnessConfig;
}

/** Lists the agentIds of every persisted pairing, for `--agent` auto-detection. */
export function listAgentIds(): string[] {
	const dir = configDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith('.json'))
		.map((name) => name.slice(0, -'.json'.length));
}

/**
 * Resolves the agentId to operate on when `--agent` is omitted: the sole
 * paired agent if exactly one exists, otherwise an error naming the choices.
 */
export function resolveAgentId(explicit: string | undefined): string {
	if (explicit) return explicit;
	const ids = listAgentIds();
	if (ids.length === 1 && ids[0]) return ids[0];
	if (ids.length === 0) {
		throw new Error('No harness pairing found. Run "privos-agent-harness pair <guideUrl>" first.');
	}
	throw new Error(`Multiple paired agents found (${ids.join(', ')}). Pass --agent <id> to pick one.`);
}
