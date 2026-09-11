/** Bridge version reported in `harness.hello`, `doctor`, and `--version` — read from package.json at runtime so it never drifts from the published version. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readPackageVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
		return pkg.version ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
}

export const BRIDGE_VERSION = readPackageVersion();
