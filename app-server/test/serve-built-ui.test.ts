import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppServerRuntime, type UiResourceProvider } from '../src/runtime.js';
import { serveBuiltUi } from '../src/ui/serve-built-ui.js';
import type { AppDescriptor } from '../src/app-descriptor.js';

const APP_SLUG = 'ai.privos.demo';

const JS_FILE = 'index-ABCDEFGH12.js';
const CSS_FILE = 'index-ABCDEFGH13.css';
const WOFF_FILE = 'font-ABCDEFGH14.woff2';
const GZ_FILE = 'sample-agent-set.tar-ABCDEFGH15.gz';

const JS_CONTENT = "console.log('demo');";
const CSS_CONTENT = 'body{margin:0}';
const WOFF_CONTENT = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const GZ_CONTENT = Buffer.from([31, 139, 8, 0, 0, 0, 0, 0]);

function viteManifestJson(): string {
	return JSON.stringify({
		'index.html': {
			file: `assets/${JS_FILE}`,
			css: [`assets/${CSS_FILE}`],
			isEntry: true,
		},
	});
}

function shellHtml(options: { withMeta?: boolean; scriptSrc?: string; linkHref?: string } = {}): string {
	const meta = options.withMeta ? '<meta name="privos-ui-assets" content="relay">\n' : '';
	const scriptSrc = options.scriptSrc ?? `./assets/${JS_FILE}`;
	const linkHref = options.linkHref ?? `./assets/${CSS_FILE}`;
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${meta}<link rel="stylesheet" href="${linkHref}">
</head>
<body>
<div id="root"></div>
<script type="module" src="${scriptSrc}"></script>
</body>
</html>
`;
}

/** Writes a valid Vite dist dir: index.html + .vite/manifest.json + assets/(js,css,woff2,gz). */
function writeValidFixture(distDir: string, htmlOptions?: Parameters<typeof shellHtml>[0]): void {
	const assetsDir = path.join(distDir, 'assets');
	fs.mkdirSync(assetsDir, { recursive: true });
	fs.mkdirSync(path.join(distDir, '.vite'), { recursive: true });
	fs.writeFileSync(path.join(distDir, 'index.html'), shellHtml(htmlOptions));
	fs.writeFileSync(path.join(distDir, '.vite', 'manifest.json'), viteManifestJson());
	fs.writeFileSync(path.join(assetsDir, JS_FILE), JS_CONTENT);
	fs.writeFileSync(path.join(assetsDir, CSS_FILE), CSS_CONTENT);
	fs.writeFileSync(path.join(assetsDir, WOFF_FILE), WOFF_CONTENT);
	fs.writeFileSync(path.join(assetsDir, GZ_FILE), GZ_CONTENT);
}

let distDir: string;

beforeEach(() => {
	distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-built-ui-'));
});

afterEach(() => {
	fs.rmSync(distDir, { recursive: true, force: true });
});

describe('serveBuiltUi — shell + manifest', () => {
	it('injects the opt-in meta and boot watchdog, keeps relative asset tags, and caches the shell at construction', () => {
		writeValidFixture(distDir);
		const shell = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		const html = shell.renderHtml();

		const metaOccurrences = html.match(/name="privos-ui-assets"/g) ?? [];
		expect(metaOccurrences).toHaveLength(1);
		expect(html).toContain('content="relay"');
		expect(html).toContain('__privosUiBooted');
		expect(html).toContain(`./assets/${JS_FILE}`);
		expect(html).toContain(`./assets/${CSS_FILE}`);

		// Watchdog is prepended — it must appear before the entry module script.
		expect(html.indexOf('__privosUiBooted')).toBeLessThan(html.indexOf(`./assets/${JS_FILE}`));

		// Read once at construction: mutating the file afterwards must not change the cached output.
		fs.writeFileSync(path.join(distDir, 'index.html'), shellHtml({ scriptSrc: './assets/other.js' }));
		expect(shell.renderHtml()).toBe(html);
	});

	it('does not duplicate the meta tag when the shell already declares it', () => {
		writeValidFixture(distDir, { withMeta: true });
		const shell = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		const metaOccurrences = shell.renderHtml().match(/name="privos-ui-assets"/g) ?? [];
		expect(metaOccurrences).toHaveLength(1);
	});

	it('lists exactly the served files, unioning the Vite manifest with a directory scan', () => {
		writeValidFixture(distDir);
		const shell = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		const manifest = shell.readAssetsManifest();
		const byName = new Map(manifest.files.map((file) => [file.name, file]));

		expect([...byName.keys()].sort()).toEqual([CSS_FILE, GZ_FILE, JS_FILE, WOFF_FILE].sort());
		expect(byName.get(JS_FILE)).toEqual({ name: JS_FILE, size: JS_CONTENT.length, type: 'text/javascript' });
		expect(byName.get(CSS_FILE)).toEqual({ name: CSS_FILE, size: CSS_CONTENT.length, type: 'text/css' });
		expect(byName.get(WOFF_FILE)).toEqual({ name: WOFF_FILE, size: WOFF_CONTENT.length, type: 'font/woff2' });
		expect(byName.get(GZ_FILE)).toEqual({ name: GZ_FILE, size: GZ_CONTENT.length, type: 'application/gzip' });
	});

	it('exposes assetUriPrefix as ui://<appSlug>/assets/', () => {
		writeValidFixture(distDir);
		const shell = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		expect(shell.assetUriPrefix).toBe(`ui://${APP_SLUG}/assets/`);
	});

	it('throws at construction when the shell has a non-relative (absolute) asset reference', () => {
		const assetsDir = path.join(distDir, 'assets');
		fs.mkdirSync(assetsDir, { recursive: true });
		fs.writeFileSync(path.join(assetsDir, JS_FILE), JS_CONTENT);
		fs.writeFileSync(
			path.join(distDir, 'index.html'),
			shellHtml({ scriptSrc: `/assets/${JS_FILE}`, linkHref: `/assets/${JS_FILE}` }),
		);
		expect(() => serveBuiltUi({ distDir, appSlug: APP_SLUG })).toThrow(/non-relative asset references/);
	});

	it('throws at construction listing every offender: a sourcemap, an unhashed file, and an oversized file', () => {
		writeValidFixture(distDir);
		const assetsDir = path.join(distDir, 'assets');
		fs.writeFileSync(path.join(assetsDir, `${JS_FILE}.map`), '{}');
		fs.writeFileSync(path.join(assetsDir, 'logo.svg'), '<svg></svg>');
		fs.writeFileSync(path.join(assetsDir, 'big-ABCDEFGH16.png'), Buffer.alloc(2 * 1024 * 1024 + 10));

		let thrown: Error | undefined;
		try {
			serveBuiltUi({ distDir, appSlug: APP_SLUG });
		} catch (err) {
			thrown = err as Error;
		}
		expect(thrown).toBeDefined();
		expect(thrown!.message).toContain(`${JS_FILE}.map`);
		expect(thrown!.message).toContain('sourcemaps must not be published');
		expect(thrown!.message).toContain('logo.svg');
		expect(thrown!.message).toContain('does not match the content-hashed filename rule');
		expect(thrown!.message).toContain('big-ABCDEFGH16.png');
		expect(thrown!.message).toContain('exceeds the');
	});
});

