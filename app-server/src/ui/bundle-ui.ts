import fs from 'node:fs';
import path from 'node:path';

import { buildAssetsManifest, type AssetsManifest } from './assets-manifest.js';
import { buildDeterministicTar, type DeterministicTarEntry, USTAR_MAX_NAME_BYTES } from './deterministic-tar.js';
import { isContainedIn } from './path-containment.js';
import { renderShell } from './render-shell.js';

/** Matches the wire contract's per-file cap (`assets-manifest.ts`'s `MAX_ASSET_BYTES`). */
export const UI_BUNDLE_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Total tar entries (`shell.html` + `assets-manifest.json` + every asset). */
export const UI_BUNDLE_MAX_FILES = 256;
export const UI_BUNDLE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export type UiBundleErrorCode =
	| 'UI_BUNDLE_TOO_MANY_FILES'
	| 'UI_BUNDLE_FILE_TOO_LARGE'
	| 'UI_BUNDLE_TOO_LARGE'
	| 'UI_BUNDLE_ASSET_ESCAPES_DIR'
	| 'UI_BUNDLE_ENTRY_NAME_TOO_LONG';

export class UiBundleError extends Error {
	constructor(message: string, public readonly code: UiBundleErrorCode) {
		super(message);
		this.name = 'UiBundleError';
	}
}

export interface BuildUiBundleOptions {
	/** Absolute path to the UI build output — same directory `serveBuiltUi` is configured with. */
	distDir: string;
}

export interface UiBundleFileEntry {
	/** Tar entry name: `shell.html`, `assets-manifest.json`, or `assets/<file>`. */
	name: string;
	size: number;
}

export interface UiBundleResult {
	/** Deterministic USTAR tar bytes — byte-identical across two builds of the same input. */
	tar: Buffer;
	/** Byte-identical to what `serveBuiltUi(...).renderHtml()` serves for the same `distDir`. */
	shellHtml: string;
	manifest: AssetsManifest;
	files: readonly UiBundleFileEntry[];
	totalBytes: number;
}

/**
 * Renders the shell and assets manifest through the exact same code
 * `serveBuiltUi` uses at runtime (`renderShell`, `buildAssetsManifest`), then
 * packs `shell.html` + `assets-manifest.json` + `assets/*` into a
 * deterministic tar. This is the one producer of the bundle shape the build
 * node's `ui-build` stage requires and the Hub ingests — a build whose shell
 * differs from what gets served would ship a blank frame that only shows up
 * after an install has already gone READY.
 *
 * Single-file UIs (no assets/ directory, no referenced files) are valid:
 * `manifest.files` is empty and the tar carries only `shell.html` +
 * `assets-manifest.json`.
 *
 * Throws {@link UiBundleError} when the bundle would exceed the platform
 * budgets (≤2 MB per file, ≤256 files, ≤64 MB total), or whatever
 * `renderShell` / `buildAssetsManifest` throw for a malformed build (missing
 * `index.html`, non-relative asset tags, an oversized/unhashed/sourcemap
 * asset file).
 */
export function buildUiBundle(options: BuildUiBundleOptions): UiBundleResult {
	const { distDir } = options;
	const shellHtml = renderShell(distDir);
	const manifest = buildAssetsManifest(distDir);
	const assetsDir = path.join(distDir, 'assets');
	// Only resolved when there is at least one asset — matches serveBuiltUi's
	// own lazy realpath resolution and avoids a spurious ENOENT for a
	// single-file UI that never created assets/.
	const assetsDirRealpath = manifest.files.length > 0 ? fs.realpathSync(assetsDir) : undefined;

	const tarEntries: DeterministicTarEntry[] = [
		{ name: 'shell.html', data: Buffer.from(shellHtml, 'utf8') },
		{ name: 'assets-manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
		// `manifest.files` is already sorted by name (buildAssetsManifest sorts before validating).
		...manifest.files.map((file) => ({
			name: `assets/${file.name}`,
			data: readContainedAsset(assetsDir, assetsDirRealpath!, file.name),
		})),
	];

	for (const entry of tarEntries) {
		if (Buffer.byteLength(entry.name, 'utf8') > USTAR_MAX_NAME_BYTES) {
			throw new UiBundleError(
				`${entry.name}: entry name exceeds the ${USTAR_MAX_NAME_BYTES} byte tar name limit.`,
				'UI_BUNDLE_ENTRY_NAME_TOO_LONG',
			);
		}
	}

	if (tarEntries.length > UI_BUNDLE_MAX_FILES) {
		throw new UiBundleError(
			`UI bundle has ${tarEntries.length} files; the platform limit is ${UI_BUNDLE_MAX_FILES}.`,
			'UI_BUNDLE_TOO_MANY_FILES',
		);
	}
	for (const entry of tarEntries) {
		if (entry.data.length > UI_BUNDLE_MAX_FILE_BYTES) {
			throw new UiBundleError(
				`${entry.name}: ${entry.data.length} bytes exceeds the ${UI_BUNDLE_MAX_FILE_BYTES} byte per-file limit.`,
				'UI_BUNDLE_FILE_TOO_LARGE',
			);
		}
	}
	const totalBytes = tarEntries.reduce((sum, entry) => sum + entry.data.length, 0);
	if (totalBytes > UI_BUNDLE_MAX_TOTAL_BYTES) {
		throw new UiBundleError(
			`UI bundle is ${totalBytes} bytes; the platform limit is ${UI_BUNDLE_MAX_TOTAL_BYTES} bytes.`,
			'UI_BUNDLE_TOO_LARGE',
		);
	}

	return {
		tar: buildDeterministicTar(tarEntries),
		shellHtml,
		manifest,
		files: tarEntries.map((entry) => ({ name: entry.name, size: entry.data.length })),
		totalBytes,
	};
}

/**
 * Reads `assetsDir/fileName`, refusing a symlink (or any path) that resolves
 * outside `assetsDirRealpath` — the same containment rule `serveBuiltUi`'s
 * `readAsset` applies at runtime. Without this, a symlink planted under
 * `assets/` (by a compromised build dependency, say) would let `bundle-ui`
 * silently embed an arbitrary host file's bytes into the published bundle.
 */
function readContainedAsset(assetsDir: string, assetsDirRealpath: string, fileName: string): Buffer {
	const filePath = path.join(assetsDir, fileName);
	let realFilePath: string;
	try {
		realFilePath = fs.realpathSync(filePath);
	} catch (err) {
		throw new UiBundleError(
			`assets/${fileName}: cannot resolve path: ${(err as Error).message}`,
			'UI_BUNDLE_ASSET_ESCAPES_DIR',
		);
	}
	if (!isContainedIn(assetsDirRealpath, realFilePath)) {
		throw new UiBundleError(
			`assets/${fileName} resolves outside ${assetsDir} — refusing to bundle a symlink (or other path) that escapes assets/.`,
			'UI_BUNDLE_ASSET_ESCAPES_DIR',
		);
	}
	return fs.readFileSync(realFilePath);
}
