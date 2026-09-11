import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let fakeHome: string;

vi.mock('node:os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:os')>();
	return { ...actual, homedir: () => fakeHome };
});

// Imported after the mock so config-store's `homedir()` call resolves to it.
const { saveConfig, loadConfig, configPath, configExists, listAgentIds, resolveAgentId } = await import('../src/config-store.js');

describe('config-store', () => {
	beforeEach(() => {
		fakeHome = mkdtempSync(join(tmpdir(), 'agent-harness-config-test-'));
	});
	afterEach(() => {
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it('writes the config file with mode 0600', () => {
		const path = saveConfig({
			agentId: 'agent-1',
			hubUrl: 'https://hub.example',
			botToken: 'privos_bottoken',
			agentRoomId: 'room-1',
			respondTo: 'owner',
			guideUrl: 'https://hub.example/guide',
			pairedAt: new Date().toISOString(),
		});
		expect(path).toBe(configPath('agent-1'));
		const mode = statSync(path).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it('round-trips through loadConfig', () => {
		saveConfig({
			agentId: 'agent-2',
			hubUrl: 'https://hub.example',
			botToken: 'privos_bottoken',
			agentRoomId: 'room-2',
			respondTo: 'everyone',
			guideUrl: 'https://hub.example/guide',
			pairedAt: '2026-01-01T00:00:00.000Z',
		});
		const loaded = loadConfig('agent-2');
		expect(loaded.agentRoomId).toBe('room-2');
		expect(loaded.respondTo).toBe('everyone');
	});

	it('loadConfig throws a clear error when no pairing exists', () => {
		expect(() => loadConfig('does-not-exist')).toThrow(/No harness pairing found/);
	});

	it('configExists reflects presence on disk', () => {
		expect(configExists('agent-3')).toBe(false);
		saveConfig({
			agentId: 'agent-3',
			hubUrl: 'https://hub.example',
			botToken: 'privos_x',
			agentRoomId: 'room-3',
			respondTo: 'owner',
			guideUrl: 'https://hub.example/guide',
			pairedAt: new Date().toISOString(),
		});
		expect(configExists('agent-3')).toBe(true);
	});

	it('resolveAgentId auto-picks the sole paired agent', () => {
		saveConfig({
			agentId: 'only-agent',
			hubUrl: 'https://hub.example',
			botToken: 'privos_x',
			agentRoomId: 'room',
			respondTo: 'owner',
			guideUrl: 'https://hub.example/guide',
			pairedAt: new Date().toISOString(),
		});
		expect(resolveAgentId(undefined)).toBe('only-agent');
	});

	it('resolveAgentId errors when zero or multiple agents are paired', () => {
		expect(() => resolveAgentId(undefined)).toThrow(/No harness pairing found/);
		saveConfig({
			agentId: 'a',
			hubUrl: 'https://hub.example',
			botToken: 'privos_x',
			agentRoomId: 'room',
			respondTo: 'owner',
			guideUrl: 'https://hub.example/guide',
			pairedAt: new Date().toISOString(),
		});
		saveConfig({
			agentId: 'b',
			hubUrl: 'https://hub.example',
			botToken: 'privos_x',
			agentRoomId: 'room',
			respondTo: 'owner',
			guideUrl: 'https://hub.example/guide',
			pairedAt: new Date().toISOString(),
		});
		expect(listAgentIds().sort()).toEqual(['a', 'b']);
		expect(() => resolveAgentId(undefined)).toThrow(/Multiple paired agents/);
		expect(resolveAgentId('a')).toBe('a');
	});
});
