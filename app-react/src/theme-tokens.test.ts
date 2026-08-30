/**
 * Verifies the module-scope HOST_CONTEXT_CHANGED listener in PrivosAppProvider
 * applies the host's theme tokens to this app document's root, since the app
 * runs in its own iframe document and cannot rely on the hub's stylesheet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('theme token application on HOST_CONTEXT_CHANGED', () => {
	beforeEach(() => {
		// Reset root style/theme between tests; jsdom keeps one document per file.
		document.documentElement.removeAttribute('style');
		delete document.documentElement.dataset.theme;
	});

	afterEach(() => {
		document.documentElement.removeAttribute('style');
		delete document.documentElement.dataset.theme;
	});

	const postHostContextChanged = (params: Record<string, unknown>) => {
		window.dispatchEvent(
			new MessageEvent('message', {
				data: { jsonrpc: '2.0', method: 'HOST_CONTEXT_CHANGED', params },
				source: window.parent,
			}),
		);
	};

	it('sets each --base-* token as a CSS custom property on document root', async () => {
		// Importing after the listeners in this describe block ensures the
		// module-scope `window.addEventListener('message', ...)` in
		// PrivosAppProvider.tsx is registered before we dispatch events.
		await import('./PrivosAppProvider');

		postHostContextChanged({
			theme: 'dark',
			themeTokens: {
				'--base-primary': '#6c5ce7',
				'--base-bg-main': '#101014',
				'--base-radius-md': '8px',
				'--base-font-family': 'Inter, sans-serif',
			},
		});

		const root = document.documentElement;
		expect(root.style.getPropertyValue('--base-primary')).toBe('#6c5ce7');
		expect(root.style.getPropertyValue('--base-bg-main')).toBe('#101014');
		expect(root.style.getPropertyValue('--base-radius-md')).toBe('8px');
		expect(root.style.getPropertyValue('--base-font-family')).toBe('Inter, sans-serif');
	});

	it('sets data-theme to the pushed mode', async () => {
		await import('./PrivosAppProvider');

		postHostContextChanged({ theme: 'dark', themeTokens: { '--base-primary': '#000' } });

		expect(document.documentElement.dataset.theme).toBe('dark');
	});

	it('re-applies on a subsequent HOST_CONTEXT_CHANGED (e.g. a theme save)', async () => {
		await import('./PrivosAppProvider');

		postHostContextChanged({ theme: 'light', themeTokens: { '--base-primary': '#aaa' } });
		expect(document.documentElement.style.getPropertyValue('--base-primary')).toBe('#aaa');

		postHostContextChanged({ theme: 'light', themeTokens: { '--base-primary': '#bbb' } });
		expect(document.documentElement.style.getPropertyValue('--base-primary')).toBe('#bbb');
	});

	it('ignores a HOST_CONTEXT_CHANGED with no themeTokens without throwing', async () => {
		await import('./PrivosAppProvider');

		expect(() => postHostContextChanged({ theme: 'light' })).not.toThrow();
	});
});
