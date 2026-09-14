import path from 'node:path';

import { INSTANT_EXECUTION_MODE } from './manifest-lint-instant.js';
import { buildUiBundle, UiBundleError } from './ui/bundle-ui.js';

export const UI_SHELL_MODES = ['static', 'live'] as const;
export type UiShellMode = (typeof UI_SHELL_MODES)[number];

export type LintPublishResult = Readonly<{
	errors: readonly string[];
	warnings: readonly string[];
}>;

/**
 * Template-marker shapes a static build must never bake in for every
 * visitor: generic mustache `{{…}}` (not just `{{user`, since any
 * server-side templating that reached the shell is a leak, not only a
 * `user`-named one), EJS/ERB-style `<%…%>`, a `${user…}` template-literal
 * interpolation, and a `__USER__`-style dunder-wrapped marker. Checked only
 * outside `<script>` bodies (`stripScriptBodies` below) — legitimate app
 * code inside a script tag routinely contains `${…}` and must not false-
 * positive.
 */
const MUSTACHE_PLACEHOLDER_RE = /\{\{[^{}]*\}\}/;
const EJS_PLACEHOLDER_RE = /<%[^%]*%>/;
const TEMPLATE_LITERAL_USER_RE = /\$\{\s*user\b[^}]*\}/i;
const DUNDER_USER_RE = /__USER[A-Z0-9_]*__/;
const SCRIPT_BODY_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
/** A JWT-shaped string: three dot-separated base64url segments, header conventionally starting `eyJ`. Scanned everywhere, including inside <script> — a baked-in token is a leak regardless of where it sits. */
const JWT_SHAPED_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;

function stripScriptBodies(html: string): string {
	return html.replace(SCRIPT_BODY_RE, '');
}

function containsPerUserData(html: string): boolean {
	const outsideScript = stripScriptBodies(html);
	return (
		MUSTACHE_PLACEHOLDER_RE.test(outsideScript)
		|| EJS_PLACEHOLDER_RE.test(outsideScript)
		|| TEMPLATE_LITERAL_USER_RE.test(outsideScript)
		|| DUNDER_USER_RE.test(outsideScript)
		|| JWT_SHAPED_RE.test(html)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasDeclaredUi(manifest: Record<string, unknown>): boolean {
	if (isRecord(manifest.ui)) return true;
	const tools = manifest.tools;
	return Array.isArray(tools) && tools.some((tool) => isRecord(tool) && isRecord(tool.ui));
}

/**
 * `privos-app lint --publish` rules on top of the base + INSTANT lint —
 * guards against a wrong `ui.shellMode` declaration:
 *
 *  - `ui.shellMode` must be `static` (default) or `live`.
 *  - `shellMode: "live"` is refused for `executionMode: "INSTANT"` — there is
 *    no runtime to ever serve a per-user shell for a frontend-only app.
 *  - When the manifest declares any UI, calls `buildUiBundle` directly — the
 *    same function `bundle-ui --check` calls — and rejects a rendered shell
 *    containing per-user template placeholders or JWT-shaped tokens — a
 *    build-time-rendered shell is served to every user identically, so
 *    baking either into it is either a bug or a sign the app needs
 *    `shellMode: "live"` and a shell that is never bundled this way.
 *
 * This is a local, pre-publish check the SDK runs against the creator's own
 * build. It does not share code with, and is not a guarantee equivalent to,
 * the build node's independent `ui-build` shape gate or the Portal's own
 * preflight re-verification of the uploaded bundle — both re-check the
 * published artifact from scratch rather than trusting this pass.
 */
export function lintPublishUiBundle(manifest: unknown, options: { manifestDir: string }): LintPublishResult {
	const value = isRecord(manifest) ? manifest : {};
	const errors: string[] = [];
	const warnings: string[] = [];

	const uiConfig = isRecord(value.ui) ? value.ui : {};
	const shellModeRaw = uiConfig.shellMode ?? 'static';
	if (typeof shellModeRaw !== 'string' || !(UI_SHELL_MODES as readonly string[]).includes(shellModeRaw)) {
		errors.push(`ui.shellMode must be one of ${UI_SHELL_MODES.join(', ')}`);
		return { errors: Object.freeze(errors), warnings: Object.freeze(warnings) };
	}
	const shellMode = shellModeRaw as UiShellMode;
	if (shellMode === 'live' && value.executionMode === INSTANT_EXECUTION_MODE) {
		errors.push(
			'ui.shellMode "live" is not allowed for executionMode: "INSTANT" (a frontend-only app has no runtime to ever serve a per-user shell)',
		);
	}

	if (!hasDeclaredUi(value)) {
		return { errors: Object.freeze(errors), warnings: Object.freeze(warnings) };
	}

	const distDirOverride = typeof uiConfig.distDir === 'string' && uiConfig.distDir.trim() ? uiConfig.distDir : 'dist';
	const distDir = path.resolve(options.manifestDir, distDirOverride);

	try {
		const bundle = buildUiBundle({ distDir });
		if (containsPerUserData(bundle.shellHtml)) {
			errors.push(
				'the built shell contains per-user template placeholders or token-shaped values; a bundled shell is served statically and identically to every user — remove per-user data from the shell, or ship it only through assets fetched at runtime',
			);
		}
	} catch (error) {
		if (error instanceof UiBundleError) {
			errors.push(`bundle-ui check failed (${error.code}): ${error.message}`);
		} else {
			errors.push(`bundle-ui check failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { errors: Object.freeze(errors), warnings: Object.freeze(warnings) };
}
