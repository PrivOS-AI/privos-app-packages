/**
 * Persists the mapping from hub `sessionKey` (= taskId, room+bot+thread) to
 * the ACP `sessionId` the adapter gave us, so a follow-up turn in the same
 * thread can `session/load` instead of starting fresh. One file per agent:
 * `~/.privos/agent-harness/<agentId>.sessions.json`.
 *
 * `adapter`/`cwd` are carried alongside `acpSessionId` for diagnostics
 * (`status`/`doctor`) only -- `session/load` keys strictly on `acpSessionId`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface StoredSession {
	acpSessionId: string;
	adapter?: string;
	cwd?: string;
	updatedAt: number;
}

type SessionMap = Record<string, StoredSession>;

// Prune ceiling: bounds file growth for long-running bridges with many
// threads. ponytail: naive age+count cutoff, revisit if a tenant needs
// per-thread history longer than 30 days / more than 200 live threads.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;

function storePath(agentId: string): string {
	return join(homedir(), '.privos', 'agent-harness', `${agentId}.sessions.json`);
}

function readAll(agentId: string): SessionMap {
	const path = storePath(agentId);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as SessionMap;
	} catch {
		return {};
	}
}

function writeAll(agentId: string, map: SessionMap): void {
	const dir = join(homedir(), '.privos', 'agent-harness');
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(storePath(agentId), `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
}

function prune(map: SessionMap): SessionMap {
	const now = Date.now();
	let entries = Object.entries(map).filter(([, session]) => now - session.updatedAt < MAX_AGE_MS);
	if (entries.length > MAX_ENTRIES) {
		entries = entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_ENTRIES);
	}
	return Object.fromEntries(entries);
}

export function getSession(agentId: string, sessionKey: string): StoredSession | undefined {
	return readAll(agentId)[sessionKey];
}

export function setSession(agentId: string, sessionKey: string, acpSessionId: string, meta?: { adapter?: string; cwd?: string }): void {
	const map = readAll(agentId);
	map[sessionKey] = { acpSessionId, updatedAt: Date.now(), ...(meta?.adapter !== undefined && { adapter: meta.adapter }), ...(meta?.cwd !== undefined && { cwd: meta.cwd }) };
	// Prune AFTER inserting so the persisted file is capped at MAX_ENTRIES on
	// every write, not just once it overshoots by one on the next call.
	writeAll(agentId, prune(map));
}

export function deleteSession(agentId: string, sessionKey: string): void {
	const map = readAll(agentId);
	delete map[sessionKey];
	writeAll(agentId, map);
}

/** Forgets every stored ACP session id for this agent (`harness.resetSessions` / `--reset-session`). */
export function resetAllSessions(agentId: string): void {
	writeAll(agentId, {});
}