describe('serveBuiltUi — readAsset', () => {
	it('serves text assets with the correct mime type', () => {
		writeValidFixture(distDir);
		const shell = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		const uri = `${shell.assetUriPrefix}${JS_FILE}`;
		expect(shell.readAsset(uri)).toEqual({ uri, mimeType: 'text/javascript', text: JS_CONTENT });

		const cssUri = `${shell.assetUriPrefix}${CSS_FILE}`;
		expect(shell.readAsset(cssUri)).toEqual({ uri: cssUri, mimeType: 'text/css', text: CSS_CONTENT });
	});

	it('serves binary assets as base64 blobs, including a hashed .tar.gz sample archive', () => {
		writeValidFixture(distDir);
		const shell = serveBuiltUi({ distDir, appSlug: APP_SLUG });

		const woffUri = `${shell.assetUriPrefix}${WOFF_FILE}`;
		expect(shell.readAsset(woffUri)).toEqual({
			uri: woffUri,
			mimeType: 'font/woff2',
			blob: WOFF_CONTENT.toString('base64'),
		});

		const gzUri = `${shell.assetUriPrefix}${GZ_FILE}`;
		expect(shell.readAsset(gzUri)).toEqual({
			uri: gzUri,
			mimeType: 'application/gzip',
			blob: GZ_CONTENT.toString('base64'),
		});
	});

	it('refuses unlisted files, path traversal, and a mismatched app prefix', () => {
		writeValidFixture(distDir);
		const shell = serveBuiltUi({ distDir, appSlug: APP_SLUG });

		expect(shell.readAsset(`${shell.assetUriPrefix}nonexistent-AAAAAAAA11.js`)).toBeNull();
		expect(shell.readAsset(`${shell.assetUriPrefix}../../etc/passwd`)).toBeNull();
		expect(shell.readAsset(`ui://other-app/assets/${JS_FILE}`)).toBeNull();
		expect(shell.readAsset(`${shell.assetUriPrefix}${JS_FILE}.map`)).toBeNull();
	});

	it('caches the first successful read — a later on-disk change is not observed', () => {
		writeValidFixture(distDir);
		const shell = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		const uri = `${shell.assetUriPrefix}${JS_FILE}`;

		const first = shell.readAsset(uri);
		fs.writeFileSync(path.join(distDir, 'assets', JS_FILE), 'console.log("changed");');
		const second = shell.readAsset(uri);
		expect(second).toEqual(first);
	});
});

