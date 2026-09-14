import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runLint } from '../../src/cli/commands/lint.js';

const validInstantManifest = {
	schemaVersion: 2,
	kind: 'mcp-app',
	name: 'com.example.reports',
	version: '1.0.0',
	title: 'Reports',
	description: 'Create reports.',
	executionMode: 'INSTANT',
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
	ui: {
		entryPoints: {
			roomTab: { title: 'Reports', resourceUri: 'ui://com.example.reports/dashboard.html' },
		},
	},
};

describe('runLint — INSTANT dispatch', () => {
	let workDir: string;
	let manifestPath: string;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privos-app-lint-cli-test-'));
		manifestPath = path.join(workDir, 'privos-app.json');
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
	});

	afterEach(() => {
		logSpy.mockRestore();
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it('exits 0 for a valid INSTANT manifest', () => {
		fs.writeFileSync(manifestPath, JSON.stringify(validInstantManifest));
		expect(runLint([manifestPath])).toBe(0);
	});

	it('exits 1 and names the offending field for an INSTANT manifest declaring tools', () => {
		fs.writeFileSync(manifestPath, JSON.stringify({
			...validInstantManifest,
			tools: [{ name: 'x', title: 'x', description: 'x', inputSchema: {}, ui: { resourceUri: 'ui://com.example.reports/x.html' } }],
		}));
		expect(runLint([manifestPath])).toBe(1);
		const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as { valid: boolean; errors: string[] };
		expect(output.valid).toBe(false);
		expect(output.errors.some((error) => error.startsWith('tools is forbidden'))).toBe(true);
	});

	it('exits 1 for an INSTANT manifest missing ui.entryPoints.roomTab', () => {
		const { ui: _ui, ...withoutUi } = validInstantManifest;
		fs.writeFileSync(manifestPath, JSON.stringify(withoutUi));
		expect(runLint([manifestPath])).toBe(1);
		const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as { errors: string[] };
		expect(output.errors).toContain('ui.entryPoints is required for executionMode: "INSTANT"');
	});

	it('does not run INSTANT rules for a non-INSTANT manifest', () => {
		fs.writeFileSync(manifestPath, JSON.stringify({ ...validInstantManifest, executionMode: undefined, ui: undefined }));
		// Missing ui.entryPoints must not fail a non-INSTANT manifest — but this
		// manifest also lacks `tools`, which base lintManifest does not require
		// either, so it must be valid.
		expect(runLint([manifestPath])).toBe(0);
	});

	it('surfaces a Dockerfile-presence warning without failing the lint', () => {
		fs.writeFileSync(manifestPath, JSON.stringify(validInstantManifest));
		fs.writeFileSync(path.join(workDir, 'Dockerfile'), 'FROM scratch\n');
		expect(runLint([manifestPath])).toBe(0);
		const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as { warnings?: string[] };
		expect(output.warnings?.[0]).toContain('Dockerfile is present');
	});
});

describe('runLint --publish', () => {
	let workDir: string;
	let manifestPath: string;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privos-app-lint-publish-cli-test-'));
		manifestPath = path.join(workDir, 'privos-app.json');
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
	});

	afterEach(() => {
		logSpy.mockRestore();
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it('does not run the publish rule set without --publish, even for a manifest that would fail it', () => {
		fs.writeFileSync(manifestPath, JSON.stringify({ ...validInstantManifest, ui: { ...validInstantManifest.ui, shellMode: 'not-a-mode' } }));
		expect(runLint([manifestPath])).toBe(0);
	});

	it('exits 1 and names ui.shellMode when --publish is given an invalid value', () => {
		fs.writeFileSync(manifestPath, JSON.stringify({ ...validInstantManifest, ui: { ...validInstantManifest.ui, shellMode: 'not-a-mode' } }));
		expect(runLint([manifestPath, '--publish'])).toBe(1);
		const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as { errors: string[] };
		expect(output.errors.some((error) => error.includes('ui.shellMode must be one of'))).toBe(true);
	});

	it('exits 1 with --publish when an INSTANT manifest declares ui.shellMode: "live"', () => {
		fs.writeFileSync(manifestPath, JSON.stringify({ ...validInstantManifest, ui: { ...validInstantManifest.ui, shellMode: 'live' } }));
		expect(runLint([manifestPath, '--publish'])).toBe(1);
		const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as { errors: string[] };
		expect(output.errors.some((error) => error.includes('not allowed for executionMode: "INSTANT"'))).toBe(true);
	});

	it('exits 1 with --publish when the declared UI has no bundle-able dist/ output', () => {
		fs.writeFileSync(manifestPath, JSON.stringify(validInstantManifest));
		expect(runLint([manifestPath, '--publish'])).toBe(1);
		const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as { errors: string[] };
		expect(output.errors.some((error) => error.startsWith('bundle-ui check failed'))).toBe(true);
	});

	it('exits 0 with --publish when the declared UI bundles cleanly', () => {
		fs.mkdirSync(path.join(workDir, 'dist'));
		fs.writeFileSync(
			path.join(workDir, 'dist', 'index.html'),
			'<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>\n',
		);
		fs.writeFileSync(manifestPath, JSON.stringify(validInstantManifest));
		expect(runLint([manifestPath, '--publish'])).toBe(0);
	});
});
