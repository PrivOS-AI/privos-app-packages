import fs from 'node:fs';
import path from 'node:path';

import { MCP_UI_ASSET_FILENAME_RE } from './asset-filename-rule.js';

export interface AssetManifestEntry {
	name: string;
	size: number;
	type: string;
}

export interface AssetsManifest {
	files: AssetManifestEntry[];
}

/** Matches the wire contract's per-asset cap; the SDK refuses larger at build time. */
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
	js: 'text/javascript',
	css: 'text/css',
	svg: 'image/svg+xml',
	json: 'application/json',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	ico: 'image/x-icon',
	wasm: 'application/wasm',
	gz: 'application/gzip',
};

export function mimeTypeForAssetFile(fileName: string): string {
	const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
	return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

interface ViteManifestChunk {
	file?: unknown;
	css?: unknown;
	assets?: unknown;
}

/** Vite manifest paths are distDir-relative, e.g. `assets/index-H.js`. */
function assetFileNameFromManifestPath(relativePath: unknown): string | undefined {
	if (typeof relativePath !== 'string') return undefined;
	const normalized = relativePath.replace(/\\/g, '/');
	const prefix = 'assets/';
	return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
}

function readViteManifestFileNames(distDir: string): Set<string> {
	const manifestPath = path.join(distDir, '.vite', 'manifest.json');
	const names = new Set<string>();
	if (!fs.existsSync(manifestPath)) return names;

	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch (err) {
		throw new Error(
			`serveBuiltUi: failed to parse Vite manifest at ${manifestPath}: ${(err as Error).message}`,
		);
	}
	if (!raw || typeof raw !== 'object') return names;

	for (const chunk of Object.values(raw as Record<string, ViteManifestChunk>)) {
		if (!chunk || typeof chunk !== 'object') continue;
		const file = assetFileNameFromManifestPath(chunk.file);
		if (file) names.add(file);
		if (Array.isArray(chunk.css)) {
			for (const entry of chunk.css) {
				const name = assetFileNameFromManifestPath(entry);
				if (name) names.add(name);
			}
		}
		if (Array.isArray(chunk.assets)) {
			for (const entry of chunk.assets) {
				const name = assetFileNameFromManifestPath(entry);
				if (name) names.add(name);
			}
		}
	}
	return names;
}

function scanAssetsDirectory(assetsDir: string): Set<string> {
	const names = new Set<string>();
	if (!fs.existsSync(assetsDir)) return names;
	for (const entry of fs.readdirSync(assetsDir)) {
		if (fs.statSync(path.join(assetsDir, entry)).isFile()) names.add(entry);
	}
	return names;
}

/**
 * Build `{ files: [{ name, size, type }] }` for `distDir/assets` — the union
 * of Vite's `.vite/manifest.json` entries and a directory scan (lazy/CSS-only
 * chunks and fonts never appear in the manifest). Every file actually present
 * under `assets/` is validated: filename rule + extension allowlist, no
 * `.map`, size ≤ 2 MB. Throws with the full list of offenders otherwise —
 * this is boot-time validation, never a partial/best-effort manifest.
 */
export function buildAssetsManifest(distDir: string): AssetsManifest {
	const assetsDir = path.join(distDir, 'assets');
	const fileNames = new Set<string>([
		...readViteManifestFileNames(distDir),
		...scanAssetsDirectory(assetsDir),
	]);

	const offenders: string[] = [];
	const files: AssetManifestEntry[] = [];

	for (const name of [...fileNames].sort()) {
		const filePath = path.join(assetsDir, name);

		if (name.endsWith('.map')) {
			offenders.push(`${name}: sourcemaps must not be published under assets/`);
			continue;
		}
		if (!MCP_UI_ASSET_FILENAME_RE.test(name)) {
			offenders.push(`${name}: does not match the content-hashed filename rule`);
			continue;
		}

		let stat: fs.Stats;
		try {
			stat = fs.statSync(filePath);
		} catch {
			offenders.push(`${name}: referenced by the build but missing from ${assetsDir}`);
			continue;
		}
		if (stat.size > MAX_ASSET_BYTES) {
			offenders.push(`${name}: ${stat.size} bytes exceeds the ${MAX_ASSET_BYTES} byte per-asset limit`);
			continue;
		}

		files.push({ name, size: stat.size, type: mimeTypeForAssetFile(name) });
	}

	if (offenders.length > 0) {
		throw new Error(
			`serveBuiltUi: invalid files under ${assetsDir}:\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
		);
	}

	return { files };
}
