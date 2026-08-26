import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scaffoldApp } from '../src/scaffolder';

describe('scaffoldApp', () => {
	let originalCwd: string;
	let workDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-privos-mcp-app-test-'));
		process.chdir(workDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it('scaffolds the Claude publish skill and the publish:marketplace script', async () => {
		await scaffoldApp('demo-app');
		const targetDir = path.join(workDir, 'demo-app');

		const skillPath = path.join(targetDir, '.claude', 'skills', 'privos-app-publish', 'SKILL.md');
		expect(fs.existsSync(skillPath)).toBe(true);
		const skillContent = fs.readFileSync(skillPath, 'utf-8');
		expect(skillContent).toContain('privos-app publish');

		const errorsRefPath = path.join(targetDir, '.claude', 'skills', 'privos-app-publish', 'references', 'errors.md');
		expect(fs.existsSync(errorsRefPath)).toBe(true);

		const packageJsonPath = path.join(targetDir, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
			name: string;
			scripts: Record<string, string>;
		};
		expect(pkg.scripts['publish:marketplace']).toBe('privos-app publish');
		expect(pkg.scripts['manifest:lint']).toBe('privos-app lint');

		const manifestPath = path.join(targetDir, 'privos-app.json');
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { name: string; version: string };
		// The CLI's identity check requires privos-app.json "name" and package.json
		// "name" to be identical (see src/cli/lib/manifest.ts assertIdentityAgreement
		// in @privos_ai/app-server) — verify the scaffolded template still agrees.
		expect(pkg.name).toBe(manifest.name);
	});

	it('rejects an invalid app name before touching the filesystem', async () => {
		await expect(scaffoldApp('Invalid Name')).rejects.toThrow(/lowercase/);
		expect(fs.existsSync(path.join(workDir, 'Invalid Name'))).toBe(false);
	});
});
