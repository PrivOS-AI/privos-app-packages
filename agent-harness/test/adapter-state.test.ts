import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAdapterState } from '../src/adapter-state.js';
import type { AdapterSpec } from '../src/acp/adapter-table.js';

function fakeSpec(overrides: Partial<AdapterSpec>): AdapterSpec {
	return {
		id: 'custom',
		testedVersion: 'n/a',
		command: 'x',
		args: [],
		systemPromptTransport: 'prefix',
		authHint: 'n/a',
		expectedLoadSession: false,
		steering: 'none',
		credentialFiles: [],
		realStateDir: () => '',
		writeNativeSandboxConfig: () => undefined,
		...overrides,
	};
}

describe('seedAdapterState', () => {
	let base: string;
	let roomDir: string;
	let realStateDir: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), 'agent-harness-adapter-state-test-'));
		roomDir = join(base, 'room-1');
		realStateDir = join(base, 'real-claude');
		mkdirSync(roomDir, { recursive: true });
		mkdirSync(realStateDir, { recursive: true });
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it('mode "shared" and empty env for an adapter with no documented credential file', () => {
		const spec = fakeSpec({ credentialFiles: [] });
		const result = seedAdapterState(spec, roomDir);
		expect(result).toEqual({ mode: 'shared', homeStateDir: undefined, env: {} });
		expect(existsSync(join(roomDir, '.home'))).toBe(false);
	});

	it('mode "shared" when the adapter declares a credential file but this machine has never logged in (nothing to copy)', () => {
		const spec = fakeSpec({ credentialFiles: ['.credentials.json'], realStateDir: () => realStateDir });
		const result = seedAdapterState(spec, roomDir);
		expect(result.mode).toBe('shared');
		expect(result.env).toEqual({});
	});

	it('copies only the declared credential file (0600), never other files in the real state dir (H5)', () => {
		writeFileSync(join(realStateDir, '.credentials.json'), '{"token":"secret"}');
		writeFileSync(join(realStateDir, 'settings.json'), '{"hooks":{"evil":true}}');
		const spec = fakeSpec({
			credentialFiles: ['.credentials.json'],
			homeEnvVar: 'CLAUDE_CONFIG_DIR',
			homeSubdir: '.claude',
			realStateDir: () => realStateDir,
		});
		const result = seedAdapterState(spec, roomDir);

		expect(result.mode).toBe('seeded');
		const seededCredFile = join(roomDir, '.home', '.claude', '.credentials.json');
		expect(readFileSync(seededCredFile, 'utf-8')).toBe('{"token":"secret"}');
		expect(statSync(seededCredFile).mode & 0o777).toBe(0o600);
		expect(existsSync(join(roomDir, '.home', '.claude', 'settings.json'))).toBe(false);

		expect(result.homeStateDir).toBe(join(roomDir, '.home', '.claude'));
		expect(result.env).toEqual({ HOME: join(roomDir, '.home'), CLAUDE_CONFIG_DIR: join(roomDir, '.home', '.claude') });
	});

	it('seeds into a bare per-room HOME when the adapter declares no homeEnvVar/homeSubdir', () => {
		writeFileSync(join(realStateDir, 'auth.json'), '{"token":"secret"}');
		const spec = fakeSpec({ credentialFiles: ['auth.json'], realStateDir: () => realStateDir });
		const result = seedAdapterState(spec, roomDir);
		expect(result.mode).toBe('seeded');
		expect(existsSync(join(roomDir, '.home', 'auth.json'))).toBe(true);
		expect(result.env).toEqual({ HOME: join(roomDir, '.home') });
	});
});
