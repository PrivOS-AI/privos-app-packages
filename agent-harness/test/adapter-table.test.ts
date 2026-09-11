import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAPTER_TABLE, resolveAdapterCommand } from '../src/acp/adapter-table.js';

describe('resolveAdapterCommand', () => {
	it('resolves the default command for a known adapter', () => {
		expect(resolveAdapterCommand('claude', undefined)).toEqual({ command: 'claude-agent-acp', args: [] });
	});

	it('honours a --command override, splitting binary and args', () => {
		expect(resolveAdapterCommand('claude', 'my-bin --flag value')).toEqual({ command: 'my-bin', args: ['--flag', 'value'] });
	});

	it('requires --command for the custom adapter', () => {
		expect(() => resolveAdapterCommand('custom', undefined)).toThrow(/requires --command/);
	});

	it('accepts custom when --command is given', () => {
		expect(resolveAdapterCommand('custom', 'agy-acp')).toEqual({ command: 'agy-acp', args: [] });
	});

	it('rejects an empty --command', () => {
		expect(() => resolveAdapterCommand('claude', '   ')).toThrow(/must not be empty/);
	});
});

describe('writeNativeSandboxConfig', () => {
	let roomDir: string;
	beforeEach(() => {
		roomDir = mkdtempSync(join(tmpdir(), 'agent-harness-native-sandbox-test-'));
	});
	afterEach(() => rmSync(roomDir, { recursive: true, force: true }));

	it('claude: disables its own sandbox under wrap/container (nested sandboxing is EPERM — H4)', () => {
		ADAPTER_TABLE.claude.writeNativeSandboxConfig({ roomDir, roomsRoot: '/ws/rooms', homeStateDir: undefined, level: 'wrap' });
		const settings = JSON.parse(readFileSync(join(roomDir, '.claude', 'settings.json'), 'utf-8'));
		expect(settings).toEqual({ sandbox: { enabled: false } });
	});

	it('claude: enables its own sandbox denying the rooms root under prompt (the only enforcement left)', () => {
		ADAPTER_TABLE.claude.writeNativeSandboxConfig({ roomDir, roomsRoot: '/ws/rooms', homeStateDir: undefined, level: 'prompt' });
		const settings = JSON.parse(readFileSync(join(roomDir, '.claude', 'settings.json'), 'utf-8'));
		expect(settings).toEqual({ sandbox: { enabled: true, filesystem: { denyRead: ['/ws/rooms'], allowRead: ['.'] } } });
	});

	it('codex: writes danger-full-access under wrap and workspace-write scoped to the room under prompt', () => {
		const homeStateDir = join(roomDir, '.home', '.codex');
		mkdirSync(homeStateDir, { recursive: true });

		ADAPTER_TABLE.codex.writeNativeSandboxConfig({ roomDir, roomsRoot: '/ws/rooms', homeStateDir, level: 'wrap' });
		expect(readFileSync(join(homeStateDir, 'config.toml'), 'utf-8')).toContain('danger-full-access');

		ADAPTER_TABLE.codex.writeNativeSandboxConfig({ roomDir, roomsRoot: '/ws/rooms', homeStateDir, level: 'prompt' });
		const promptConfig = readFileSync(join(homeStateDir, 'config.toml'), 'utf-8');
		expect(promptConfig).toContain('workspace-write');
		expect(promptConfig).toContain(roomDir);
	});

	it('codex: skips writing when there is no room-local state dir to write into (shared state)', () => {
		ADAPTER_TABLE.codex.writeNativeSandboxConfig({ roomDir, roomsRoot: '/ws/rooms', homeStateDir: undefined, level: 'wrap' });
		expect(() => readFileSync(join(roomDir, '.home', '.codex', 'config.toml'), 'utf-8')).toThrow();
	});

	it('cursor/goose/custom: no-op (no documented native sandbox)', () => {
		for (const id of ['cursor', 'goose', 'custom'] as const) {
			expect(() =>
				ADAPTER_TABLE[id].writeNativeSandboxConfig({ roomDir, roomsRoot: '/ws/rooms', homeStateDir: undefined, level: 'wrap' }),
			).not.toThrow();
		}
	});
});
