import fs from 'node:fs';
import path from 'node:path';

import { lintManifest } from '../../manifest-tools.js';

/**
 * `privos-app lint [manifestPath]` — identical behavior to the original
 * `privos-app-lint` binary (byte-identical stdout/stderr and exit code).
 * `src/manifest-lint-cli.ts` delegates here so the compatibility alias never
 * drifts from this implementation.
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

	const result = lintManifest(manifest);
	console.log(JSON.stringify({ manifestPath, ...result }, null, 2));
	return result.valid ? 0 : 1;
}