describe('serveBuiltUi wired into AppServerRuntime.resources/read', () => {
	const descriptor: AppDescriptor = { id: APP_SLUG, name: 'Demo', version: '1.0.0' };

	function buildRuntime(shell: ReturnType<typeof serveBuiltUi>, handler = vi.fn()): AppServerRuntime {
		const ui: UiResourceProvider = {
			uri: `ui://${APP_SLUG}/form.html`,
			renderHtml: () => shell.renderHtml(),
			readAsset: (uri) => shell.readAsset(uri),
			readAssetsManifest: () => shell.readAssetsManifest(),
			assetUriPrefix: shell.assetUriPrefix,
		};
		return new AppServerRuntime({ descriptor, handler, ui });
	}

	async function readResource(runtime: AppServerRuntime, uri: string) {
		const context = await runtime.buildContext({
			transport: 'direct',
			requestId: 1,
			sessionScope: 'test-session',
		});
		return runtime.dispatchObject(
			{ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } },
			context,
		);
	}

	it('serves the shell HTML at ui.uri', async () => {
		writeValidFixture(distDir);
		const shell = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		const runtime = buildRuntime(shell);

		const outcome = await readResource(runtime, `ui://${APP_SLUG}/form.html`);
		expect(outcome.type).toBe('response');
		if (outcome.type === 'response' && 'result' in outcome.response) {
			const result = outcome.response.result as { contents: Array<{ text: string }> };
			expect(result.contents[0]!.text).toBe(shell.renderHtml());
		}
	});

	it('serves the assets manifest at the sibling assets-manifest.json resource', async () => {
		writeValidFixture(distDir);
		const shell = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		const runtime = buildRuntime(shell);

		const outcome = await readResource(runtime, `ui://${APP_SLUG}/assets-manifest.json`);
		expect(outcome.type).toBe('response');
		if (outcome.type === 'response' && 'result' in outcome.response) {
			const result = outcome.response.result as { contents: Array<{ mimeType: string; text: string }> };
			expect(result.contents[0]!.mimeType).toBe('application/json');
			expect(JSON.parse(result.contents[0]!.text)).toEqual(shell.readAssetsManifest());
		}
	});

	it('serves an individual asset at ui://<appSlug>/assets/<file>', async () => {
		writeValidFixture(distDir);
		const shell = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		const runtime = buildRuntime(shell);

		const outcome = await readResource(runtime, `${shell.assetUriPrefix}${JS_FILE}`);
		expect(outcome.type).toBe('response');
		if (outcome.type === 'response' && 'result' in outcome.response) {
			const result = outcome.response.result as { contents: Array<{ text: string }> };
			expect(result.contents[0]!.text).toBe(JS_CONTENT);
		}
	});

	it('falls through to the app handler when the uri looks like an asset but readAsset returns null', async () => {
		writeValidFixture(distDir);
		const shell = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		const handler = vi.fn(async () => ({ contents: [{ uri: 'app-handled', mimeType: 'text/plain', text: 'x' }] }));
		const runtime = buildRuntime(shell, handler);

		const outcome = await readResource(runtime, `${shell.assetUriPrefix}unknown-AAAAAAAA11.js`);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(outcome.type).toBe('response');
		if (outcome.type === 'response' && 'result' in outcome.response) {
			expect(outcome.response.result).toEqual({
				contents: [{ uri: 'app-handled', mimeType: 'text/plain', text: 'x' }],
			});
		}
	});
});

