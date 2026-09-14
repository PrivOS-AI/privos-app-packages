import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { lintPublishUiBundle } from '../src/manifest-lint-publish.js';

function writeMinimalDist(distDir: string, indexHtml: string): void {
	fs.mkdirSync(distDir, { recursive: true });
	fs.writeFileSync(path.join(distDir, 'index.html'), indexHtml);
}

const inertShell = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">console.log(1);</script></body></html>\n';

let manifestDir: string;

beforeEach(() => {
	manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-publish-'));
});

afterEach(() => {
	fs.rmSync(manifestDir, { recursive: true, force: true });
});

describe('lintPublishUiBundle — ui.shellMode', () => {
	it('accepts the default (no ui.shellMode declared) as static and skips the bundle check when no UI is declared', () => {
		const result = lintPublishUiBundle({ name: 'com.example.app' }, { manifestDir });
		expect(result.errors).toEqual([]);
	});

	it('rejects an invalid ui.shellMode value', () => {
		const result = lintPublishUiBundle({ name: 'com.example.app', ui: { shellMode: 'sometimes' } }, { manifestDir });
		expect(result.errors.some((error) => error.includes('ui.shellMode must be one of'))).toBe(true);
	});

	it('rejects ui.shellMode: "live" for executionMode: "INSTANT"', () => {
		const result = lintPublishUiBundle(
			{ name: 'com.example.app', executionMode: 'INSTANT', ui: { shellMode: 'live', entryPoints: {} } },
			{ manifestDir },
		);
		expect(result.errors.some((error) => error.includes('not allowed for executionMode: "INSTANT"'))).toBe(true);
	});

	it('allows ui.shellMode: "live" for a non-INSTANT app', () => {
		writeMinimalDist(path.join(manifestDir, 'dist'), inertShell);
		const result = lintPublishUiBundle(
			{ name: 'com.example.app', ui: { shellMode: 'live' }, tools: [{ ui: { resourceUri: 'ui://com.example.app/x.html' } }] },
			{ manifestDir },
		);
		expect(result.errors.some((error) => error.includes('not allowed'))).toBe(false);
	});
});

describe('lintPublishUiBundle — static shell guard (per-user data)', () => {
	it('rejects a shell containing a {{user template placeholder', () => {
		writeMinimalDist(
			path.join(manifestDir, 'dist'),
			'<!doctype html><html><head><meta charset="utf-8"></head><body>Hello {{user.name}}</body></html>\n',
		);
		const result = lintPublishUiBundle(
			{ name: 'com.example.app', tools: [{ ui: { resourceUri: 'ui://com.example.app/x.html' } }] },
			{ manifestDir },
		);
		expect(result.errors.some((error) => error.includes('per-user template placeholders'))).toBe(true);
	});

	it('rejects a shell containing a JWT-shaped token', () => {
		const jwtShaped = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
		writeMinimalDist(
			path.join(manifestDir, 'dist'),
			`<!doctype html><html><head><meta charset="utf-8"></head><body data-token="${jwtShaped}"></body></html>\n`,
		);
		const result = lintPublishUiBundle(
			{ name: 'com.example.app', tools: [{ ui: { resourceUri: 'ui://com.example.app/x.html' } }] },
			{ manifestDir },
		);
		expect(result.errors.some((error) => error.includes('per-user template placeholders'))).toBe(true);
	});

	it('accepts a shell with neither placeholder nor token-shaped content', () => {
		writeMinimalDist(path.join(manifestDir, 'dist'), inertShell);
		const result = lintPublishUiBundle(
			{ name: 'com.example.app', tools: [{ ui: { resourceUri: 'ui://com.example.app/x.html' } }] },
			{ manifestDir },
		);
		expect(result.errors).toEqual([]);
	});

	function lintOutsideScript(body: string) {
		writeMinimalDist(
			path.join(manifestDir, 'dist'),
			`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>\n`,
		);
		return lintPublishUiBundle(
			{ name: 'com.example.app', tools: [{ ui: { resourceUri: 'ui://com.example.app/x.html' } }] },
			{ manifestDir },
		);
	}

	it.each([
		['generic {{mustache}} placeholder', '{{ workspace.name }}'],
		['EJS/ERB-style <% %> placeholder', '<%= currentUser.email %>'],
		['template-literal ${user…} interpolation', 'Hi ${user.firstName}'],
		['dunder __USER__-style marker', 'Welcome __USER_NAME__'],
	])('rejects a shell containing a %s', (_label, marker) => {
		const result = lintOutsideScript(marker);
		expect(result.errors.some((error) => error.includes('per-user template placeholders'))).toBe(true);
	});

	it.each([
		['{{mustache}}', '{{ workspace.name }}'],
		['<% %>', '<%= currentUser.email %>'],
		['${…}', 'const greeting = `Hi ${user.firstName}`;'],
		['__USER__', 'const marker = "__USER_NAME__";'],
	])('does not flag a %s pattern that only appears inside a <script> body', (_label, code) => {
		writeMinimalDist(
			path.join(manifestDir, 'dist'),
			`<!doctype html><html><head><meta charset="utf-8"></head><body><script>${code}</script></body></html>\n`,
		);
		const result = lintPublishUiBundle(
			{ name: 'com.example.app', tools: [{ ui: { resourceUri: 'ui://com.example.app/x.html' } }] },
			{ manifestDir },
		);
		expect(result.errors.some((error) => error.includes('per-user template placeholders'))).toBe(false);
	});

	it('still rejects a JWT-shaped token even when it only appears inside a <script> body', () => {
		const jwtShaped = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
		writeMinimalDist(
			path.join(manifestDir, 'dist'),
			`<!doctype html><html><head><meta charset="utf-8"></head><body><script>const t = "${jwtShaped}";</script></body></html>\n`,
		);
		const result = lintPublishUiBundle(
			{ name: 'com.example.app', tools: [{ ui: { resourceUri: 'ui://com.example.app/x.html' } }] },
			{ manifestDir },
		);
		expect(result.errors.some((error) => error.includes('per-user template placeholders'))).toBe(true);
	});
});

describe('lintPublishUiBundle — bundle-ui check dispatch', () => {
	it('surfaces a bundle-ui build failure (missing dist/index.html) as a lint error', () => {
		const result = lintPublishUiBundle(
			{ name: 'com.example.app', tools: [{ ui: { resourceUri: 'ui://com.example.app/x.html' } }] },
			{ manifestDir },
		);
		expect(result.errors.some((error) => error.startsWith('bundle-ui check failed'))).toBe(true);
	});

	it('resolves ui.distDir override instead of the default dist/', () => {
		writeMinimalDist(path.join(manifestDir, 'custom-ui-out'), inertShell);
		const result = lintPublishUiBundle(
			{ name: 'com.example.app', ui: { distDir: 'custom-ui-out' }, tools: [{ ui: { resourceUri: 'ui://com.example.app/x.html' } }] },
			{ manifestDir },
		);
		expect(result.errors).toEqual([]);
	});
});
