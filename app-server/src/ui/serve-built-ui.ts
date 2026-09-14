import fs from 'node:fs';
import path from 'node:path';

import type { UiAssetContent } from '../runtime.js';
import { deriveAssetUriPrefix } from './asset-filename-rule.js';
import { buildAssetsManifest, type AssetsManifest } from './assets-manifest.js';
import { isContainedIn } from './path-containment.js';
import { renderShell } from './render-shell.js';

const TEXT_ASSET_EXTENSIONS = new Set(['js', 'css', 'svg', 'json']);

export interface ServeBuiltUiOptions {
	/** Absolute path to the Vite build output directory containing `index.html`, `assets/`, `.vite/manifest.json`. */
	distDir: string;
	/** The app's manifest id — used to derive `ui://<appSlug>/assets/…` URIs. */
	appSlug: string;
}

export interface ServeBuiltUi {
	/** Cached at construction: meta + watchdog + relative asset tags. */
	renderHtml(): string;
	/** `null` for an unrecognized/unlisted/traversal-unsafe URI. Cached after first successful read. */
	readAsset(uri: string): UiAssetContent | null;
	/** `{ files: [{ name, size, type }] }`, cached at construction. */
	readAssetsManifest(): AssetsManifest;
	/** `ui://<appSlug>/assets/` */
	assetUriPrefix: string;
}

/**
 * Serve a Vite-built (`base: './'`) app UI over MCP `resources/read`: the
 * shell HTML (opt-in relay meta + inline boot watchdog) plus the hashed
 * `assets/` files it references, split out of the HTML payload. Boot-time
 * validation (asset filenames, extensions, size, no sourcemaps) and the shell's
 * relative-asset-path assertion both throw at construction — a misconfigured
 * build must fail loudly here, never serve a blank frame in production.
 */
export function serveBuiltUi(options: ServeBuiltUiOptions): ServeBuiltUi {
	const { distDir, appSlug } = options;
	const assetUriPrefix = deriveAssetUriPrefix(appSlug);
	const assetsDir = path.join(distDir, 'assets');

	// Boot-time validation of every file under assets/ — throws with the full
	// offender list on filename-rule / extension / size / sourcemap violations.
	const manifest = buildAssetsManifest(distDir);
	const manifestFiles = new Map(manifest.files.map((file) => [file.name, file]));

	const assetsDirRealpath = fs.existsSync(assetsDir) ? fs.realpathSync(assetsDir) : undefined;
	const html = renderShell(distDir);
	const assetCache = new Map<string, UiAssetContent>();

	return {
		renderHtml(): string {
			return html;
		},
		readAsset(uri: string): UiAssetContent | null {
			const cached = assetCache.get(uri);
			if (cached) return cached;
			if (!uri.startsWith(assetUriPrefix)) return null;

			const fileName = uri.slice(assetUriPrefix.length);
			const entry = manifestFiles.get(fileName);
			if (!entry || !assetsDirRealpath) return null;

			const filePath = path.join(assetsDir, fileName);
			let realFilePath: string;
			try {
				realFilePath = fs.realpathSync(filePath);
			} catch {
				return null;
			}
			if (!isContainedIn(assetsDirRealpath, realFilePath)) return null;

			const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
			const resource: UiAssetContent = TEXT_ASSET_EXTENSIONS.has(ext)
				? { uri, mimeType: entry.type, text: fs.readFileSync(realFilePath, 'utf8') }
				: { uri, mimeType: entry.type, blob: fs.readFileSync(realFilePath).toString('base64') };
			assetCache.set(uri, resource);
			return resource;
		},
		readAssetsManifest(): AssetsManifest {
			return manifest;
		},
		assetUriPrefix,
	};
}

