import { describe, expect, it } from 'vitest';

import {
	buildManifestJson,
	validateDescriptorPermissions,
	type AppDescriptor,
} from '../../src/index.js';

const v2Descriptor: AppDescriptor = {
	id: 'com.example.reports',
	name: 'Reports',
	version: '2.0.0',
	permissions: [
		{
			scope: 'files:write',
			requirement: 'optional',
			context: 'room',
			executionContext: 'background',
			feature: 'reports.export',
			reason: 'Export generated reports',
			recommended: true,
			degradedBehavior: 'Exports remain available for manual download.',
		},
	],
};
const v2Permission = v2Descriptor.permissions![0]!;

describe('manifest permission contract v2', () => {
	it('emits schema v2 without legacy scopes', () => {
		const manifest = buildManifestJson(v2Descriptor);
		expect(manifest.schemaVersion).toBe(2);
		expect(manifest.permissions).toEqual(v2Descriptor.permissions);
		expect(manifest).not.toHaveProperty('scopes');
	});

	it('keeps a versioned legacy adapter', () => {
		expect(buildManifestJson({ ...v2Descriptor, permissions: undefined, scopes: ['files:read'] })).toMatchObject({
			schemaVersion: 1,
			scopes: ['files:read'],
		});
	});

	it('rejects mixed, duplicate, and malformed declarations', () => {
		expect(() => validateDescriptorPermissions({ scopes: ['files:read'], permissions: v2Descriptor.permissions })).toThrow(
			'must not combine',
		);
		expect(() =>
			validateDescriptorPermissions({ permissions: [...v2Descriptor.permissions!, ...v2Descriptor.permissions!] }),
		).toThrow('duplicate permission scope');
		expect(() =>
			validateDescriptorPermissions({
				permissions: [{ ...v2Permission, feature: 'Not Valid' }],
			}),
		).toThrow('invalid permission declaration');
	});

	it('requires deterministic degradation only for optional permissions', () => {
		expect(() =>
			validateDescriptorPermissions({
				permissions: [{ ...v2Permission, degradedBehavior: undefined }],
			}),
		).toThrow('safe degraded behavior');
		expect(() =>
			validateDescriptorPermissions({
				permissions: [{ ...v2Permission, requirement: 'required', degradedBehavior: 'The feature is unavailable.' }],
			}),
		).toThrow('required permission cannot declare');
	});
});