describe('split-build UI identity guard (AppServerRuntime registration)', () => {
	const descriptor: AppDescriptor = { id: APP_SLUG, name: 'Demo', version: '1.0.0' };

	it('throws at registration when a split-build ui.uri host does not match the manifest name', () => {
		writeValidFixture(distDir);
		const shell = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		const ui: UiResourceProvider = {
			uri: 'ui://mismatched-app-slug/form.html',
			renderHtml: () => shell.renderHtml(),
			readAsset: (uri) => shell.readAsset(uri),
			readAssetsManifest: () => shell.readAssetsManifest(),
			assetUriPrefix: shell.assetUriPrefix,
		};

		expect(() => new AppServerRuntime({ descriptor, handler: vi.fn(), ui })).toThrow(
			/mismatched-app-slug.*ai\.privos\.demo|ai\.privos\.demo.*mismatched-app-slug/s,
		);
	});

	it('throws at registration when serveBuiltUi was constructed with a different appSlug than the manifest name', () => {
		writeValidFixture(distDir);
		const shell = serveBuiltUi({ distDir, appSlug: 'wrong-slug' });
		const ui: UiResourceProvider = {
			uri: `ui://${APP_SLUG}/form.html`, // matches the manifest name; only assetUriPrefix is wrong
			renderHtml: () => shell.renderHtml(),
			readAsset: (uri) => shell.readAsset(uri),
			readAssetsManifest: () => shell.readAssetsManifest(),
			assetUriPrefix: shell.assetUriPrefix,
		};

		let thrown: Error | undefined;
		try {
			new AppServerRuntime({ descriptor, handler: vi.fn(), ui });
		} catch (err) {
			thrown = err as Error;
		}
		expect(thrown).toBeDefined();
		expect(thrown!.message).toContain('wrong-slug');
		expect(thrown!.message).toContain(APP_SLUG);
	});

	it('does not throw when the shell appSlug, ui.uri host, and manifest name all match', () => {
		writeValidFixture(distDir);
		const shell = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		expect(() => buildRuntime(shell)).not.toThrow();
	});

	it('does not throw for a legacy inline-HTML provider whose ui.uri host differs from the manifest name', () => {
		const ui: UiResourceProvider = {
			uri: 'ui://legacy-app/main.html',
			renderHtml: async () => '<html><body>inline</body></html>',
			// No readAsset / readAssetsManifest — this app never split its build,
			// so a mismatched host is legitimate and must keep working.
		};

		expect(() => new AppServerRuntime({ descriptor, handler: vi.fn(), ui })).not.toThrow();
	});

	function buildRuntime(shell: ReturnType<typeof serveBuiltUi>): AppServerRuntime {
		const ui: UiResourceProvider = {
			uri: `ui://${APP_SLUG}/form.html`,
			renderHtml: () => shell.renderHtml(),
			readAsset: (uri) => shell.readAsset(uri),
			readAssetsManifest: () => shell.readAssetsManifest(),
			assetUriPrefix: shell.assetUriPrefix,
		};
		return new AppServerRuntime({ descriptor, handler: vi.fn(), ui });
	}
});
