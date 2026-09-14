import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { buildUiBundle, UiBundleError } from '../../ui/bundle-ui.js';
import { loadManifest } from '../lib/manifest.js';

export type BundleUiRuntimeOptions = Readonly<{
	cwd?: string;
}>;

/**
 * `ui.distDir` (relative to the manifest directory) overrides the SDK's
 * default convention (`<cwd>/dist`, the directory every scaffolder template
 * and `serveBuiltUi` example is configured with).
 */
export function resolveUiDistDir(cwd: string, manifest: Record<string, unknown>): string {
	const ui = manifest.ui;
	const distDirOverride =
		ui && typeof ui === 'object' && !Array.isArray(ui) ? (ui as Record<string, unknown>).distDir : undefined;
	if (typeof distDirOverride === 'string' && distDirOverride.trim().length > 0) {
		return path.resolve(cwd, distDirOverride);
	}
	return path.resolve(cwd, 'dist');
}

/**
 * `privos-app bundle-ui [--dist <dir>] [--out <file>] [--check]` — packages
 * the UI build at `distDir` into the exact tar the build node's `ui-build`
 * stage and the Hub ingest expect (`shell.html` + `assets-manifest.json` +
 * `assets/*`). `--dist` overrides `ui.distDir` / the `<cwd>/dist` default;
 * `--out` writes the tar to disk; `--check` runs the same build+budget
 * validation without requiring `--out` (used by `privos-app lint --publish`)
 * and never writes a file even when `--out` is also given. The build node's
 * `ui-build` stage runs this command *without* `--check` (it needs the real
 * tar), then re-validates the produced artifact's shape independently with
 * its own `check-ui-bundle-shape.py`.
 */
export function runBundleUi(argv: readonly string[], runtime: BundleUiRuntimeOptions = {}): number {
	let values: Record<string, unknown>;
	try {
		({ values } = parseArgs({
			args: argv as string[],
			options: {
				dist: { type: 'string' },
				out: { type: 'string' },
				check: { type: 'boolean', default: false },
				cwd: { type: 'string' },
				help: { type: 'boolean', default: false, short: 'h' },
			},
			allowPositionals: false,
		}));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 5;
	}

	if (values.help) {
		printUsage();
		return 0;
	}

	const cwd = path.resolve(runtime.cwd ?? (typeof values.cwd === 'string' ? values.cwd : process.cwd()));
	const distDir = resolveDistDir(cwd, values);

	try {
		const result = buildUiBundle({ distDir });
		const checkMode = Boolean(values.check);
		let outPath: string | undefined;
		if (typeof values.out === 'string' && !checkMode) {
			outPath = path.resolve(cwd, values.out);
			fs.mkdirSync(path.dirname(outPath), { recursive: true });
			fs.writeFileSync(outPath, result.tar);
		}
		console.log(JSON.stringify({
			ok: true,
			distDir,
			files: result.files,
			totalBytes: result.totalBytes,
			...(outPath ? { outPath } : {}),
		}, null, 2));
		return 0;
	} catch (error) {
		const code = error instanceof UiBundleError ? error.code : 'UI_BUNDLE_BUILD_FAILED';
		console.error(JSON.stringify({
			ok: false,
			code,
			message: error instanceof Error ? error.message : String(error),
		}, null, 2));
		return 1;
	}
}

function resolveDistDir(cwd: string, values: Record<string, unknown>): string {
	if (typeof values.dist === 'string' && values.dist.trim().length > 0) {
		return path.resolve(cwd, values.dist);
	}
	let manifest: Record<string, unknown> = {};
	try {
		({ manifest } = loadManifest(cwd));
	} catch {
		// No privos-app.json on disk (or unreadable) — fall back to the SDK's
		// plain `dist/` convention rather than failing before the real check.
	}
	return resolveUiDistDir(cwd, manifest);
}

function printUsage(): void {
	console.log(`Usage: privos-app bundle-ui [options]

Packages the UI build in --dist (default: ui.distDir from privos-app.json, or
./dist) into the tar the build node and the Hub expect: shell.html,
assets-manifest.json, assets/*. The shell is rendered with the exact same
code serveBuiltUi uses at runtime, so the bundle and what the app serves live
are always byte-identical.

Options:
  --dist <dir>    UI build output directory (default: ui.distDir or ./dist)
  --out <file>    Write the deterministic tar to this path
  --check         Validate only (build + budgets); never writes --out
  --cwd <path>    Directory containing privos-app.json (default: cwd)
  -h, --help      Show this help

Exit codes: 0 valid, 1 build or budget failure, 5 usage.`);
}
