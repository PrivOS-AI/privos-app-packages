import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	applyPlaceholders,
	canonicalListingSlug,
	describeScaffold,
	nodeVersionWarning,
	scaffoldApp,
	validateAppId,
} from '../src/scaffolder';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

function readJson<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

/** Every file under `dir` except the copied publish skill (its text is not the template's). */
function templateFiles(dir: string): string[] {
	const found: string[] = [];
	const walk = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.name === '.git' || entry.name === '.claude') continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else found.push(full);
		}
	};
	walk(dir);
	return found;
}

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
		expect(fs.readFileSync(skillPath, 'utf-8')).toContain('privos-app publish');

		const errorsRefPath = path.join(targetDir, '.claude', 'skills', 'privos-app-publish', 'references', 'errors.md');
		expect(fs.existsSync(errorsRefPath)).toBe(true);

		const pkg = readJson<{ name: string; scripts: Record<string, string> }>(path.join(targetDir, 'package.json'));
		expect(pkg.scripts['publish:marketplace']).toBe('privos-app publish');
		expect(pkg.scripts['manifest:lint']).toBe('privos-app lint privos-app.json');
		expect(pkg.scripts['manifest:lint:publish']).toBe('privos-app lint privos-app.json --publish');

		const manifest = readJson<{ name: string; version: string }>(path.join(targetDir, 'privos-app.json'));
		// The CLI's identity check requires privos-app.json "name" and package.json
		// "name" to be identical (assertIdentityAgreement in @privos_ai/app-server).
		expect(pkg.name).toBe(manifest.name);
	});

	it('rejects an invalid app name before touching the filesystem', async () => {
		await expect(scaffoldApp('Invalid Name')).rejects.toThrow(/lowercase/);
		expect(fs.existsSync(path.join(workDir, 'Invalid Name'))).toBe(false);
	});

	it('pins the released SDKs, Node 22, vite 5 and vitest 2', async () => {
		await scaffoldApp('demo-app');
		const pkg = readJson<{
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
			engines: { node: string };
			scripts: Record<string, string>;
		}>(path.join(workDir, 'demo-app', 'package.json'));

		expect(pkg.dependencies['@privos_ai/app-server']).toBe('^0.12.3');
		expect(pkg.devDependencies['@privos_ai/app-react']).toBe('^0.8.0');
		expect(pkg.devDependencies.vite).toBe('^5.0.0');
		expect(pkg.devDependencies.vitest).toBe('^2.1.9');
		expect(pkg.engines.node).toBe('>=22');
		expect(pkg.scripts.test).toBe('vitest run');
		expect(pkg.scripts.typecheck).toBeDefined();
		expect(pkg.scripts.pair).toContain('scripts/pair.ts');
		expect(pkg.scripts.start).toBe('node dist-server/server.js');
	});

	it('ships a schema v3 default manifest that declares identity, data handling and optional scopes', async () => {
		await scaffoldApp('demo-app');
		const manifest = readJson<Record<string, any>>(path.join(workDir, 'demo-app', 'privos-app.json'));

		expect(manifest.schemaVersion).toBe(3);
		expect(manifest.name).toBe('com.example.demo-app');
		expect(manifest.stateless).toBe(true);
		expect(manifest.capabilities).toEqual({ verifiedActor: true });
		expect(manifest.dataPolicy.retention.length).toBeGreaterThanOrEqual(10);
		expect(manifest.runtimeTrustProvisioningUrl).toBeUndefined();
		expect(manifest.executionMode).toBeUndefined();

		const required = manifest.permissions.filter((p: { requirement: string }) => p.requirement === 'required');
		expect(required).toHaveLength(1);
		const lists = manifest.permissions.find((p: { scope: string }) => p.scope === 'lists:read');
		expect(lists.requirement).toBe('optional');
		expect(lists.degradedBehavior.length).toBeGreaterThanOrEqual(10);
		for (const permission of manifest.permissions) {
			expect(permission.reason.length).toBeGreaterThanOrEqual(10);
			expect(permission.feature).toMatch(/^[a-z0-9][a-z0-9._-]{1,127}$/);
		}

		// The example tools take no room argument: the room comes from the verified context.
		for (const tool of manifest.tools) {
			expect(tool.title).toBeTruthy();
			expect(JSON.stringify(tool.inputSchema)).not.toContain('roomId');
		}
	});

	it('wires the default server through serveApp with a manifest-only production fallback', async () => {
		await scaffoldApp('demo-app');
		const targetDir = path.join(workDir, 'demo-app');

		const serverSource = fs.readFileSync(path.join(targetDir, 'src', 'server.ts'), 'utf-8');
		expect(serverSource).toContain('serveApp(');
		expect(serverSource).toContain('serveBuiltUi');
		expect(serverSource).toContain('PRODUCTION_WITHOUT_IDENTITY');
		expect(serverSource).toContain('/health');
		expect(serverSource).toContain('/ready');
		expect(serverSource).not.toContain('PRIVOS_RUNTIME_SECURITY_MODE');
		expect(serverSource).not.toContain('your-hub.example.com');
		expect(serverSource).not.toContain('/api/me');
		expect(serverSource).not.toContain('requirePrivosUser');
		expect(serverSource).not.toContain('app.use(express.static');
		for (const file of templateFiles(targetDir)) {
			expect(fs.readFileSync(file, 'utf-8'), file).not.toMatch(/\{\{APP_(NAME|ID)\}\}/);
		}

		// Pairing: the one-time URL is read from standard input, never from argv, and
		// nothing is written to .env.
		const pairSource = fs.readFileSync(path.join(targetDir, 'scripts', 'pair.ts'), 'utf-8');
		expect(pairSource).toContain('pairAndAwaitApproval');
		expect(pairSource).toContain('process.stdin');
		expect(pairSource).not.toContain('process.argv');
		expect(pairSource).not.toContain('.env');

		const uiSource = fs.readFileSync(path.join(targetDir, 'src', 'ui', 'App.tsx'), 'utf-8');
		expect(uiSource).toContain("usePrivosCapability('lists:read')");

		// Wire contract: the `ui://` host of every tool equals the manifest name.
		const manifest = readJson<{ name: string; tools: Array<{ ui?: { resourceUri?: string } }> }>(
			path.join(targetDir, 'privos-app.json'),
		);
		const resourceUri = manifest.tools[0]?.ui?.resourceUri;
		expect(resourceUri).toBeDefined();
		expect(new URL(resourceUri!).host).toBe(manifest.name);

		const viteConfigSource = fs.readFileSync(path.join(targetDir, 'vite.config.ts'), 'utf-8');
		expect(viteConfigSource).toContain("base: './'");
		expect(viteConfigSource).toContain('publicDir: false');
		expect(viteConfigSource).toContain('manifest: true');
		expect(viteConfigSource).toContain('sourcemap: false');

		const mainSource = fs.readFileSync(path.join(targetDir, 'src', 'ui', 'main.tsx'), 'utf-8');
		expect(mainSource).toContain('__privosUiBooted = true');
		expect(mainSource).toContain('LazyBoundary');
	});

	it('scaffolds a vitest config apart from the vite config, and a tsconfig that covers the UI and the tests', async () => {
		await scaffoldApp('demo-app');
		const targetDir = path.join(workDir, 'demo-app');

		const vitestConfig = fs.readFileSync(path.join(targetDir, 'vitest.config.ts'), 'utf-8');
		expect(vitestConfig).toContain("root: '.'");
		expect(vitestConfig).toContain("NODE_ENV: 'test'");
		expect(vitestConfig).toContain("environment: 'node'");
		expect(vitestConfig).toContain('tests/**/*.spec.ts');
		expect(fs.readFileSync(path.join(targetDir, 'vite.config.ts'), 'utf-8')).not.toContain('test:');

		const tsconfig = readJson<{ include: string[] }>(path.join(targetDir, 'tsconfig.json'));
		expect(tsconfig.include).toEqual(expect.arrayContaining(['src', 'tests']));
		expect(fs.existsSync(path.join(targetDir, 'tests', 'manifest.spec.ts'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'tests', 'tools.spec.ts'))).toBe(true);
	});

	it('ships a Dockerfile that is non-root, Node 22, without npm at runtime, with the manifest port and a health check', async () => {
		await scaffoldApp('demo-app');
		const targetDir = path.join(workDir, 'demo-app');
		const dockerfile = fs.readFileSync(path.join(targetDir, 'Dockerfile'), 'utf-8');
		const manifest = readJson<{ port: number }>(path.join(targetDir, 'privos-app.json'));

		expect(dockerfile).toContain('FROM node:22-alpine');
		expect(dockerfile).not.toMatch(/node:20/);
		expect(dockerfile).toContain('npm ci');
		expect(dockerfile).toContain('USER node');
		expect(dockerfile).toContain('rm -rf /usr/local/lib/node_modules/npm');
		expect(dockerfile).toContain(`EXPOSE ${manifest.port}`);
		expect(dockerfile).toContain(`PORT=${manifest.port}`);
		expect(dockerfile).toMatch(/HEALTHCHECK .*\/health/);
		expect(dockerfile).not.toContain('PRIVOS_RUNTIME_SECURITY_MODE');
	});

	it('keeps secrets out of the Docker build context', async () => {
		await scaffoldApp('demo-app');
		const entries = fs
			.readFileSync(path.join(workDir, 'demo-app', '.dockerignore'), 'utf-8')
			.split('\n')
			.map((line) => line.trim());
		for (const secret of ['.env', '.env.*', '**/.env', 'privos-standalone-identity*', '.npmrc', '*.pem', '*.key', '.git', 'node_modules', 'dist-source']) {
			expect(entries, secret).toContain(secret);
		}
	});

	it('constructs the runtime without tripping the split-build UI identity guard', async () => {
		await scaffoldApp('demo-app');
		const manifest = readJson<{ name: string; tools: Array<{ ui?: { resourceUri?: string } }> }>(
			path.join(workDir, 'demo-app', 'privos-app.json'),
		);
		const resourceUri = manifest.tools[0]!.ui!.resourceUri!;

		// @privos_ai/app-server exposes `AppServerRuntime`, whose constructor runs
		// the exact guard serveApp triggers for the scaffolded UI provider: a
		// split-build UI (readAsset/readAssetsManifest present) must have ui.uri's
		// host, the assetUriPrefix slug, and descriptor.id all equal.
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

		expect(() => new AppServerRuntime({
			descriptor,
			handler: noopHandler,
			ui: splitBuildUi(resourceUri, `ui://${manifest.name}/assets/`),
		})).not.toThrow();

		// The bare-name slug must still trip the guard — proves the check above is not vacuous.
		expect(() => new AppServerRuntime({
			descriptor,
			handler: noopHandler,
			ui: splitBuildUi('ui://demo-app/dashboard.html', 'ui://demo-app/assets/'),
		})).toThrow(/Split-build UI identity mismatch/);
	});
});

