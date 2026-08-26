import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
	packageSource,
	PackagePolicyError,
	evaluateArchiveEntries,
	ENTRY_LIMIT,
	MAX_FILE_BYTES,
	findCredentialLikeFiles,
} from '../../src/cli/lib/package-source.js';
import { createGitFixtureRepo, removeFixtureRepo, standardAppFixtureFiles, writeFixtureFile } from './support/git-fixture-repo.js';

const DEMO_REPO_ROOT = '/Users/roxane/projects/privos-mcp-app-demo';
const PACKAGE_SOURCE_SH = path.join(DEMO_REPO_ROOT, 'scripts/package-source.sh');
const hasDemoRepo = fs.existsSync(PACKAGE_SOURCE_SH);

const fixtures: string[] = [];
function fixtureRepo(files: Parameters<typeof createGitFixtureRepo>[0], options?: Parameters<typeof createGitFixtureRepo>[1]): string {
	const dir = createGitFixtureRepo(files, options);
	fixtures.push(dir);
	return dir;
}

afterEach(() => {
	while (fixtures.length > 0) removeFixtureRepo(fixtures.pop()!);
});

describe('packageSource — dirty tree refusal', () => {
	it('refuses to package when the worktree has uncommitted changes', () => {
		const repo = fixtureRepo(standardAppFixtureFiles('com.example.fixture', '1.0.0'));
		writeFixtureFile(repo, 'src/extra.js', 'console.log("untracked");\n');

		expect(() => packageSource({ cwd: repo, name: 'com.example.fixture', version: '1.0.0', allowDirty: false })).toThrowError(PackagePolicyError);
		try {
			packageSource({ cwd: repo, name: 'com.example.fixture', version: '1.0.0', allowDirty: false });
		} catch (error) {
			expect(error).toBeInstanceOf(PackagePolicyError);
			expect((error as PackagePolicyError).code).toBe('DIRTY_TREE');
		}
	});
});

describe('packageSource — --allow-dirty tree snapshot', () => {
	it('packages a git write-tree snapshot including untracked additions', () => {
		const repo = fixtureRepo(standardAppFixtureFiles('com.example.fixture', '1.0.0'));
		writeFixtureFile(repo, 'src/extra.js', 'console.log("untracked");\n');

		const result = packageSource({ cwd: repo, name: 'com.example.fixture', version: '1.0.0', allowDirty: true });

		expect(result.entries).toContain('src/extra.js');
		expect(result.entries).toContain('privos-app.json');
		expect(result.entries).toContain('Dockerfile');
		expect(fs.existsSync(result.archivePath)).toBe(true);
	});
});

describe('packageSource — .env.example export-ignore', () => {
	it('excludes .env.example from the archive via .gitattributes export-ignore', () => {
		const repo = fixtureRepo(standardAppFixtureFiles('com.example.fixture', '1.0.0'));

		const result = packageSource({ cwd: repo, name: 'com.example.fixture', version: '1.0.0', allowDirty: false });

		expect(result.entries).not.toContain('.env.example');
		expect(result.entries).toContain('privos-app.json');
	});
});

