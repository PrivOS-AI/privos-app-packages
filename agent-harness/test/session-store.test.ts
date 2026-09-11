import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let fakeHome: string;

vi.mock('node:os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:os')>();
	return { ...actual, homedir: () => fakeHome };
});

const { getSession, setSession, deleteSession, resetAllSessions } = await import('../src/session-store.js');

describe('session-store', () => {
	beforeEach(() => {
		fakeHome = mkdtempSync(join(tmpdir(), 'agent-harness-session-test-'));
	});
	afterEach(() => {
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it('returns undefined for an unknown sessionKey', () => {
		expect(getSession('agent', 'room:thread')).toBeUndefined();
	});

	it('round-trips a stored ACP session id', () => {
		setSession('agent', 'room:thread', 'acp-session-1');
		expect(getSession('agent', 'room:thread')?.acpSessionId).toBe('acp-session-1');
	});

	it('deleteSession removes only the targeted key', () => {
		setSession('agent', 'a', 'acp-a');
		setSession('agent', 'b', 'acp-b');
		deleteSession('agent', 'a');
		expect(getSession('agent', 'a')).toBeUndefined();
		expect(getSession('agent', 'b')?.acpSessionId).toBe('acp-b');
	});

	it('resetAllSessions clears the whole store for that agent', () => {
		setSession('agent', 'a', 'acp-a');
		setSession('agent', 'b', 'acp-b');
		resetAllSessions('agent');
		expect(getSession('agent', 'a')).toBeUndefined();
		expect(getSession('agent', 'b')).toBeUndefined();
	});

	it('keeps agents in separate files', () => {
		setSession('agent-1', 'k', 'acp-1');
		setSession('agent-2', 'k', 'acp-2');
		expect(getSession('agent-1', 'k')?.acpSessionId).toBe('acp-1');
		expect(getSession('agent-2', 'k')?.acpSessionId).toBe('acp-2');
	});

	it('stores adapter/cwd alongside acpSessionId when provided', () => {
		setSession('agent', 'room:thread', 'acp-1', { adapter: 'claude', cwd: '/workspace' });
		const stored = getSession('agent', 'room:thread');
		expect(stored?.adapter).toBe('claude');
		expect(stored?.cwd).toBe('/workspace');
	});

	it('prunes to the newest 200 entries once the store exceeds the cap', () => {
		// Distinct, strictly increasing timestamps -- real turns are always
		// minutes/hours apart, so this isolates "newest N survive" from the
		// separate (untested here) tie-break-on-same-millisecond case.
		vi.useFakeTimers();
		try {
			for (let i = 0; i < 205; i++) {
				vi.setSystemTime(i * 1000);
				setSession('agent', `k${i}`, `acp-${i}`);
			}
		} finally {
			vi.useRealTimers();
		}
		expect(getSession('agent', 'k0')).toBeUndefined();
		expect(getSession('agent', 'k4')).toBeUndefined();
		expect(getSession('agent', 'k204')?.acpSessionId).toBe('acp-204');
	});

	it('prunes entries older than 30 days', () => {
		setSession('agent', 'stale', 'acp-stale');
		const map = JSON.parse(readFileSync(join(fakeHome, '.privos', 'agent-harness', 'agent.sessions.json'), 'utf8'));
		map.stale.updatedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
		writeFileSync(join(fakeHome, '.privos', 'agent-harness', 'agent.sessions.json'), JSON.stringify(map));

		// Any subsequent write re-applies the prune filter.
		setSession('agent', 'fresh', 'acp-fresh');
		expect(getSession('agent', 'stale')).toBeUndefined();
		expect(getSession('agent', 'fresh')?.acpSessionId).toBe('acp-fresh');
	});
});
