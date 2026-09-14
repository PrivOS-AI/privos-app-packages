import fs from 'node:fs';
import path from 'node:path';

import { lintInstantManifest } from '../../manifest-lint-instant.js';
import { lintPublishUiBundle } from '../../manifest-lint-publish.js';
import { lintManifest } from '../../manifest-tools.js';

/**
 * `privos-app lint [manifestPath] [--publish]` — identical behavior to the
 * original `privos-app-lint` binary (byte-identical stdout/stderr and exit
 * code) for the base case. `src/manifest-lint-cli.ts` delegates here so the
 * compatibility alias never drifts from this implementation. Runs the base
 * manifest lint plus, when the manifest declares `executionMode: "INSTANT"`,
 * the Phase 11 INSTANT rule set (`manifest-lint-instant.ts`) — dispatched
 * here, the single call site both bins share, so the alias can never drift
 * out of sync with it.
 *
 * `--publish` additionally runs `manifest-lint-publish.ts`: `ui.shellMode`
 * validity, the `shellMode: "live"` + `executionMode: "INSTANT"` refusal,
 * and (when the manifest declares a UI) the same `buildUiBundle` build +
 * budget validation `bundle-ui --check` runs. This is a local, pre-publish
 * check only — it mirrors, but does not share infrastructure with, the build
 * node's independent `ui-build` shape gate or the Portal's own preflight
 * re-verification of the uploaded bundle.
 */
export function runLint(argv: readonly string[]): number {
	const publishMode = argv.includes('--publish');
	const positionals = argv.filter((arg) => arg !== '--publish');
	const manifestPath = path.resolve(positionals[0] || 'privos-app.json');
	let manifest: unknown;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch {
		console.error(JSON.stringify({ valid: false, errors: [`Unable to read valid JSON from ${manifestPath}`] }, null, 2));
		return 1;
	}

	const base = lintManifest(manifest);
	const instant = lintInstantManifest(manifest, { manifestDir: path.dirname(manifestPath) });
	const publish = publishMode
		? lintPublishUiBundle(manifest, { manifestDir: path.dirname(manifestPath) })
		: { errors: [], warnings: [] };
	const errors = [...base.errors, ...instant.errors, ...publish.errors];
	const warnings = [...instant.warnings, ...publish.warnings];
	const valid = errors.length === 0;
	const output = {
		manifestPath,
		...base,
		errors,
		valid,
		...(warnings.length ? { warnings } : {}),
	};
	console.log(JSON.stringify(output, null, 2));
	return valid ? 0 : 1;
}
