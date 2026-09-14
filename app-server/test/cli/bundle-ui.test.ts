import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveUiDistDir, runBundleUi } from '../../src/cli/commands/bundle-ui.js';

const shellHtml = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>\n';

let workDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-ui-cli-'));
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
	logSpy.mockRestore();
	errorSpy.mockRestore();
	fs.rmSync(workDir, { recursive: true, force: true });
});

describe('resolveUiDistDir', () => {
	it('defaults to <cwd>/dist when the manifest declares no ui.distDir', () => {
		expect(resolveUiDistDir('/app', {})).toBe(path.resolve('/app', 'dist'));
	});

	it('honours a ui.distDir override relative to cwd', () => {
		expect(resolveUiDistDir('/app', { ui: { distDir: 'build/ui' } })).toBe(path.resolve('/app', 'build/ui'));
	});
});

describe('runBundleUi', () => {
	it('resolves --dist directly and writes a deterministic tar to --out', () => {
		const distDir = path.join(workDir, 'dist');
		fs.mkdirSync(distDir, { recursive: true });
		fs.writeFileSync(path.join(distDir, 'index.html'), shellHtml);
		const outPath = path.join(workDir, 'bundle.tar');

		expect(runBundleUi(['--dist', distDir, '--out', outPath], { cwd: workDir })).toBe(0);
		expect(fs.existsSync(outPath)).toBe(true);
		const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as { ok: boolean; outPath: string };
		expect(output.ok).toBe(true);
		expect(output.outPath).toBe(outPath);
	});

	it('resolves the manifest ui.distDir convention when --dist is omitted', () => {
		fs.writeFileSync(path.join(workDir, 'privos-app.json'), JSON.stringify({ name: 'x', ui: { distDir: 'ui-out' } }));
		const distDir = path.join(workDir, 'ui-out');
		fs.mkdirSync(distDir, { recursive: true });
		fs.writeFileSync(path.join(distDir, 'index.html'), shellHtml);

		expect(runBundleUi([], { cwd: workDir })).toBe(0);
		const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as { distDir: string };
		expect(output.distDir).toBe(distDir);
	});

	it('--check validates without writing --out', () => {
		const distDir = path.join(workDir, 'dist');
		fs.mkdirSync(distDir, { recursive: true });
		fs.writeFileSync(path.join(distDir, 'index.html'), shellHtml);
		const outPath = path.join(workDir, 'should-not-exist.tar');

		expect(runBundleUi(['--dist', distDir, '--out', outPath, '--check'], { cwd: workDir })).toBe(0);
		expect(fs.existsSync(outPath)).toBe(false);
	});

	it('exits 1 with a structured error when the dist directory has no index.html', () => {
		const distDir = path.join(workDir, 'dist');
		fs.mkdirSync(distDir, { recursive: true });

		expect(runBundleUi(['--dist', distDir], { cwd: workDir })).toBe(1);
		const output = JSON.parse(errorSpy.mock.calls[0]![0] as string) as { ok: boolean; message: string };
		expect(output.ok).toBe(false);
		expect(output.message).toContain('index.html');
	});
});
