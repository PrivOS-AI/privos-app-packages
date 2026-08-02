import crypto from 'node:crypto';

import {
	validateDescriptorPermissions,
	type AppPermissionDescriptor,
} from './app-descriptor.js';

export type ManifestLintResult = Readonly<{
	valid: boolean;
	errors: readonly string[];
	canonicalManifestHash: string;
	publisherPermissionDeclarationHash?: string;
}>;

export function canonicalJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJsonValue);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalJsonValue(child)]),
		);
	}
	if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Canonical JSON cannot contain non-finite numbers.');
	return value;
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalJsonValue(value));
}

export function sha256CanonicalJson(value: unknown): string {
	return `sha256:${crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

export function lintManifestV2(manifest: unknown): ManifestLintResult {
	const errors: string[] = [];
	const value = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
		? manifest as Record<string, unknown>
		: {};
	if (value.schemaVersion !== 2) errors.push('schemaVersion must be 2');
	if (value.kind !== 'mcp-app') errors.push('kind must be "mcp-app"');
	if (value.scopes !== undefined) errors.push('schema v2 must not contain legacy scopes');
	for (const field of ['name', 'version', 'title', 'description'] as const) {
		if (typeof value[field] !== 'string' || !String(value[field]).trim()) errors.push(`${field} must be a non-empty string`);
	}
	const permissions = Array.isArray(value.permissions) ? value.permissions as AppPermissionDescriptor[] : undefined;
	try {
		validateDescriptorPermissions({ permissions });
		if (!permissions?.length) errors.push('permissions must contain at least one declaration');
	} catch (error) {
		errors.push(error instanceof Error ? error.message : 'permissions are invalid');
	}
	if (permissions) {
		const features = permissions.map(({ feature }) => feature);
		if (new Set(features).size !== features.length) errors.push('permission feature identifiers must be unique');
		if (!permissions.some(({ requirement }) => requirement === 'required')) errors.push('at least one permission must be required');
	}
	return Object.freeze({
		valid: errors.length === 0,
		errors: Object.freeze(errors),
		canonicalManifestHash: sha256CanonicalJson(value),
		...(permissions
			? { publisherPermissionDeclarationHash: sha256CanonicalJson({ schemaVersion: 2, permissions }) }
			: {}),
	});
}
