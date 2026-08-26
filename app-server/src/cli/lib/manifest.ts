import fs from 'node:fs';
import path from 'node:path';

import { lintManifest, type ManifestLintResult } from '../../manifest-tools.js';

/** Raised when `privos-app.json` or `package.json` cannot be located or parsed. */
export class ManifestLoadError extends Error {}

export type LoadedManifest = Readonly<{
	manifestPath: string;
	manifest: Record<string, unknown>;
}>;

export type LoadedPackageJson = Readonly<{
	packagePath: string;
	pkg: Record<string, unknown>;
}>;

function readJsonObject(filePath: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, 'utf8');
	} catch {
		throw new ManifestLoadError(`Unable to read ${filePath}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ManifestLoadError(`Unable to read valid JSON from ${filePath}`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new ManifestLoadError(`${filePath} must contain a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

export function loadManifest(cwd: string, manifestFile = 'privos-app.json'): LoadedManifest {
	const manifestPath = path.resolve(cwd, manifestFile);
	return { manifestPath, manifest: readJsonObject(manifestPath) };
}

export function loadPackageJson(cwd: string): LoadedPackageJson {
	const packagePath = path.resolve(cwd, 'package.json');
	return { packagePath, pkg: readJsonObject(packagePath) };
}

/**
 * `privos-app.json` and `package.json` must agree on the identity fields the
 * Portal binds a publish grant to (`name`, `version`). This is a CLI-side
 * fast-fail check; the Portal independently verifies `manifest.name` /
 * `manifest.version` on `complete` (`409 PUBLISH_GRANT_MISMATCH`).
 */
export function assertIdentityAgreement(manifest: Record<string, unknown>, pkg: Record<string, unknown>): string[] {
	const errors: string[] = [];
	if (manifest.name !== pkg.name) {
		errors.push(`privos-app.json "name" (${JSON.stringify(manifest.name)}) does not match package.json "name" (${JSON.stringify(pkg.name)})`);
	}
	if (manifest.version !== pkg.version) {
		errors.push(`privos-app.json "version" (${JSON.stringify(manifest.version)}) does not match package.json "version" (${JSON.stringify(pkg.version)})`);
	}
	return errors;
}

/**
 * Structure-only lint. `result.canonicalManifestHash` is the SDK's structural
 * digest (key-sorted JSON, `localeCompare`) and is NOT the Portal's canonical
 * digest (which may differ in comparator and Zod-applied defaults). It must
 * never be sent to the Portal; the Portal computes and returns the
 * authoritative `manifestDigest` on upload `complete`.
 */
export function structuralLint(manifest: unknown): ManifestLintResult {
	return lintManifest(manifest);
}
