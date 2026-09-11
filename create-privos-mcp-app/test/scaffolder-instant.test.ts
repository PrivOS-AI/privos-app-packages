import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scaffoldApp, SCAFFOLD_TEMPLATES } from '../src/scaffolder';

describe('scaffoldApp — --template instant', () => {
	let originalCwd: string;
	let workDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-privos-mcp-app-instant-test-'));
		process.chdir(workDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it('lists default and instant as the known templates', () => {
		expect(SCAFFOLD_TEMPLATES).toEqual(['default', 'instant']);
	});

	it('scaffolds no Dockerfile, no server, and no @privos_ai/app-server dependency', async () => {
		await scaffoldApp('demo-app', { template: 'instant' });
		const targetDir = path.join(workDir, 'demo-app');

		expect(fs.existsSync(path.join(targetDir, 'Dockerfile'))).toBe(false);
		expect(fs.existsSync(path.join(targetDir, 'tsconfig.server.json'))).toBe(false);
		expect(fs.existsSync(path.join(targetDir, 'src', 'server.ts'))).toBe(false);
		expect(fs.existsSync(path.join(targetDir, 'src', 'ui', 'App.tsx'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'vite.config.ts'))).toBe(true);

		const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf-8')) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			scripts: Record<string, string>;
		};
		expect(pkg.dependencies?.['@privos_ai/app-server']).toBeUndefined();
		expect(pkg.devDependencies?.['@privos_ai/app-server']).toBeUndefined();
		expect(pkg.scripts.build).toBe('vite build');
	});

	it('produces a privos-app.json declaring executionMode INSTANT with ui.entryPoints and no forbidden fields', async () => {
		await scaffoldApp('demo-app', { template: 'instant' });
		const manifest = JSON.parse(
			fs.readFileSync(path.join(workDir, 'demo-app', 'privos-app.json'), 'utf-8'),
		) as Record<string, unknown>;

		expect(manifest.executionMode).toBe('INSTANT');
		expect(manifest.name).toBe('com.privos.demo-app');
		expect(manifest.tools).toBeUndefined();
		expect(manifest.serverUrl).toBeUndefined();
		expect(manifest.runtimeTrustProvisioningUrl).toBeUndefined();
		expect(manifest.port).toBeUndefined();
		expect(manifest.resources).toBeUndefined();
		expect(manifest.volumes).toBeUndefined();
		expect(manifest.stateless).toBeUndefined();
		expect((manifest.ui as { entryPoints: { roomTab: { resourceUri: string } } }).entryPoints.roomTab.resourceUri)
			.toBe('ui://com.privos.demo-app/dashboard.html');
		expect((manifest.agent as { purpose: string }).purpose).toBeTruthy();
	});

	it('passes the new INSTANT lint rules end to end', async () => {
		await scaffoldApp('demo-app', { template: 'instant' });
		const manifest = JSON.parse(
			fs.readFileSync(path.join(workDir, 'demo-app', 'privos-app.json'), 'utf-8'),
		) as unknown;

		const { lintManifest, lintInstantManifest } = await import('@privos_ai/app-server');
		expect(lintManifest(manifest)).toMatchObject({ valid: true });
		expect(lintInstantManifest(manifest).errors).toEqual([]);
	});

	it('still scaffolds the default template unchanged when --template is omitted', async () => {
		await scaffoldApp('demo-app');
		expect(fs.existsSync(path.join(workDir, 'demo-app', 'Dockerfile'))).toBe(true);
		expect(fs.existsSync(path.join(workDir, 'demo-app', 'src', 'server.ts'))).toBe(true);
	});

	it('rejects an unknown template name before touching the filesystem', async () => {
		await expect(scaffoldApp('demo-app', { template: 'bogus' })).rejects.toThrow(/Unknown template "bogus"/);
		expect(fs.existsSync(path.join(workDir, 'demo-app'))).toBe(false);
	});
});
