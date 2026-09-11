import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INSTANT_UI_ENTRY_POINT_SLOTS, lintInstantManifest } from '../../src/manifest-lint-instant.js';
import { lintManifest } from '../../src/manifest-tools.js';

const basePermissions = [
	{
		scope: 'basic:information',
		requirement: 'required',
		context: 'workspace',
		executionContext: 'both',
		feature: 'reports.core',
		reason: 'Identify the installation.',
	},
];

const instantManifest = {
	schemaVersion: 2,
	kind: 'mcp-app',
	name: 'com.example.reports',
	version: '1.0.0',
	title: 'Reports',
	description: 'Create reports.',
	executionMode: 'INSTANT',
	permissions: basePermissions,
	ui: {
		entryPoints: {
			roomTab: { title: 'Reports', resourceUri: 'ui://com.example.reports/dashboard.html' },
		},
	},
};

describe('lintInstantManifest — non-INSTANT manifests', () => {
	it('is a no-op for a manifest with no executionMode', () => {
		expect(lintInstantManifest({ ...instantManifest, executionMode: undefined })).toEqual({ errors: [], warnings: [] });
	});

	it('is a no-op for a non-INSTANT executionMode', () => {
		expect(lintInstantManifest({ ...instantManifest, executionMode: 'SELF_HOSTED_LOCAL' })).toEqual({ errors: [], warnings: [] });
	});

	it('is a no-op for a non-object manifest', () => {
		expect(lintInstantManifest(null)).toEqual({ errors: [], warnings: [] });
		expect(lintInstantManifest('not a manifest')).toEqual({ errors: [], warnings: [] });
	});
});

describe('lintInstantManifest — forbidden fields', () => {
	it('accepts a minimal, well-formed INSTANT manifest', () => {
		const result = lintInstantManifest(instantManifest);
		expect(result.errors).toEqual([]);
		expect(lintManifest(instantManifest)).toMatchObject({ valid: true });
	});

	it.each([
		['tools', [{ name: 'x', title: 'x', description: 'x', inputSchema: {}, ui: { resourceUri: 'ui://a/x.html' } }]],
		['serverUrl', 'https://example.com'],
		['runtimeTrustProvisioningUrl', 'https://example.com/.well-known/privos/runtime-trust/v3'],
		['port', 3001],
		['resources', { memoryMb: 512, cpus: 0.5, tmpSizeMb: 64 }],
		['volumes', []],
		['stateless', true],
	])('rejects %s alongside executionMode: "INSTANT", naming the field', (field, value) => {
		const manifest = { ...instantManifest, [field]: value };
		const errors = lintInstantManifest(manifest).errors;
		expect(errors.some((error) => error.startsWith(`${field} is forbidden`))).toBe(true);
	});
});

describe('lintInstantManifest — ui.entryPoints', () => {
	it('requires ui.entryPoints entirely', () => {
		const { ui: _ui, ...withoutUi } = instantManifest;
		expect(lintInstantManifest(withoutUi).errors).toContain('ui.entryPoints is required for executionMode: "INSTANT"');
	});

	it('requires the roomTab slot', () => {
		const manifest = { ...instantManifest, ui: { entryPoints: { sidebar: instantManifest.ui.entryPoints.roomTab } } };
		expect(lintInstantManifest(manifest).errors).toContain('ui.entryPoints.roomTab is required for executionMode: "INSTANT"');
	});

	it('rejects an unsupported slot name', () => {
		const manifest = {
			...instantManifest,
			ui: { entryPoints: { ...instantManifest.ui.entryPoints, popup: { title: 'x', resourceUri: 'ui://com.example.reports/x.html' } } },
		};
		expect(lintInstantManifest(manifest).errors.some((error) => error.includes('ui.entryPoints.popup is not a supported slot'))).toBe(true);
	});

	it('rejects a slot missing a title', () => {
		const manifest = { ...instantManifest, ui: { entryPoints: { roomTab: { resourceUri: 'ui://com.example.reports/dashboard.html' } } } };
		expect(lintInstantManifest(manifest).errors).toContain('ui.entryPoints.roomTab.title must be a non-empty string');
	});

	it('rejects a resourceUri with the wrong shape', () => {
		const manifest = { ...instantManifest, ui: { entryPoints: { roomTab: { title: 'Reports', resourceUri: 'https://example.com/dashboard.html' } } } };
		expect(lintInstantManifest(manifest).errors).toContain('ui.entryPoints.roomTab.resourceUri must match "ui://<appId>/<file>.html"');
	});

	it('rejects a resourceUri namespaced under a different appId than manifest.name', () => {
		const manifest = { ...instantManifest, ui: { entryPoints: { roomTab: { title: 'Reports', resourceUri: 'ui://someone-else/dashboard.html' } } } };
		expect(lintInstantManifest(manifest).errors.some((error) => error.includes("must be namespaced under this manifest's \"name\""))).toBe(true);
	});

	it('accepts all three modeled slots', () => {
		expect(INSTANT_UI_ENTRY_POINT_SLOTS).toEqual(['roomTab', 'sidebar', 'standalone']);
		const manifest = {
			...instantManifest,
			ui: {
				entryPoints: {
					roomTab: { title: 'Reports', resourceUri: 'ui://com.example.reports/dashboard.html' },
					sidebar: { title: 'Reports', resourceUri: 'ui://com.example.reports/sidebar.html' },
					standalone: { title: 'Reports', resourceUri: 'ui://com.example.reports/standalone.html' },
				},
			},
		};
		expect(lintInstantManifest(manifest).errors).toEqual([]);
	});
});