describe('app id', () => {
	let originalCwd: string;
	let workDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-privos-mcp-app-id-test-'));
		process.chdir(workDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it.each([
		{ label: 'default', template: undefined },
		{ label: 'instant', template: 'instant' },
	])('writes --id into package.json, privos-app.json and every ui:// URI ($label template)', async ({ template }) => {
		const result = await scaffoldApp('demo-app', { template, id: 'ai.acme.demo_app-1' });
		const targetDir = path.join(workDir, 'demo-app');

		expect(result.appId).toBe('ai.acme.demo_app-1');
		expect(result.idIsPlaceholder).toBe(false);
		expect(readJson<{ name: string }>(path.join(targetDir, 'package.json')).name).toBe('ai.acme.demo_app-1');
		const manifestText = fs.readFileSync(path.join(targetDir, 'privos-app.json'), 'utf-8');
		const manifest = JSON.parse(manifestText) as { name: string };
		expect(manifest.name).toBe('ai.acme.demo_app-1');
		const uris = manifestText.match(/ui:\/\/[^"]+/g) ?? [];
		expect(uris.length).toBeGreaterThan(0);
		for (const uri of uris) expect(new URL(uri).host).toBe('ai.acme.demo_app-1');
		expect(describeScaffold(result).warnings.join('\n')).not.toContain('placeholder');
		for (const file of templateFiles(targetDir)) {
			expect(fs.readFileSync(file, 'utf-8'), file).not.toContain('com.example.demo-app');
		}
	});

	it('defaults to the com.example placeholder and says it must be replaced', async () => {
		const result = await scaffoldApp('demo-app');
		expect(result.appId).toBe('com.example.demo-app');
		expect(result.idIsPlaceholder).toBe(true);
		const { warnings } = describeScaffold(result);
		expect(warnings.some((w) => w.includes('placeholder "com.example.demo-app"') && w.includes('before publishing'))).toBe(true);
	});

	it.each([
		['uppercase letters', 'Ai.Acme.App', /invalid/],
		['a leading dot', '.acme.app', /invalid/],
		['a single character', 'a', /invalid/],
		['a slash', 'ai/acme', /invalid/],
		['a replacement-string special', 'ai.acme.$&', /invalid/],
		['an empty value', '', /invalid/],
		['more than 128 characters', `a${'b'.repeat(128)}`, /invalid/],
		['a listing slug longer than 63 characters', `ai.acme.${'x'.repeat(60)}`, /listing slug/],
		['a listing slug of one character', 'a.', /invalid|listing slug/],
	])('rejects an id with %s before touching the filesystem', async (_label, id, message) => {
		await expect(scaffoldApp('demo-app', { id })).rejects.toThrow(message);
		expect(fs.existsSync(path.join(workDir, 'demo-app'))).toBe(false);
	});

	it('accepts an id whose listing slug is exactly 63 characters', () => {
		const id = `ai.acme.${'x'.repeat(55)}`;
		expect(canonicalListingSlug(id)).toHaveLength(63);
		expect(validateAppId(id)).toBeUndefined();
		expect(validateAppId(`${id}x`)).toMatch(/listing slug/);
	});

	it('derives the listing slug the way the Portal does', () => {
		expect(canonicalListingSlug('ai.privos.mcp-app-demo')).toBe('ai-privos-mcp-app-demo');
		expect(canonicalListingSlug('ai.acme__app.v2')).toBe('ai-acme-app-v2');
	});

	it('substitutes placeholders literally: $&, $1, $$ and $` in a value are not replacement patterns', () => {
		const tricky = '$& $1 $$ $` $\'';
		expect(applyPlaceholders('{{APP_NAME}}|{{APP_ID}}|{{APP_NAME}}', tricky, tricky)).toBe(`${tricky}|${tricky}|${tricky}`);
	});
});

describe('git repository', () => {
	let originalCwd: string;
	let originalPath: string | undefined;
	let workDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		originalPath = process.env.PATH;
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-privos-mcp-app-git-test-'));
		process.chdir(workDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		process.env.PATH = originalPath;
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it.skipIf(!gitAvailable)('initializes a repository on main in a fresh directory and never commits', async () => {
		const result = await scaffoldApp('demo-app');
		const targetDir = path.join(workDir, 'demo-app');

		expect(result.git).toEqual({ status: 'initialized' });
		expect(fs.existsSync(path.join(targetDir, '.git'))).toBe(true);
		expect(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: targetDir, encoding: 'utf-8' }).trim()).toBe('main');
		expect(spawnSync('git', ['rev-parse', '-q', '--verify', 'HEAD'], { cwd: targetDir }).status).not.toBe(0);
		expect(execFileSync('git', ['status', '--porcelain'], { cwd: targetDir, encoding: 'utf-8' })).toContain('privos-app.json');

		const { steps, warnings } = describeScaffold(result);
		expect(warnings).toEqual(expect.not.arrayContaining([expect.stringContaining('git')]));
		expect(steps).toEqual(expect.arrayContaining(['cd demo-app', 'npm install --include=dev']));
		expect(steps.join('\n')).toContain('package-lock.json');
	});

	it.skipIf(!gitAvailable)('does not start a nested repository inside an existing work tree, and explains why', async () => {
		execFileSync('git', ['init', '-b', 'main'], { cwd: workDir, stdio: 'ignore' });
		const result = await scaffoldApp('demo-app');
		const targetDir = path.join(workDir, 'demo-app');

		expect(result.git.status).toBe('inside-work-tree');
		expect(fs.existsSync(path.join(targetDir, '.git'))).toBe(false);
		const warning = describeScaffold(result).warnings.join('\n');
		expect(warning).toContain('own repository root');
		expect(warning).toContain('inside the git repository');
	});

	it('scaffolds and explains when git is not on PATH', async () => {
		const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'create-privos-mcp-app-nogit-'));
		try {
			process.env.PATH = emptyBin;
			const result = await scaffoldApp('demo-app');

			expect(result.git).toEqual({ status: 'unavailable' });
			expect(fs.existsSync(path.join(workDir, 'demo-app', 'package.json'))).toBe(true);
			expect(fs.existsSync(path.join(workDir, 'demo-app', '.git'))).toBe(false);
			const warning = describeScaffold(result).warnings.join('\n');
			expect(warning).toContain('git was not found');
			expect(warning).toContain('own repository root');
		} finally {
			fs.rmSync(emptyBin, { recursive: true, force: true });
		}
	});

	it('reports a git failure without failing the scaffold', async () => {
		const brokenBin = fs.mkdtempSync(path.join(os.tmpdir(), 'create-privos-mcp-app-brokengit-'));
		try {
			fs.writeFileSync(path.join(brokenBin, 'git'), '#!/bin/sh\necho "fatal: simulated failure" >&2\nexit 7\n', { mode: 0o755 });
			process.env.PATH = brokenBin;
			const result = await scaffoldApp('demo-app');

			expect(result.git.status).toBe('failed');
			expect(fs.existsSync(path.join(workDir, 'demo-app', 'package.json'))).toBe(true);
			expect(describeScaffold(result).warnings.join('\n')).toContain('simulated failure');
		} finally {
			fs.rmSync(brokenBin, { recursive: true, force: true });
		}
	});
});

