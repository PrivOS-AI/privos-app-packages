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

	it('scaffolds no Dockerfile and no server, with the SDK as a devDependency driving local scripts', async () => {
		await scaffoldApp('demo-app', { template: 'instant' });
		const targetDir = path.join(workDir, 'demo-app');

		expect(fs.existsSync(path.join(targetDir, 'Dockerfile'))).toBe(false);
		expect(fs.existsSync(path.join(targetDir, 'tsconfig.server.json'))).toBe(false);
		expect(fs.existsSync(path.join(targetDir, 'src', 'server.ts'))).toBe(false);
		expect(fs.existsSync(path.join(targetDir, 'src', 'ui', 'App.tsx'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'vite.config.ts'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'vitest.config.ts'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'tsconfig.json'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'tests', 'manifest.spec.ts'))).toBe(true);

		const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf-8')) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			engines: { node: string };
			scripts: Record<string, string>;
		};
		// A devDependency: the production dependency scan never sees the SDK of a UI-only app.
		expect(pkg.dependencies?.['@privos_ai/app-server']).toBeUndefined();
		expect(pkg.devDependencies?.['@privos_ai/app-server']).toBe('^0.12.3');
		expect(pkg.devDependencies?.['@privos_ai/app-react']).toBe('^0.8.0');
		expect(pkg.devDependencies?.vite).toBe('^5.0.0');
		expect(pkg.devDependencies?.vitest).toBe('^2.1.9');
		expect(pkg.engines.node).toBe('>=22');
		expect(pkg.scripts.build).toBe('vite build');
		expect(pkg.scripts.test).toBe('vitest run');
		expect(pkg.scripts.typecheck).toBeDefined();
		expect(pkg.scripts['manifest:lint:publish']).toBe('privos-app lint privos-app.json --publish');
	});

	it('produces a privos-app.json declaring executionMode INSTANT with ui.entryPoints and no forbidden fields', async () => {
		await scaffoldApp('demo-app', { template: 'instant' });
		const manifest = JSON.parse(
			fs.readFileSync(path.join(workDir, 'demo-app', 'privos-app.json'), 'utf-8'),
		) as Record<string, unknown>;

		// The Marketplace v3 install protocol (privos-portal's
		// `marketplaceV3ProposalSnapshotFromPreflight`) only ever proposes an
		// install from a schema-v3 manifest — INSTANT is a v3-protocol-only
		// concept, so a scaffolded app that shipped an older schema version
		// could never actually be installed through it.
		expect(manifest.schemaVersion).toBe(3);
		expect(manifest.executionMode).toBe('INSTANT');
		expect(manifest.name).toBe('com.example.demo-app');
		expect(manifest.tools).toBeUndefined();
		expect(manifest.serverUrl).toBeUndefined();
		expect(manifest.runtimeTrustProvisioningUrl).toBeUndefined();
		expect(manifest.port).toBeUndefined();
		expect(manifest.resources).toBeUndefined();
		expect(manifest.volumes).toBeUndefined();
		expect(manifest.stateless).toBeUndefined();
		expect((manifest.ui as { entryPoints: { roomTab: { resourceUri: string } } }).entryPoints.roomTab.resourceUri)
			.toBe('ui://com.example.demo-app/dashboard.html');
		expect((manifest.agent as { purpose: string }).purpose).toBeTruthy();

		// Scopes the app merely can use are optional and say what degrades without them.
		const permissions = manifest.permissions as Array<{ scope: string; requirement: string; reason: string; degradedBehavior?: string }>;
		expect(permissions.filter((p) => p.requirement === 'required')).toHaveLength(1);
		const lists = permissions.find((p) => p.scope === 'lists:read');
		expect(lists?.requirement).toBe('optional');
		expect(lists?.degradedBehavior?.length).toBeGreaterThanOrEqual(10);
		for (const permission of permissions) expect(permission.reason.length).toBeGreaterThanOrEqual(10);
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
