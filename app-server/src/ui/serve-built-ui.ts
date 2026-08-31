import fs from 'node:fs';
import path from 'node:path';

import type { UiAssetContent } from '../runtime.js';
import { deriveAssetUriPrefix } from './asset-filename-rule.js';
import { buildAssetsManifest, type AssetsManifest } from './assets-manifest.js';
import { MCP_UI_SHELL_WATCHDOG_SCRIPT } from './shell-watchdog.js';

const TEXT_ASSET_EXTENSIONS = new Set(['js', 'css', 'svg', 'json']);
const PRIVOS_UI_ASSETS_META = '<meta name="privos-ui-assets" content="relay">';
const PRIVOS_UI_ASSETS_META_RE =
	/<meta\b[^>]*\bname\s*=\s*["']privos-ui-assets["'][^>]*\bcontent\s*=\s*["']relay["']|<meta\b[^>]*\bcontent\s*=\s*["']relay["'][^>]*\bname\s*=\s*["']privos-ui-assets["']/i;
const ASSET_TAG_RE = /<(script|link)\b[^>]*>/gi;
const SRC_OR_HREF_RE = /\b(?:src|href)\s*=\s*(["'])(.*?)\1/i;

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
	const html = renderShellHtml(distDir);
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

function isContainedIn(dirRealpath: string, fileRealpath: string): boolean {
	const relative = path.relative(dirRealpath, fileRealpath);
	return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function renderShellHtml(distDir: string): string {
	const indexPath = path.join(distDir, 'index.html');
	let raw: string;
	try {
		raw = fs.readFileSync(indexPath, 'utf8');
	} catch (err) {
		throw new Error(`serveBuiltUi: cannot read ${indexPath}: ${(err as Error).message}`);
	}

	assertRelativeAssetTags(raw, indexPath);

	let html = raw;
	if (!PRIVOS_UI_ASSETS_META_RE.test(html)) {
		html = injectIntoHead(html, `  ${PRIVOS_UI_ASSETS_META}\n`, { atStart: false });
	}
	html = injectIntoHead(html, `  <script>${MCP_UI_SHELL_WATCHDOG_SCRIPT}</script>\n`, { atStart: true });
	return html;
}

/**
 * Every `<script src>` / `<link href>` in the shell must be relative
 * (`./assets/…` or `assets/…`). An absolute or external reference means the
 * app was built without Vite `base: './'` and would resolve against the
 * wrong origin once the tab renders it — fail construction, not the frame.
 */
function assertRelativeAssetTags(html: string, indexPath: string): void {
	const offenders: string[] = [];
	ASSET_TAG_RE.lastIndex = 0;
	let tagMatch: RegExpExecArray | null;
	while ((tagMatch = ASSET_TAG_RE.exec(html))) {
		const tag = tagMatch[0];
		const refMatch = SRC_OR_HREF_RE.exec(tag);
		if (!refMatch) continue;
		const ref = refMatch[2];
		if (ref && (ref.startsWith('./assets/') || ref.startsWith('assets/'))) continue;
		offenders.push(tag.length > 120 ? `${tag.slice(0, 117)}...` : tag);
	}
	if (offenders.length > 0) {
		throw new Error(
			`serveBuiltUi: ${indexPath} has non-relative asset references — build with Vite base: './':\n${offenders
				.map((o) => `  - ${o}`)
				.join('\n')}`,
		);
	}
}

function injectIntoHead(html: string, snippet: string, opts: { atStart: boolean }): string {
	if (opts.atStart) {
		const headOpen = /<head[^>]*>/i.exec(html);
		if (headOpen) {
			const insertAt = headOpen.index + headOpen[0].length;
			return `${html.slice(0, insertAt)}\n${snippet}${html.slice(insertAt)}`;
		}
	} else {
		const headCloseIdx = html.search(/<\/head>/i);
		if (headCloseIdx !== -1) {
			return html.slice(0, headCloseIdx) + snippet + html.slice(headCloseIdx);
		}
	}
	// No <head> tag found in a well-formed Vite build — fall back to prepending.
	return snippet + html;
}
