import fs from 'node:fs';
import path from 'node:path';

import { MCP_UI_SHELL_WATCHDOG_SCRIPT } from './shell-watchdog.js';

const PRIVOS_UI_ASSETS_META = '<meta name="privos-ui-assets" content="relay">';
const PRIVOS_UI_ASSETS_META_RE =
	/<meta\b[^>]*\bname\s*=\s*["']privos-ui-assets["'][^>]*\bcontent\s*=\s*["']relay["']|<meta\b[^>]*\bcontent\s*=\s*["']relay["'][^>]*\bname\s*=\s*["']privos-ui-assets["']/i;
const ASSET_TAG_RE = /<(script|link)\b[^>]*>/gi;
const SRC_OR_HREF_RE = /\b(?:src|href)\s*=\s*(["'])(.*?)\1/i;

/**
 * Renders the shell HTML `serveBuiltUi` serves at runtime — opt-in
 * `privos-ui-assets` meta tag (skipped when the build already declares it)
 * plus the inline boot watchdog prepended to `<head>` — from `distDir`'s
 * `index.html`. Extracted so `privos-app bundle-ui` (the SDK packaging CLI)
 * can render byte-identical output at build time without duplicating this
 * logic: a bundle whose shell differs from the runtime-served shell is
 * exactly the defect this shared function prevents.
 *
 * Throws when `index.html` cannot be read or declares a non-relative
 * (`/assets/…` or absolute) script/link reference — a misconfigured build
 * must fail loudly here, never serve or ship a blank frame.
 */
export function renderShell(distDir: string): string {
	const indexPath = path.join(distDir, 'index.html');
	let raw: string;
	try {
		raw = fs.readFileSync(indexPath, 'utf8');
	} catch (err) {
		throw new Error(`renderShell: cannot read ${indexPath}: ${(err as Error).message}`);
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
			`renderShell: ${indexPath} has non-relative asset references — build with Vite base: './':\n${offenders
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
