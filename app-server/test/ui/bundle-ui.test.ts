import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	buildUiBundle,
	UI_BUNDLE_MAX_FILES,
	UI_BUNDLE_MAX_TOTAL_BYTES,
	UiBundleError,
} from '../../src/ui/bundle-ui.js';
import { serveBuiltUi } from '../../src/ui/serve-built-ui.js';

const APP_SLUG = 'ai.privos.demo';
const JS_FILE = 'index-ABCDEFGH12.js';
const CSS_FILE = 'index-ABCDEFGH13.css';
const JS_CONTENT = "console.log('demo');";
const CSS_CONTENT = 'body{margin:0}';

function shellHtml(scriptSrc = `./assets/${JS_FILE}`, linkHref = `./assets/${CSS_FILE}`): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="${linkHref}">
</head>
<body>
<div id="root"></div>
<script type="module" src="${scriptSrc}"></script>
</body>
</html>
`;
}

/** Split-build fixture: index.html + .vite/manifest.json + assets/(js,css). */
function writeSplitBuildFixture(distDir: string): void {
	const assetsDir = path.join(distDir, 'assets');
	fs.mkdirSync(assetsDir, { recursive: true });
	fs.mkdirSync(path.join(distDir, '.vite'), { recursive: true });
	fs.writeFileSync(path.join(distDir, 'index.html'), shellHtml());
	fs.writeFileSync(
		path.join(distDir, '.vite', 'manifest.json'),
		JSON.stringify({ 'index.html': { file: `assets/${JS_FILE}`, css: [`assets/${CSS_FILE}`], isEntry: true } }),
	);
	fs.writeFileSync(path.join(assetsDir, JS_FILE), JS_CONTENT);
	fs.writeFileSync(path.join(assetsDir, CSS_FILE), CSS_CONTENT);
}

/** Single-file fixture: only index.html, no assets/ directory at all. */
function writeSingleFileFixture(distDir: string): void {
	fs.mkdirSync(distDir, { recursive: true });
	fs.writeFileSync(
		path.join(distDir, 'index.html'),
		'<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">console.log("inline");</script></body></html>\n',
	);
}

/** Extracts a single-entry-per-name view of a USTAR tar this repo produced (no long-name/gnu extensions to handle). */
function extractTar(tar: Buffer): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	let offset = 0;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break; // end-of-archive zero block
		const name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/s, '');
		const sizeOctal = header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim();
		const size = parseInt(sizeOctal, 8);
		offset += 512;
		const data = tar.subarray(offset, offset + size);
		files.set(name, Buffer.from(data));
		offset += Math.ceil(size / 512) * 512;
	}
	return files;
}

let distDir: string;

beforeEach(() => {
	distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-ui-'));
});

afterEach(() => {
	fs.rmSync(distDir, { recursive: true, force: true });
});

describe('buildUiBundle — shell/manifest byte-equality with serveBuiltUi', () => {
	it('produces a shell byte-identical to the runtime-served shell for a split-build UI', () => {
		writeSplitBuildFixture(distDir);
		const served = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		const bundle = buildUiBundle({ distDir });
		expect(bundle.shellHtml).toBe(served.renderHtml());

		const extracted = extractTar(bundle.tar);
		expect(extracted.get('shell.html')!.toString('utf8')).toBe(served.renderHtml());
	});

	it('produces a shell byte-identical to the runtime-served shell for a single-file UI (no assets/)', () => {
		writeSingleFileFixture(distDir);
		const served = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		const bundle = buildUiBundle({ distDir });
		expect(bundle.shellHtml).toBe(served.renderHtml());
		expect(bundle.manifest).toEqual({ files: [] });

		const extracted = extractTar(bundle.tar);
		expect(extracted.has('assets-manifest.json')).toBe(true);
		expect([...extracted.keys()].some((name) => name.startsWith('assets/'))).toBe(false);
	});

	it('produces an assets manifest identical to serveBuiltUi().readAssetsManifest()', () => {
		writeSplitBuildFixture(distDir);
		const served = serveBuiltUi({ distDir, appSlug: APP_SLUG });
		const bundle = buildUiBundle({ distDir });
		expect(bundle.manifest).toEqual(served.readAssetsManifest());

		const extracted = extractTar(bundle.tar);
		expect(JSON.parse(extracted.get('assets-manifest.json')!.toString('utf8'))).toEqual(served.readAssetsManifest());
	});

	it('packs shell.html, assets-manifest.json, and every asset under assets/ for a split build', () => {
		writeSplitBuildFixture(distDir);
		const bundle = buildUiBundle({ distDir });
		const extracted = extractTar(bundle.tar);
		expect([...extracted.keys()].sort()).toEqual(
			['shell.html', 'assets-manifest.json', `assets/${CSS_FILE}`, `assets/${JS_FILE}`].sort(),
		);
		expect(extracted.get(`assets/${JS_FILE}`)!.toString('utf8')).toBe(JS_CONTENT);
		expect(extracted.get(`assets/${CSS_FILE}`)!.toString('utf8')).toBe(CSS_CONTENT);
	});
});

describe('buildUiBundle — deterministic tar', () => {
	it('produces a byte-identical (same sha256) tar across two builds of the same input', () => {
		writeSplitBuildFixture(distDir);
		const first = buildUiBundle({ distDir });
		const second = buildUiBundle({ distDir });
		expect(first.tar.equals(second.tar)).toBe(true);
		expect(crypto.createHash('sha256').update(first.tar).digest('hex')).toBe(
			crypto.createHash('sha256').update(second.tar).digest('hex'),
		);
	});

	it('zeroes mtime/uid/gid on every header regardless of the source files’ own mtimes', () => {
		writeSplitBuildFixture(distDir);
		const before = buildUiBundle({ distDir });
		// Touch a source file's mtime without changing its content — the tar must not change.
		const jsPath = path.join(distDir, 'assets', JS_FILE);
		fs.utimesSync(jsPath, new Date('2030-01-01'), new Date('2030-01-01'));
		const after = buildUiBundle({ distDir });
		expect(after.tar.equals(before.tar)).toBe(true);
	});
});

describe('buildUiBundle — budgets', () => {
	it('refuses a bundle with more than UI_BUNDLE_MAX_FILES total entries', () => {
		fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
		fs.writeFileSync(path.join(distDir, 'index.html'), shellHtml('./assets/entry-AAAAAAAA11.js', './assets/entry-AAAAAAAA11.js'));
		// shell.html + assets-manifest.json already consume 2 of the budget.
		const assetCount = UI_BUNDLE_MAX_FILES - 1;
		for (let i = 0; i < assetCount; i += 1) {
			const name = `file${i}-AAAAAAAA${String(i).padStart(2, '0')}.js`;
			fs.writeFileSync(path.join(distDir, 'assets', name), '// x');
		}
		let thrown: UiBundleError | undefined;
		try {
			buildUiBundle({ distDir });
		} catch (error) {
			thrown = error as UiBundleError;
		}
		expect(thrown).toBeInstanceOf(UiBundleError);
		expect(thrown!.code).toBe('UI_BUNDLE_TOO_MANY_FILES');
	});

	it('refuses a bundle whose total bytes exceed UI_BUNDLE_MAX_TOTAL_BYTES even with every file under the per-file cap', () => {
		fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
		fs.writeFileSync(path.join(distDir, 'index.html'), shellHtml('./assets/big0-AAAAAAAA11.js', './assets/big0-AAAAAAAA11.js'));
		const perFileBytes = 2 * 1024 * 1024; // exactly the per-file cap — must not trip the per-file check
		const filesNeeded = Math.ceil(UI_BUNDLE_MAX_TOTAL_BYTES / perFileBytes) + 1;
		for (let i = 0; i < filesNeeded; i += 1) {
			const name = `big${i}-AAAAAAAA${String(i).padStart(2, '0')}.js`;
			fs.writeFileSync(path.join(distDir, 'assets', name), Buffer.alloc(perFileBytes, 'x'));
		}
		let thrown: UiBundleError | undefined;
		try {
			buildUiBundle({ distDir });
		} catch (error) {
			thrown = error as UiBundleError;
		}
		expect(thrown).toBeInstanceOf(UiBundleError);
		expect(thrown!.code).toBe('UI_BUNDLE_TOO_LARGE');
	}, 30_000);

	it('refuses an oversized individual asset via the same per-file cap buildAssetsManifest enforces', () => {
		writeSplitBuildFixture(distDir);
		fs.writeFileSync(path.join(distDir, 'assets', 'big-AAAAAAAA99.png'), Buffer.alloc(2 * 1024 * 1024 + 1));
		expect(() => buildUiBundle({ distDir })).toThrow(/exceeds the/);
	});
});

describe('buildUiBundle — asset containment (M4)', () => {
	it('refuses to read an asset symlink that escapes assets/, matching serveBuiltUi.readAsset containment', () => {
		writeSplitBuildFixture(distDir);
		const outsideSecret = path.join(os.tmpdir(), `bundle-ui-outside-secret-${process.pid}.txt`);
		fs.writeFileSync(outsideSecret, 'do not leak this');
		const assetsDir = path.join(distDir, 'assets');
		const symlinkName = 'evil-AAAAAAAA11.js';
		fs.symlinkSync(outsideSecret, path.join(assetsDir, symlinkName));

		let thrown: UiBundleError | undefined;
		try {
			buildUiBundle({ distDir });
		} catch (error) {
			thrown = error as UiBundleError;
		} finally {
			fs.rmSync(outsideSecret, { force: true });
		}
		expect(thrown).toBeInstanceOf(UiBundleError);
		expect(thrown!.code).toBe('UI_BUNDLE_ASSET_ESCAPES_DIR');
		expect(thrown!.message).toContain(symlinkName);
	});

	it('gives a named UiBundleError (not a generic tar-writer Error) for an entry name exceeding the USTAR 100-byte field', () => {
		writeSplitBuildFixture(distDir);
		const longName = `${'a'.repeat(95)}-AAAAAAAA11.js`; // "assets/" + name > 100 bytes
		fs.writeFileSync(path.join(distDir, 'assets', longName), 'x');

		let thrown: UiBundleError | undefined;
		try {
			buildUiBundle({ distDir });
		} catch (error) {
			thrown = error as UiBundleError;
		}
		expect(thrown).toBeInstanceOf(UiBundleError);
		expect(thrown!.code).toBe('UI_BUNDLE_ENTRY_NAME_TOO_LONG');
	});
});
