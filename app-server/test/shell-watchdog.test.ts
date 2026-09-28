import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import { MCP_UI_SHELL_WATCHDOG_SCRIPT } from '../src/ui/shell-watchdog.js';

/**
 * Runs the inline watchdog against a minimal fake DOM. Returns the root, the
 * messages posted to the host, and triggers for the timeout and an asset error.
 */
function boot(opts: { rendered: boolean; bootedFlag?: boolean }) {
	const root = { childElementCount: opts.rendered ? 1 : 0, innerHTML: opts.rendered ? '<div>app</div>' : '' };
	const posted: unknown[] = [];
	let timeout: (() => void) | undefined;
	let onError: ((event: unknown) => void) | undefined;
	const window: Record<string, unknown> = {
		__privosUiBooted: opts.bootedFlag,
		addEventListener: (_type: string, listener: (event: unknown) => void) => { onError = listener; },
	};
	vm.runInNewContext(MCP_UI_SHELL_WATCHDOG_SCRIPT, {
		window,
		document: { getElementById: () => root, body: root },
		parent: { postMessage: (message: unknown) => posted.push(message) },
		setTimeout: (fn: () => void) => { timeout = fn; },
	});
	return { root, posted, window, fireTimeout: () => timeout?.(), fireAssetError: () => onError?.({ target: { tagName: 'SCRIPT' } }) };
}

describe('shell boot watchdog', () => {
	it('shows the retry panel when nothing rendered within the timeout', () => {
		const run = boot({ rendered: false });
		run.fireTimeout();
		expect(run.root.innerHTML).toContain('App assets unavailable');
		expect(run.posted).toEqual([{ method: 'ui/asset-load-failed' }]);
	});

	// Privos CRM (2026-09-28): the app rendered but never set the flag, and the
	// watchdog replaced its live UI 10 s later — every time the tab remounted.
	it('never wipes an app that already rendered but did not set the boot flag', () => {
		const run = boot({ rendered: true });
		run.fireTimeout();
		run.fireAssetError();
		expect(run.root.innerHTML).toBe('<div>app</div>');
		expect(run.window.__privosUiBooted).toBe(true);
		expect(run.posted).toEqual([{ method: 'ui/boot-flag-missing' }]);
	});

	it('stays silent when the app set the boot flag', () => {
		const run = boot({ rendered: true, bootedFlag: true });
		run.fireTimeout();
		expect(run.root.innerHTML).toBe('<div>app</div>');
		expect(run.posted).toEqual([]);
	});

	it('still fails fast on an asset error before anything rendered', () => {
		const run = boot({ rendered: false });
		run.fireAssetError();
		expect(run.root.innerHTML).toContain('App assets unavailable');
	});
});
