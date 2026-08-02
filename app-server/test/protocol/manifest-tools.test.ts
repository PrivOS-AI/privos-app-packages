import { describe, expect, it } from 'vitest';

import { canonicalJson, lintManifestV2, sha256CanonicalJson } from '../../src/manifest-tools.js';

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
