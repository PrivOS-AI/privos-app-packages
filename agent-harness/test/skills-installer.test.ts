/**
 * Fixture bundles are built raw (custom tar headers via `tar.Header`), not
 * through `buildBundleFromLocalCheckout` — that lets the hostile-bundle
 * tests construct exactly the malformed archives a real hardened parser must
 * reject (path traversal, absolute paths, symlink entries, oversize/overcount,
 * digest mismatches) without a filesystem round trip.
 */
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tar from 'tar';
import {
	HostileBundleError,
	SkillsLocallyModifiedError,
	SkillsUpdateBusyError,
	installSkillsBundle,
	listInstalledSkills,
	setRoomBusy,
	writeHarnessEnvFile,
} from '../src/skills-installer.js';

// ---------------------------------------------------------------------------
// Raw tar.gz builder — full control over headers, unlike `tar.c()`.
// ---------------------------------------------------------------------------

interface RawEntrySpec {
	path: string;
	type?: 'File' | 'Directory' | 'SymbolicLink';
	data?: Buffer;
	linkpath?: string;
}

function encodeEntry(spec: RawEntrySpec): Buffer {
	const data = spec.data ?? Buffer.alloc(0);
	const header = new tar.Header({
		path: spec.path,
		size: spec.type === 'Directory' || spec.type === 'SymbolicLink' ? 0 : data.length,
		type: spec.type ?? 'File',
		...(spec.linkpath ? { linkpath: spec.linkpath } : {}),
	});
	header.encode();
	if (spec.type === 'Directory' || spec.type === 'SymbolicLink') return header.block as Buffer;
	const pad = (512 - (data.length % 512)) % 512;
	return Buffer.concat([header.block as Buffer, data, Buffer.alloc(pad)]);
}

function rawTarGz(entries: RawEntrySpec[]): Buffer {
	const parts = entries.map(encodeEntry);
	parts.push(Buffer.alloc(1024)); // two zero blocks mark end-of-archive
	return gzipSync(Buffer.concat(parts));
}

