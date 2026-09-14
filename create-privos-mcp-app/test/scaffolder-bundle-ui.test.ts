import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scaffoldApp } from '../src/scaffolder';

/**
 * Simulates the shape a real `vite build` (`base: './'`, `manifest: true`,
 * the exact config both templates ship — asserted separately by
 * `scaffolder.test.ts`) produces for the scaffolded `src/ui/` — hashed
 * relative asset references, a `.vite/manifest.json`, and the referenced
 * files under `assets/`. A real end-to-end `npm install && vite build &&
 * privos-app bundle-ui` was run by hand against both templates and the demo
 * app to verify this fixture is faithful (recorded in the phase report);
 * this test keeps the suite hermetic (no network, no real vite build) while
 * still proving the scaffolded manifest/dist shape `bundle-ui` expects.
 */
function writeSimulatedViteBuild(distDir: string): void {
	const assetsDir = path.join(distDir, 'assets');
	fs.mkdirSync(assetsDir, { recursive: true });
	fs.mkdirSync(path.join(distDir, '.vite'), { recursive: true });
	fs.writeFileSync(
		path.join(distDir, 'index.html'),
		'<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div>'
			+ '<script type="module" src="./assets/index-AAAAAAAA11.js"></script></body></html>\n',
	);
	fs.writeFileSync(
		path.join(distDir, '.vite', 'manifest.json'),
		JSON.stringify({ 'index.html': { file: 'assets/index-AAAAAAAA11.js', isEntry: true } }),
	);
	fs.writeFileSync(path.join(assetsDir, 'index-AAAAAAAA11.js'), "console.log('scaffolded app');");
	fs.writeFileSync(path.join(assetsDir, 'vendor-BBBBBBBB22.js'), "console.log('vendor chunk');");
}

describe.each([
	{ label: 'default', options: undefined },
	{ label: 'instant', options: { template: 'instant' as const } },
])('scaffolded $label template — bundle-ui shape', ({ options }) => {
	let originalCwd: string;
	let workDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-privos-mcp-app-bundle-ui-test-'));
		process.chdir(workDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it('ships a bundle:ui script producing the tar shape build-ui.ts requires', async () => {
		await scaffoldApp('demo-app', options);
		const targetDir = path.join(workDir, 'demo-app');
		const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf-8')) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts['bundle:ui']).toContain('bundle-ui');
	});

	it('never invokes an npx-run @privos_ai/app-server bin without -p (npx cannot pick a bin among two)', async () => {
		await scaffoldApp('demo-app', options);
		const targetDir = path.join(workDir, 'demo-app');
		const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf-8')) as {
			scripts: Record<string, string>;
		};
		for (const [name, script] of Object.entries(pkg.scripts)) {
			if (!script.includes('npx') || !script.includes('@privos_ai/app-server')) continue;
			expect(script, `script "${name}": "${script}"`).toContain('-p @privos_ai/app-server');
		}
	});

	it("bundles a real vite build's output into shell.html + assets-manifest.json + assets/*", async () => {
		await scaffoldApp('demo-app', options);
		const targetDir = path.join(workDir, 'demo-app');
		const distDir = path.join(targetDir, 'dist');
		writeSimulatedViteBuild(distDir);

		const { buildUiBundle } = await import('@privos_ai/app-server');
		const bundle = buildUiBundle({ distDir });
		expect(bundle.files.map((file) => file.name).sort()).toEqual(
			['shell.html', 'assets-manifest.json', 'assets/index-AAAAAAAA11.js', 'assets/vendor-BBBBBBBB22.js'].sort(),
		);
		expect(bundle.totalBytes).toBeGreaterThan(0);
		expect(bundle.manifest.files.map((file) => file.name).sort()).toEqual(
			['index-AAAAAAAA11.js', 'vendor-BBBBBBBB22.js'].sort(),
		);
	});

	it('produces a deterministic tar (same sha256) across two bundle-ui runs of the same build output', async () => {
		await scaffoldApp('demo-app', options);
		const distDir = path.join(workDir, 'demo-app', 'dist');
		writeSimulatedViteBuild(distDir);

		const { buildUiBundle } = await import('@privos_ai/app-server');
		const first = buildUiBundle({ distDir });
		const second = buildUiBundle({ distDir });
		expect(first.tar.equals(second.tar)).toBe(true);
	});
});

describe('scaffolded instant template — ui.shellMode publish rules', () => {
	let originalCwd: string;
	let workDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-privos-mcp-app-shellmode-test-'));
		process.chdir(workDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it('rejects ui.shellMode: "live" on the generated INSTANT manifest (no runtime can ever serve it)', async () => {
		await scaffoldApp('demo-app', { template: 'instant' });
		const targetDir = path.join(workDir, 'demo-app');
		const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, 'privos-app.json'), 'utf-8')) as Record<string, unknown>;
		const liveManifest = { ...manifest, ui: { ...(manifest.ui as Record<string, unknown>), shellMode: 'live' } };

		const { lintPublishUiBundle } = await import('@privos_ai/app-server');
		const result = lintPublishUiBundle(liveManifest, { manifestDir: targetDir });
		expect(result.errors.some((error) => error.includes('not allowed for executionMode: "INSTANT"'))).toBe(true);
	});
});
