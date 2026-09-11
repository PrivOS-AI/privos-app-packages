import fs from 'node:fs';
import path from 'node:path';

import { lintInstantManifest } from '../../manifest-lint-instant.js';
import { lintManifest } from '../../manifest-tools.js';

/**
 * `privos-app lint [manifestPath]` — identical behavior to the original
 * `privos-app-lint` binary (byte-identical stdout/stderr and exit code).
 * `src/manifest-lint-cli.ts` delegates here so the compatibility alias never
 * drifts from this implementation. Runs the base manifest lint plus, when
 * the manifest declares `executionMode: "INSTANT"`, the Phase 11 INSTANT
 * rule set (`manifest-lint-instant.ts`) — dispatched here, the single call
 * site both bins share, so the alias can never drift out of sync with it.
 */
export function runLint(argv: readonly string[]): number {
	const manifestPath = path.resolve(argv[0] || 'privos-app.json');
	let manifest: unknown;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch {
		console.error(JSON.stringify({ valid: false, errors: [`Unable to read valid JSON from ${manifestPath}`] }, null, 2));
		return 1;
	}

	const base = lintManifest(manifest);
	const instant = lintInstantManifest(manifest, { manifestDir: path.dirname(manifestPath) });
	const errors = [...base.errors, ...instant.errors];
	const valid = base.valid && instant.errors.length === 0;
	const output = {
		manifestPath,
		...base,
		errors,
		valid,
		...(instant.warnings.length ? { warnings: instant.warnings } : {}),
	};
	console.log(JSON.stringify(output, null, 2));
	return valid ? 0 : 1;
}