describe('packageSource — missing Dockerfile', () => {
	it('rejects an archive missing the required Dockerfile root entry', () => {
		const files = standardAppFixtureFiles('com.example.fixture', '1.0.0').filter((file) => file.path !== 'Dockerfile');
		const repo = fixtureRepo(files);

		try {
			packageSource({ cwd: repo, name: 'com.example.fixture', version: '1.0.0', allowDirty: false });
			expect.unreachable('expected packageSource to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(PackagePolicyError);
			expect((error as PackagePolicyError).code).toBe('MISSING_REQUIRED_ENTRY');
		}
	});
});

describe('packageSource — credential-file scan', () => {
	it('refuses to package a worktree containing a committed private key', () => {
		const files = [...standardAppFixtureFiles('com.example.fixture', '1.0.0'), { path: 'id_rsa', content: '-----BEGIN OPENSSH PRIVATE KEY-----\n' }];
		const repo = fixtureRepo(files);

		try {
			packageSource({ cwd: repo, name: 'com.example.fixture', version: '1.0.0', allowDirty: false });
			expect.unreachable('expected packageSource to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(PackagePolicyError);
			expect((error as PackagePolicyError).code).toBe('CREDENTIAL_FILE_FOUND');
			expect((error as PackagePolicyError).details).toContain('id_rsa');
		}
	});

	it('does not flag .env.example as a credential file', () => {
		const repo = fixtureRepo(standardAppFixtureFiles('com.example.fixture', '1.0.0'));
		expect(findCredentialLikeFiles(repo)).toEqual([]);
	});
});

describe('evaluateArchiveEntries — entry policy limits (pure, no git needed)', () => {
	it('rejects an entry count above the 20k limit', () => {
		const entries = Array.from({ length: ENTRY_LIMIT + 1 }, (_, index) => ({
			name: index === 0 ? 'privos-app.json' : index === 1 ? 'Dockerfile' : `file-${index}.txt`,
			uncompressedSize: 10,
			isDirectory: false,
		}));
		expect(() => evaluateArchiveEntries(entries)).toThrowError(PackagePolicyError);
		try {
			evaluateArchiveEntries(entries);
		} catch (error) {
			expect((error as PackagePolicyError).code).toBe('ENTRY_LIMIT_EXCEEDED');
		}
	});

	it('rejects a single file above the 50 MB per-file limit', () => {
		const entries = [
			{ name: 'privos-app.json', uncompressedSize: 10, isDirectory: false },
			{ name: 'Dockerfile', uncompressedSize: 10, isDirectory: false },
			{ name: 'big.bin', uncompressedSize: MAX_FILE_BYTES + 1, isDirectory: false },
		];
		try {
			evaluateArchiveEntries(entries);
			expect.unreachable('expected evaluateArchiveEntries to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(PackagePolicyError);
			expect((error as PackagePolicyError).code).toBe('FILE_SIZE_EXCEEDED');
			expect((error as PackagePolicyError).details).toContain('big.bin');
		}
	});

	it('rejects denied paths (node_modules, .env, path traversal)', () => {
		const base = [
			{ name: 'privos-app.json', uncompressedSize: 10, isDirectory: false },
			{ name: 'Dockerfile', uncompressedSize: 10, isDirectory: false },
		];
		for (const deniedName of ['node_modules/pkg/index.js', '.env', '.env.local', '../outside.txt', 'secrets/id_rsa', 'a.pem', 'a.key']) {
			expect(() => evaluateArchiveEntries([...base, { name: deniedName, uncompressedSize: 10, isDirectory: false }])).toThrowError(PackagePolicyError);
		}
	});

	it('accepts a well-formed entry list', () => {
		expect(() =>
			evaluateArchiveEntries([
				{ name: 'privos-app.json', uncompressedSize: 10, isDirectory: false },
				{ name: 'Dockerfile', uncompressedSize: 10, isDirectory: false },
				{ name: 'src/', uncompressedSize: 0, isDirectory: true },
				{ name: 'src/index.js', uncompressedSize: 42, isDirectory: false },
			]),
		).not.toThrow();
	});
});

describe.skipIf(!hasDemoRepo)('packageSource — sha256 parity with scripts/package-source.sh', () => {
	it('produces byte-identical archives (same sha256, same size) as the reference shell script on the same commit', () => {
		const repo = fixtureRepo(standardAppFixtureFiles('parity.fixture.app', '3.2.1'));

		const ours = packageSource({ cwd: repo, name: 'parity.fixture.app', version: '3.2.1', allowDirty: false });

		const shellResult = spawnSync('bash', [PACKAGE_SOURCE_SH], { cwd: repo, encoding: 'utf8' });
		expect(shellResult.status, shellResult.stderr).toBe(0);
		const shellArchivePath = path.join(repo, 'dist-source', 'parity.fixture.app-3.2.1.zip');
		const shellBuffer = fs.readFileSync(shellArchivePath);
		const shellSha256 = crypto.createHash('sha256').update(shellBuffer).digest('hex');

		expect(ours.sha256).toBe(shellSha256);
		expect(ours.bytes).toBe(shellBuffer.length);
	});
});

// Sanity check that HEAD-based packaging is stable across the two commands used in fixtures.
describe('packageSource — repository resolution', () => {
	it('resolves the git worktree root even when invoked from a subdirectory', () => {
		const repo = fixtureRepo(standardAppFixtureFiles('com.example.fixture', '1.0.0'));
		const subdir = path.join(repo, 'src');
		const result = packageSource({ cwd: subdir, name: 'com.example.fixture', version: '1.0.0', allowDirty: false });
		expect(result.repoRoot).toBe(fs.realpathSync(repo));
		expect(result.gitRevision).toMatch(/^[0-9a-f]{40}$/);
	});
});