describe('template ignore file', () => {
	let originalCwd: string;
	let workDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-privos-mcp-app-ignore-test-'));
		process.chdir(workDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it.each(['default', 'instant'])('renames gitignore to .gitignore and ships .gitattributes (%s)', async (template) => {
		await scaffoldApp('demo-app', { template });
		const targetDir = path.join(workDir, 'demo-app');

		expect(fs.existsSync(path.join(targetDir, '.gitignore'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'gitignore'))).toBe(false);
		const attributes = fs.readFileSync(path.join(targetDir, '.gitattributes'), 'utf-8');
		for (const entry of ['/.claude', '/.agents', '/.gemini', '/CLAUDE.md', '/AGENTS.md', '/dist-source']) {
			expect(attributes).toContain(`${entry} export-ignore`);
		}
	});

	describe.skipIf(!gitAvailable)('git check-ignore', () => {
		it.each(['default', 'instant'])('ignores secrets and build output but never the lockfile or .env.example (%s)', async (template) => {
			await scaffoldApp('demo-app', { template });
			const targetDir = path.join(workDir, 'demo-app');
			const ignored = (file: string) => spawnSync('git', ['check-ignore', '-q', file], { cwd: targetDir }).status === 0;

			for (const file of [
				'node_modules/x/index.js',
				'dist/index.html',
				'dist-server/server.js',
				'dist-source/app.zip',
				'ui-bundle.tar',
				'.env',
				'.env.local',
				'.env.production',
				'sub/dir/.env',
				'sub/.env.local',
				'privos-standalone-identity.json',
				'privos-standalone-identity.pending.json',
				'.npmrc',
				'server.key',
				'sub/tls.pem',
				'.claude/settings.local.json',
			]) {
				expect(ignored(file), `${file} must be ignored`).toBe(true);
			}
			for (const file of [
				'package-lock.json',
				'package.json',
				'privos-app.json',
				'.env.example',
				'sub/.env.example',
				'src/ui/App.tsx',
				'.claude/skills/privos-app-publish/SKILL.md',
				'.gitattributes',
			]) {
				expect(ignored(file), `${file} must not be ignored`).toBe(false);
			}
		});
	});
});

describe('nodeVersionWarning', () => {
	it('warns below Node 22 and stays quiet from 22 on', () => {
		expect(nodeVersionWarning('v20.11.1')).toMatch(/older than 22/);
		expect(nodeVersionWarning('18.0.0')).toMatch(/older than 22/);
		expect(nodeVersionWarning('v22.0.0')).toBeUndefined();
		expect(nodeVersionWarning('v24.1.0')).toBeUndefined();
	});
});