describe('lintInstantManifest — agent section', () => {
	it('is optional', () => {
		expect(lintInstantManifest(instantManifest).errors).toEqual([]);
	});

	it('requires purpose when present', () => {
		expect(lintInstantManifest({ ...instantManifest, agent: {} }).errors).toContain('agent.purpose must be a non-empty string');
	});

	it('errors (does not silently truncate) when a capped field is too long — matching sanitizeAgentData caps', () => {
		const manifest = {
			...instantManifest,
			agent: {
				purpose: 'p'.repeat(2001),
				personality: 'x'.repeat(2001),
				instructions: 'y'.repeat(5001),
				knowledge: Array.from({ length: 21 }, (_, i) => `k${i}`),
			},
		};
		const { errors } = lintInstantManifest(manifest);
		expect(errors).toContain('agent.purpose exceeds the maximum length of 2000 characters');
		expect(errors).toContain('agent.personality exceeds the maximum length of 2000 characters');
		expect(errors).toContain('agent.instructions exceeds the maximum length of 5000 characters');
		expect(errors).toContain('agent.knowledge exceeds the maximum of 20 items');
	});

	it('errors on an over-length knowledge item', () => {
		const manifest = { ...instantManifest, agent: { purpose: 'p', knowledge: ['k'.repeat(501)] } };
		expect(lintInstantManifest(manifest).errors).toContain('agent.knowledge[0] exceeds the maximum length of 500 characters');
	});

	it('accepts hubTools with no length cap (bounded by the Hub at install time, not here)', () => {
		const manifest = { ...instantManifest, agent: { purpose: 'p', hubTools: Array.from({ length: 50 }, (_, i) => `route.${i}`) } };
		expect(lintInstantManifest(manifest).errors).toEqual([]);
	});

	it('rejects a non-string/empty-string hubTools entry', () => {
		const manifest = { ...instantManifest, agent: { purpose: 'p', hubTools: ['ok', ''] } };
		expect(lintInstantManifest(manifest).errors).toContain('agent.hubTools must be an array of non-empty strings');
	});
});

describe('lintInstantManifest — Dockerfile presence', () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-lint-instant-test-'));
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it('warns, but does not error, when a Dockerfile sits beside an INSTANT manifest', () => {
		fs.writeFileSync(path.join(workDir, 'Dockerfile'), 'FROM scratch\n');
		const result = lintInstantManifest(instantManifest, { manifestDir: workDir });
		expect(result.errors).toEqual([]);
		expect(result.warnings.length).toBe(1);
		expect(result.warnings[0]).toContain('Dockerfile is present');
	});

	it('has no warning when no Dockerfile is present', () => {
		expect(lintInstantManifest(instantManifest, { manifestDir: workDir }).warnings).toEqual([]);
	});

	it('has no warning when manifestDir is omitted', () => {
		expect(lintInstantManifest(instantManifest).warnings).toEqual([]);
	});
});
