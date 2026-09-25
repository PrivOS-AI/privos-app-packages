import { describe, expect, it } from 'vitest';

import { getPlatformContext, publicUrlFor } from '../../src/context/platform-context.js';

describe('platform context', () => {
	it('reads the platform-injected origin and access mode', () => {
		expect(
			getPlatformContext({
				PRIVOS_PUBLIC_URL: 'https://my-app.apps.privos.link',
				PRIVOS_ACCESS_MODE: 'managed-runtime',
			} as NodeJS.ProcessEnv),
		).toEqual({ publicUrl: 'https://my-app.apps.privos.link', accessMode: 'managed-runtime' });
	});

	it('prefers PRIVOS_APP_PUBLIC_URL over the deprecated PRIVOS_PUBLIC_URL alias', () => {
		expect(
			getPlatformContext({
				PRIVOS_APP_PUBLIC_URL: 'https://new.apps.privos.link',
				PRIVOS_PUBLIC_URL: 'https://old.apps.privos.link',
			} as NodeJS.ProcessEnv),
		).toEqual({ publicUrl: 'https://new.apps.privos.link' });
	});

	it('falls back to the deprecated alias when only it is present', () => {
		expect(
			getPlatformContext({
				PRIVOS_PUBLIC_URL: 'https://old.apps.privos.link',
			} as NodeJS.ProcessEnv),
		).toEqual({ publicUrl: 'https://old.apps.privos.link' });
	});

	it('does not let an empty or malformed new var shadow a valid alias', () => {
		// Templated-but-unset injection during the rename transition.
		expect(
			getPlatformContext({
				PRIVOS_APP_PUBLIC_URL: '',
				PRIVOS_PUBLIC_URL: 'https://old.apps.privos.link',
			} as NodeJS.ProcessEnv),
		).toEqual({ publicUrl: 'https://old.apps.privos.link' });
		expect(
			getPlatformContext({
				PRIVOS_APP_PUBLIC_URL: 'http://insecure.example',
				PRIVOS_PUBLIC_URL: 'https://old.apps.privos.link',
			} as NodeJS.ProcessEnv),
		).toEqual({ publicUrl: 'https://old.apps.privos.link' });
	});

	it('is undefined-safe on a platform that injects nothing', () => {
		// An app built against this SDK still has to run on an older platform,
		// and on the publisher's own infrastructure.
		expect(getPlatformContext({} as NodeJS.ProcessEnv)).toEqual({});
		expect(publicUrlFor('/media/logo.png', {} as NodeJS.ProcessEnv)).toBeUndefined();
	});

	it('treats a malformed origin or mode as absent', () => {
		// Passing a broken origin through would produce broken callback URLs.
		expect(
			getPlatformContext({
				PRIVOS_PUBLIC_URL: 'http://insecure.example',
				PRIVOS_ACCESS_MODE: 'something-else',
			} as NodeJS.ProcessEnv),
		).toEqual({});
	});

	it('builds absolute URLs on the public origin', () => {
		const env = { PRIVOS_PUBLIC_URL: 'https://my-app.apps.privos.link' } as NodeJS.ProcessEnv;
		expect(publicUrlFor('/media/logo.png', env)).toBe('https://my-app.apps.privos.link/media/logo.png');
		expect(publicUrlFor('oauth/callback', env)).toBe('https://my-app.apps.privos.link/oauth/callback');
	});

	it('keeps a path from escaping the origin it was given', () => {
		const env = { PRIVOS_PUBLIC_URL: 'https://my-app.apps.privos.link/base' } as NodeJS.ProcessEnv;
		expect(publicUrlFor('callback', env)).toBe('https://my-app.apps.privos.link/base/callback');
	});
});
