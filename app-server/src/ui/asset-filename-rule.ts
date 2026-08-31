/**
 * Content-hashed asset filename rule shared by the SDK (build-time validation,
 * `readAsset` lookups) and the Hub route that re-serves these files. A filename
 * must start with an alnum, may contain `.`/`_`/`-` up to a trailing `-<hash>`
 * of at least 8 chars, then one of the allowed extensions. No `/`, no `..`, no
 * `.map` — content hashing itself is guaranteed by the assets manifest listing
 * a file, not by this regex alone.
 */
export const MCP_UI_ASSET_FILENAME_RE =
	/^[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{8,}\.(js|css|svg|json|woff|woff2|ttf|png|jpg|jpeg|gif|webp|avif|ico|wasm|gz)$/;

/** Extensions a split-build UI is ever allowed to publish under `assets/`. */
export const MCP_UI_ASSET_EXTENSIONS = [
	'js',
	'css',
	'svg',
	'json',
	'woff',
	'woff2',
	'ttf',
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'avif',
	'ico',
	'wasm',
	'gz',
] as const;

export type McpUiAssetExtension = (typeof MCP_UI_ASSET_EXTENSIONS)[number];

/**
 * `ui://<appSlug>/assets/` — the app-level (not per-entry-point) URI prefix
 * every split asset is addressed under, per the wire contract.
 */
export function deriveAssetUriPrefix(appSlug: string): string {
	if (typeof appSlug !== 'string' || appSlug.trim().length === 0) {
		throw new Error('deriveAssetUriPrefix requires a non-empty appSlug');
	}
	return `ui://${appSlug}/assets/`;
}