function sha256(data: Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// A well-formed fake bundle: 2 skills + skill-sdk, correctly digested.
// ---------------------------------------------------------------------------

function buildValidFixture(opts: { sandboxVersion?: string } = {}): Buffer {
	const skillMd = Buffer.from('# fake-skill-a\ndoes nothing\n');
	const skillJs = Buffer.from('module.exports = () => {};\n');
	const skillBEdit = Buffer.from('# agent-bot-edit\n');
	const sdk = Buffer.from('def hub():\n    return None\n');

	const files = [
		{ archivePath: 'skills/fake-skill-a/SKILL.md', data: skillMd },
		{ archivePath: 'skills/fake-skill-a/run.js', data: skillJs },
		{ archivePath: 'agent-room/skills/agent-bot-edit/SKILL.md', data: skillBEdit },
		{ archivePath: 'skill-sdk/privos_skill.py', data: sdk },
	];
	const allFiles = files.map((f) => ({ path: f.archivePath, sha256: sha256(f.data) }));
	const manifest = {
		sandboxVersion: opts.sandboxVersion ?? '1.2.3',
		builtAt: new Date().toISOString(),
		skills: [
			{ name: 'fake-skill-a', files: [files[0]!.archivePath, files[1]!.archivePath], sha256: 'unused-in-tests' },
			{ name: 'agent-bot-edit', files: [files[2]!.archivePath], sha256: 'unused-in-tests' },
		],
		allFiles,
	};

	return rawTarGz([
		{ path: 'MANIFEST.json', data: Buffer.from(JSON.stringify(manifest)) },
		...files.map((f) => ({ path: f.archivePath, data: f.data })),
	]);
}

let workspaceDir: string;

beforeEach(() => {
	workspaceDir = mkdtempSync(join(tmpdir(), 'agent-harness-skills-test-'));
});

afterEach(() => {
	rmSync(workspaceDir, { recursive: true, force: true });
});

describe('installSkillsBundle — happy path', () => {
	it('materializes both skills, the skill-sdk file, and correct file modes', async () => {
		const result = await installSkillsBundle(buildValidFixture(), workspaceDir, { mode: 'install' });

		expect(result.installed).toBe(true);
		expect(result.sandboxVersion).toBe('1.2.3');
		expect(result.skillNames.sort()).toEqual(['agent-bot-edit', 'fake-skill-a']);

		const skillMdPath = join(workspaceDir, '.privos', 'skills', 'fake-skill-a', 'SKILL.md');
		const skillJsPath = join(workspaceDir, '.privos', 'skills', 'fake-skill-a', 'run.js');
		const botEditPath = join(workspaceDir, '.privos', 'skills', 'agent-bot-edit', 'SKILL.md');
		const sdkPath = join(workspaceDir, '.privos', 'skill-sdk', 'privos_skill.py');

		expect(existsSync(skillMdPath)).toBe(true);
		expect(existsSync(botEditPath)).toBe(true); // agent-room/skills/* flattens into the same skills/ namespace
		expect(readFileSync(skillMdPath, 'utf-8')).toContain('fake-skill-a');

		expect(statSync(skillMdPath).mode & 0o777).toBe(0o644);
		expect(statSync(skillJsPath).mode & 0o777).toBe(0o755); // .js -> executable
		expect(statSync(sdkPath).mode & 0o777).toBe(0o755); // .py -> executable
	});

	it('creates a .claude/skills symlink aliasing .privos/skills', async () => {
		await installSkillsBundle(buildValidFixture(), workspaceDir, { mode: 'install' });
		const aliasPath = join(workspaceDir, '.claude', 'skills');
		const stat = lstatSync(aliasPath);
		expect(stat.isSymbolicLink()).toBe(true);
	});

	it('renders CLAUDE.md and AGENTS.md with identical content', async () => {
		await installSkillsBundle(buildValidFixture(), workspaceDir, { mode: 'install' });
		const claudeMd = readFileSync(join(workspaceDir, 'CLAUDE.md'), 'utf-8');
		const agentsMd = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
		expect(claudeMd).toBe(agentsMd);
		expect(claudeMd).toContain('PrivOS agent-harness workspace');
	});

	it('skills list reports the installed sandboxVersion and skill names', async () => {
		await installSkillsBundle(buildValidFixture(), workspaceDir, { mode: 'install' });
		const info = listInstalledSkills(workspaceDir);
		expect(info?.sandboxVersion).toBe('1.2.3');
		expect(info?.skillNames.sort()).toEqual(['agent-bot-edit', 'fake-skill-a']);
	});

	it('listInstalledSkills returns undefined when nothing is installed', () => {
		expect(listInstalledSkills(workspaceDir)).toBeUndefined();
	});
});

describe('installSkillsBundle — update semantics', () => {
	it('is a no-op on the same sandboxVersion', async () => {
		await installSkillsBundle(buildValidFixture(), workspaceDir, { mode: 'install' });
		const second = await installSkillsBundle(buildValidFixture(), workspaceDir, { mode: 'update' });
		expect(second.installed).toBe(false);
		expect(second.sandboxVersion).toBe('1.2.3');
	});

	it('replaces the bundle after the sandboxVersion changes', async () => {
		await installSkillsBundle(buildValidFixture({ sandboxVersion: '1.2.3' }), workspaceDir, { mode: 'install' });
		const updated = await installSkillsBundle(buildValidFixture({ sandboxVersion: '1.3.0' }), workspaceDir, { mode: 'update' });
		expect(updated.installed).toBe(true);
		expect(updated.sandboxVersion).toBe('1.3.0');
	});

	it('refuses to overwrite a locally-edited file without --force', async () => {
		await installSkillsBundle(buildValidFixture({ sandboxVersion: '1.2.3' }), workspaceDir, { mode: 'install' });
		const skillMdPath = join(workspaceDir, '.privos', 'skills', 'fake-skill-a', 'SKILL.md');
		const { writeFileSync } = await import('node:fs');
		writeFileSync(skillMdPath, '# locally edited by the user\n');

		await expect(
			installSkillsBundle(buildValidFixture({ sandboxVersion: '1.3.0' }), workspaceDir, { mode: 'update' }),
		).rejects.toThrow(SkillsLocallyModifiedError);

		// Untouched: the local edit survives a refused update.
		expect(readFileSync(skillMdPath, 'utf-8')).toContain('locally edited');
	});

	it('overwrites a locally-edited file when --force is passed', async () => {
		await installSkillsBundle(buildValidFixture({ sandboxVersion: '1.2.3' }), workspaceDir, { mode: 'install' });
		const skillMdPath = join(workspaceDir, '.privos', 'skills', 'fake-skill-a', 'SKILL.md');
		const { writeFileSync } = await import('node:fs');
		writeFileSync(skillMdPath, '# locally edited by the user\n');

		const result = await installSkillsBundle(buildValidFixture({ sandboxVersion: '1.3.0' }), workspaceDir, {
			mode: 'update',
			force: true,
		});
		expect(result.installed).toBe(true);
		expect(readFileSync(skillMdPath, 'utf-8')).not.toContain('locally edited');
	});

	it('refuses an update while a room has a turn in flight, even with --force', async () => {
		await installSkillsBundle(buildValidFixture({ sandboxVersion: '1.2.3' }), workspaceDir, { mode: 'install' });
		setRoomBusy(workspaceDir, 'room-a', true);

		await expect(installSkillsBundle(buildValidFixture({ sandboxVersion: '1.3.0' }), workspaceDir, { mode: 'update' })).rejects.toThrow(
			SkillsUpdateBusyError,
		);
		await expect(
			installSkillsBundle(buildValidFixture({ sandboxVersion: '1.3.0' }), workspaceDir, { mode: 'update', force: true }),
		).rejects.toThrow(SkillsUpdateBusyError);

		setRoomBusy(workspaceDir, 'room-a', false);
		const result = await installSkillsBundle(buildValidFixture({ sandboxVersion: '1.3.0' }), workspaceDir, { mode: 'update' });
		expect(result.installed).toBe(true);
	});

	it('does not refuse a no-op update (same sandboxVersion) even while a room is busy', async () => {
		await installSkillsBundle(buildValidFixture({ sandboxVersion: '1.2.3' }), workspaceDir, { mode: 'install' });
		setRoomBusy(workspaceDir, 'room-a', true);
		const result = await installSkillsBundle(buildValidFixture({ sandboxVersion: '1.2.3' }), workspaceDir, { mode: 'update' });
		expect(result.installed).toBe(false);
	});
});

describe('installSkillsBundle — hostile bundle rejection', () => {
	async function expectRejectedAndUntouched(buffer: Buffer): Promise<void> {
		await expect(installSkillsBundle(buffer, workspaceDir, { mode: 'install' })).rejects.toThrow(HostileBundleError);
		expect(existsSync(join(workspaceDir, '.privos'))).toBe(false);
	}

	it('rejects a path-traversal entry (..)', async () => {
		const manifest = { sandboxVersion: '1.0.0', builtAt: '', skills: [], allFiles: [{ path: 'skills/../../etc/passwd', sha256: sha256(Buffer.from('x')) }] };
		const buffer = rawTarGz([
			{ path: 'MANIFEST.json', data: Buffer.from(JSON.stringify(manifest)) },
			{ path: 'skills/../../etc/passwd', data: Buffer.from('x') },
		]);
		await expectRejectedAndUntouched(buffer);
	});

	it('rejects an absolute-path entry', async () => {
		const manifest = { sandboxVersion: '1.0.0', builtAt: '', skills: [], allFiles: [{ path: '/etc/passwd', sha256: sha256(Buffer.from('x')) }] };
		const buffer = rawTarGz([
			{ path: 'MANIFEST.json', data: Buffer.from(JSON.stringify(manifest)) },
			{ path: '/etc/passwd', data: Buffer.from('x') },
		]);
		await expectRejectedAndUntouched(buffer);
	});

	it('rejects a symlink entry', async () => {
		const manifest = { sandboxVersion: '1.0.0', builtAt: '', skills: [], allFiles: [] };
		const buffer = rawTarGz([
			{ path: 'MANIFEST.json', data: Buffer.from(JSON.stringify(manifest)) },
			{ path: 'skills/foo/evil-link', type: 'SymbolicLink', linkpath: '/etc/passwd' },
		]);
		await expectRejectedAndUntouched(buffer);
	});

	it('rejects an entry outside the allowed roots', async () => {
		const data = Buffer.from('x');
		const manifest = { sandboxVersion: '1.0.0', builtAt: '', skills: [], allFiles: [{ path: 'not-allowed/file.txt', sha256: sha256(data) }] };
		const buffer = rawTarGz([
			{ path: 'MANIFEST.json', data: Buffer.from(JSON.stringify(manifest)) },
			{ path: 'not-allowed/file.txt', data },
		]);
		await expectRejectedAndUntouched(buffer);
	});

	it('rejects an archive with more than 500 entries', async () => {
		const entries: RawEntrySpec[] = [{ path: 'MANIFEST.json', data: Buffer.from(JSON.stringify({ sandboxVersion: '1.0.0', builtAt: '', skills: [], allFiles: [] })) }];
		for (let i = 0; i < 501; i++) {
			entries.push({ path: `skills/foo/file-${i}.txt`, data: Buffer.from('x') });
		}
		await expectRejectedAndUntouched(rawTarGz(entries));
	});

	it('rejects an archive exceeding the uncompressed size cap', async () => {
		const big = Buffer.alloc(5 * 1024 * 1024 + 1, 'a');
		const manifest = { sandboxVersion: '1.0.0', builtAt: '', skills: [], allFiles: [{ path: 'skills/foo/big.txt', sha256: sha256(big) }] };
		const buffer = rawTarGz([
			{ path: 'MANIFEST.json', data: Buffer.from(JSON.stringify(manifest)) },
			{ path: 'skills/foo/big.txt', data: big },
		]);
		await expectRejectedAndUntouched(buffer);
	});

	it('rejects a sha256 mismatch against MANIFEST.json', async () => {
		const data = Buffer.from('actual content');
		const manifest = { sandboxVersion: '1.0.0', builtAt: '', skills: [], allFiles: [{ path: 'skills/foo/file.txt', sha256: sha256(Buffer.from('different content')) }] };
		const buffer = rawTarGz([
			{ path: 'MANIFEST.json', data: Buffer.from(JSON.stringify(manifest)) },
			{ path: 'skills/foo/file.txt', data },
		]);
		await expectRejectedAndUntouched(buffer);
	});

	it('rejects a bundle with no MANIFEST.json', async () => {
		const buffer = rawTarGz([{ path: 'skills/foo/file.txt', data: Buffer.from('x') }]);
		await expectRejectedAndUntouched(buffer);
	});

	it('leaves a prior install untouched when a later update is hostile', async () => {
		await installSkillsBundle(buildValidFixture(), workspaceDir, { mode: 'install' });
		const skillMdPath = join(workspaceDir, '.privos', 'skills', 'fake-skill-a', 'SKILL.md');
		const before = readFileSync(skillMdPath, 'utf-8');

		const manifest = { sandboxVersion: '9.9.9', builtAt: '', skills: [], allFiles: [{ path: 'skills/../../etc/passwd', sha256: sha256(Buffer.from('x')) }] };
		const hostile = rawTarGz([
			{ path: 'MANIFEST.json', data: Buffer.from(JSON.stringify(manifest)) },
			{ path: 'skills/../../etc/passwd', data: Buffer.from('x') },
		]);
		await expect(installSkillsBundle(hostile, workspaceDir, { mode: 'update' })).rejects.toThrow(HostileBundleError);
		expect(readFileSync(skillMdPath, 'utf-8')).toBe(before);
	});
});

describe('writeHarnessEnvFile', () => {
	it('writes mode 0600 with the canonical PRIVOS_* keys', () => {
		writeHarnessEnvFile(workspaceDir, {
			PRIVOS_URL: 'https://hub.example',
			PRIVOS_BOT_KEY: 'privos_bottoken',
			PRIVOS_BOT_ID: 'bot-1',
			PRIVOS_ROOM_ID: 'room-1',
			PRIVOS_PROJECT_ID: 'bot-1',
		});
		const envPath = join(workspaceDir, '.env');
		const mode = statSync(envPath).mode & 0o777;
		expect(mode).toBe(0o600);
		const content = readFileSync(envPath, 'utf-8');
		expect(content).toContain('PRIVOS_URL=https://hub.example');
		expect(content).toContain('PRIVOS_BOT_KEY=privos_bottoken');
		expect(content).not.toContain('PRIVOS_CONNECT_URL');
	});

	it('rewrites every PRIVOS_* key on a second call and drops stale ones no longer supplied', () => {
		writeHarnessEnvFile(workspaceDir, {
			PRIVOS_URL: 'https://hub.example',
			PRIVOS_BOT_KEY: 'privos_old',
			PRIVOS_BOT_ID: 'bot-1',
			PRIVOS_ROOM_ID: 'room-1',
			PRIVOS_PROJECT_ID: 'bot-1',
			PRIVOS_CONNECT_URL: 'https://connect.example',
		});
		writeHarnessEnvFile(workspaceDir, {
			PRIVOS_URL: 'https://hub.example',
			PRIVOS_BOT_KEY: 'privos_rotated',
			PRIVOS_BOT_ID: 'bot-1',
			PRIVOS_ROOM_ID: 'room-1',
			PRIVOS_PROJECT_ID: 'bot-1',
		});
		const content = readFileSync(join(workspaceDir, '.env'), 'utf-8');
		expect(content).toContain('PRIVOS_BOT_KEY=privos_rotated');
		expect(content).not.toContain('privos_old');
		expect(content).not.toContain('PRIVOS_CONNECT_URL'); // omitted this time -> dropped, never lingers
	});

	it('preserves a user-added non-PRIVOS_ key across rewrites', () => {
		const { appendFileSync } = require('node:fs') as typeof import('node:fs');
		writeHarnessEnvFile(workspaceDir, {
			PRIVOS_URL: 'https://hub.example',
			PRIVOS_BOT_KEY: 'privos_x',
			PRIVOS_BOT_ID: 'bot-1',
			PRIVOS_ROOM_ID: 'room-1',
			PRIVOS_PROJECT_ID: 'bot-1',
		});
		appendFileSync(join(workspaceDir, '.env'), 'MY_CUSTOM_VAR=kept\n');

		writeHarnessEnvFile(workspaceDir, {
			PRIVOS_URL: 'https://hub.example',
			PRIVOS_BOT_KEY: 'privos_y',
			PRIVOS_BOT_ID: 'bot-1',
			PRIVOS_ROOM_ID: 'room-1',
			PRIVOS_PROJECT_ID: 'bot-1',
		});
		const content = readFileSync(join(workspaceDir, '.env'), 'utf-8');
		expect(content).toContain('MY_CUSTOM_VAR=kept');
		expect(content).toContain('PRIVOS_BOT_KEY=privos_y');
	});
});
