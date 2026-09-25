import { describe, expect, it } from 'vitest';

import { canonicalJson, lintManifest, lintManifestV2, sha256CanonicalJson } from '../../src/manifest-tools.js';

const manifest = {
	schemaVersion: 2,
	kind: 'mcp-app',
	name: 'com.example.reports',
	version: '1.0.0',
	title: 'Reports',
	description: 'Create reports.',
	permissions: [
		{
			scope: 'basic:information',
			requirement: 'required',
			context: 'workspace',
			executionContext: 'both',
			feature: 'reports.core',
			reason: 'Identify the installation.',
		},
	],
};

describe('manifest v2 tooling', () => {
	it('produces deterministic canonical hashes', () => {
		expect(canonicalJson({ z: 1, a: { d: 2, b: 1 } })).toBe('{"a":{"b":1,"d":2},"z":1}');
		expect(sha256CanonicalJson({ b: 2, a: 1 })).toBe(sha256CanonicalJson({ a: 1, b: 2 }));
		const result = lintManifestV2(manifest);
		expect(result).toMatchObject({ valid: true });
		expect(result.canonicalManifestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(result.publisherPermissionDeclarationHash).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it('rejects legacy/mixed and duplicate-feature manifests', () => {
		expect(lintManifestV2({ ...manifest, schemaVersion: 1, scopes: ['basic:information'] })).toMatchObject({ valid: false });
		expect(lintManifestV2({ ...manifest, permissions: [...manifest.permissions, { ...manifest.permissions[0], scope: 'lists:read' }] }).errors)
			.toContain('permission feature identifiers must be unique');
	});
});

const lifecycleManifest = {
	...manifest,
	schemaVersion: 3,
	resourceManifestTemplate: [
		{
			resourceClass: 'reports-export-bucket',
			dataClass: 'PUBLISHER_EXTERNAL',
			ownershipScope: 'INSTALLATION_GENERATION',
			resourceKey: 'exports/generation',
			expectedCount: 1,
			purgeAdapter: 'reports.exports.purge',
			absenceAdapter: 'reports.exports.absence',
		},
	],
};

describe('manifest v3 tooling', () => {
	it('accepts a lifecycle manifest and keeps the v2 linter pinned', () => {
		expect(lintManifest(lifecycleManifest)).toMatchObject({ valid: true });
		expect(lintManifest({ ...lifecycleManifest, resourceManifestTemplate: [] })).toMatchObject({ valid: true });
		expect(lintManifest(manifest)).toMatchObject({ valid: true });
		expect(lintManifestV2(lifecycleManifest).errors).toContain('schemaVersion must be 2');
	});

	it('rejects reserved namespaces, duplicates, and malformed template entries', () => {
		const [entry] = lifecycleManifest.resourceManifestTemplate;
		expect(lintManifest({ ...lifecycleManifest, resourceManifestTemplate: [{ ...entry, resourceClass: 'privos-forged' }] }).errors)
			.toContain('resourceManifestTemplate[0] uses a reserved PrivOS resource namespace');
		expect(lintManifest({ ...lifecycleManifest, resourceManifestTemplate: [{ ...entry, resourceKey: 'privos/system/forged' }] }).errors)
			.toContain('resourceManifestTemplate[0] uses a reserved PrivOS resource namespace');
		expect(lintManifest({ ...lifecycleManifest, resourceManifestTemplate: [entry, entry] }).errors)
			.toContain('resourceManifestTemplate[1] duplicates an earlier resource identity');
		expect(lintManifest({ ...lifecycleManifest, resourceManifestTemplate: [{ ...entry, dataClass: 'OTHER', expectedCount: -1 }] }))
			.toMatchObject({ valid: false });
		expect(lintManifest({ ...manifest, resourceManifestTemplate: [] }).errors)
			.toContain('resourceManifestTemplate requires schemaVersion 3');
	});

	it('binds the permission declaration hash to the declared schema version', () => {
		expect(lintManifest(lifecycleManifest).publisherPermissionDeclarationHash)
			.not.toBe(lintManifest(manifest).publisherPermissionDeclarationHash);
	});

	it('accepts publicAccess and exposedPorts, and enforces their rules', () => {
		expect(lintManifest({ ...lifecycleManifest, publicAccess: 'required', exposedPorts: [{ name: 'api', port: 8080 }] }))
			.toMatchObject({ valid: true });
		expect(lintManifest({ ...lifecycleManifest, publicAccess: 'bogus' }).errors)
			.toContain('publicAccess must be one of none, optional, required');
		expect(lintManifest({ ...lifecycleManifest, publicAccess: 'none', exposedPorts: [{ name: 'api', port: 8080 }] }).errors)
			.toContain('exposedPorts cannot be declared with publicAccess "none"');
		expect(lintManifest({ ...lifecycleManifest, exposedPorts: [{ name: 'api', port: 8080 }, { name: 'api', port: 9090 }] }).errors)
			.toContain('exposedPorts names must be unique');
		expect(lintManifest({ ...lifecycleManifest, exposedPorts: [{ name: 'api', port: 8080 }, { name: 'metrics', port: 8080 }] }).errors)
			.toContain('exposedPorts ports must be unique');
		expect(lintManifest({ ...lifecycleManifest, port: 8080, exposedPorts: [{ name: 'api', port: 8080 }] }).errors)
			.toContain('An exposedPorts port must differ from the main port');
		expect(lintManifest({ ...lifecycleManifest, exposedPorts: [{ name: 'main', port: 8080 }] }).errors)
			.toContain('exposedPorts[0].name "main" is reserved for the main port');
		expect(lintManifest({ ...manifest, exposedPorts: [{ name: 'api', port: 8080 }] }).errors)
			.toContain('exposedPorts requires schemaVersion 3');
	});
});
