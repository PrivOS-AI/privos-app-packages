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

	it('wires the scaffolded UI to serveBuiltUi with no leftover placeholders', async () => {
		await scaffoldApp('demo-app');
		const targetDir = path.join(workDir, 'demo-app');

		const serverSource = fs.readFileSync(path.join(targetDir, 'src', 'server.ts'), 'utf-8');
		expect(serverSource).toContain('serveBuiltUi');
		expect(serverSource).toContain("uri: `ui://${APP_ID}/dashboard.html`");
		expect(serverSource).toContain('appSlug: APP_ID');
		expect(serverSource).toContain('assetUriPrefix: builtUi.assetUriPrefix');
		expect(serverSource).not.toContain('app.use(express.static');
		expect(serverSource).not.toContain('{{APP_NAME}}');
		expect(serverSource).not.toContain('{{APP_ID}}');

		// Wire contract: appSlug = app.appId = manifest id (privos-app.json
		// "name"), used as the `ui://` host for both the shell and the split
		// assets — never the bare display name. Assert the generated
		// resourceUri's host equals the generated manifest's "name".
		const manifest = JSON.parse(
			fs.readFileSync(path.join(targetDir, 'privos-app.json'), 'utf-8'),
		) as { name: string; tools: Array<{ ui?: { resourceUri?: string } }> };
		const resourceUri = manifest.tools[0]?.ui?.resourceUri;
		expect(resourceUri).toBeDefined();
		expect(new URL(resourceUri!).host).toBe(manifest.name);
		expect(manifest.name).toBe('com.privos.demo-app');

		const viteConfigSource = fs.readFileSync(path.join(targetDir, 'vite.config.ts'), 'utf-8');
		expect(viteConfigSource).toContain("base: './'");
		expect(viteConfigSource).toContain('publicDir: false');
		expect(viteConfigSource).toContain('manifest: true');
		expect(viteConfigSource).toContain('sourcemap: false');

		expect(fs.existsSync(path.join(targetDir, 'src', 'ui', 'lazy-boundary.tsx'))).toBe(true);
		const mainSource = fs.readFileSync(path.join(targetDir, 'src', 'ui', 'main.tsx'), 'utf-8');
		expect(mainSource).toContain('__privosUiBooted = true');
		expect(mainSource).toContain('LazyBoundary');

		const pkg = JSON.parse(
			fs.readFileSync(path.join(targetDir, 'package.json'), 'utf-8'),
		) as { dependencies: Record<string, string>; scripts: Record<string, string> };
		expect(pkg.dependencies['@privos_ai/app-server']).toBe('^0.10.0');
		expect(pkg.scripts.start).toBe('node dist-server/server.js');
	});

	it('constructs the runtime without tripping the split-build UI identity guard', async () => {
		await scaffoldApp('demo-app');
		const targetDir = path.join(workDir, 'demo-app');

		const manifest = JSON.parse(
			fs.readFileSync(path.join(targetDir, 'privos-app.json'), 'utf-8'),
		) as { name: string; tools: Array<{ ui?: { resourceUri?: string } }> };
		const resourceUri = manifest.tools[0]!.ui!.resourceUri!;

		// @privos_ai/app-server exposes `AppServerRuntime`, whose constructor runs
		// the exact guard `createDirectRouter`/`connectRelay` trigger when they
		// build the runtime for `dashboardUi` in the scaffolded server.ts: a
		// split-build UI (readAsset/readAssetsManifest present) must have
		// ui.uri's host, the assetUriPrefix slug, and descriptor.id all equal.
		const { AppServerRuntime } = await import('@privos_ai/app-server');
		const noopHandler = async () => ({ tools: [] });
		const descriptor = { id: manifest.name, name: manifest.name, version: '1.0.0' };
		const splitBuildUi = (uri: string, assetUriPrefix?: string) => ({
			uri,
			renderHtml: async () => '<!doctype html><html><head></head><body></body></html>',
			readAsset: () => null,
			readAssetsManifest: () => ({ files: [] }),
			...(assetUriPrefix ? { assetUriPrefix } : {}),
		});

		// Exactly what the scaffolded server.ts produces for dashboardUi: passes.
		expect(() => new AppServerRuntime({
			descriptor,
			handler: noopHandler,
			ui: splitBuildUi(resourceUri, `ui://${manifest.name}/assets/`),
		})).not.toThrow();

		// The bare-name slug this fix replaced must still trip the guard — proves
		// the check above is meaningful, not vacuous.
		expect(() => new AppServerRuntime({
			descriptor,
			handler: noopHandler,
			ui: splitBuildUi('ui://demo-app/dashboard.html', 'ui://demo-app/assets/'),
		})).toThrow(/Split-build UI identity mismatch/);
	});
});
