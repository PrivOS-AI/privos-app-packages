import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type GitFixtureFile = Readonly<{ path: string; content: string }>;

export function runGit(cwd: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

export function writeFixtureFile(repoDir: string, relativePath: string, content: string): void {
	const filePath = path.join(repoDir, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

/** Creates a temp git repo, writes `files`, and commits everything (unless `commit` is false). */
export function createGitFixtureRepo(files: readonly GitFixtureFile[], options: Readonly<{ commit?: boolean }> = {}): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privos-app-cli-fixture-'));
	runGit(dir, ['init', '-q', '-b', 'main']);
	runGit(dir, ['config', 'user.email', 'cli-test@example.com']);
	runGit(dir, ['config', 'user.name', 'CLI Test']);
	for (const file of files) writeFixtureFile(dir, file.path, file.content);
	if (options.commit ?? true) {
		runGit(dir, ['add', '--all']);
		runGit(dir, ['commit', '-q', '-m', 'initial commit']);
	}
	return dir;
}

export function removeFixtureRepo(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/** A minimal, valid PrivOS MCP app worktree: `privos-app.json`, `package.json`, `Dockerfile`, `.env.example` export-ignored. */
export function standardAppFixtureFiles(name: string, version: string): GitFixtureFile[] {
	const manifest = {
		schemaVersion: 2,
		kind: 'mcp-app',
		name,
		version,
		title: 'Fixture App',
		description: 'A fixture app for CLI tests.',
		permissions: [
			{
				scope: 'workspace:read',
				requirement: 'required',
				context: 'workspace',
				executionContext: 'user',
				feature: 'demo.read',
				reason: 'Read fixture records for the demo feature.',
			},
		],
	};
	const pkg = { name, version, private: true };
	return [
		{ path: 'privos-app.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
		{ path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
		{ path: 'Dockerfile', content: 'FROM node:22-slim\nCMD ["node", "src/index.js"]\n' },
		{ path: '.gitattributes', content: '.env.example export-ignore\n' },
		{ path: '.env.example', content: 'API_KEY=replace-me\n' },
		{ path: '.gitignore', content: 'dist-source/\n' },
		{ path: 'src/index.js', content: "console.log('fixture app');\n" },
	];
}
