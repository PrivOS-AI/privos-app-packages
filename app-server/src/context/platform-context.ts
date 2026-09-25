/**
 * How the platform tells an app about itself.
 *
 * A PrivOS-managed runtime receives two variables the platform owns. The
 * `PRIVOS_` prefix is reserved end to end — the Portal refuses a manifest that
 * declares it, the Hub refuses to send it, and the Cluster refuses a grant that
 * carries it — so a value read here can only have come from the platform.
 */

export type AppAccessMode = 'managed-runtime' | 'publisher-hosted';

export interface PlatformContext {
	/**
	 * This app's own public origin, e.g. `https://my-app.apps.privos.link`.
	 *
	 * This is NOT where tool calls and interface requests arrive: those ride the
	 * signed broker dispatch on `/mcp`, and reaching the app any other way is
	 * refused. Use the public origin for what genuinely has to be reachable from
	 * outside — public static media, webhook callbacks, OAuth redirect URIs.
	 *
	 * `undefined` when the app runs somewhere that does not allocate one, or on
	 * a platform release that predates the variable.
	 */
	publicUrl?: string;
	/**
	 * `managed-runtime` when PrivOS operates this container behind the broker,
	 * `publisher-hosted` when the publisher runs the endpoint themselves.
	 * `undefined` on a platform release that predates the variable.
	 */
	accessMode?: AppAccessMode;
}

const isAccessMode = (value: string | undefined): value is AppAccessMode =>
	value === 'managed-runtime' || value === 'publisher-hosted';

/**
 * Read the platform-injected context. Undefined-safe by design: an app built
 * against this SDK must still run on an older platform, and on a publisher's
 * own infrastructure where nothing is injected at all.
 */
export function getPlatformContext(env: NodeJS.ProcessEnv = process.env): PlatformContext {
	// `PRIVOS_APP_PUBLIC_URL` is the app's own origin; `PRIVOS_PUBLIC_URL` is the
	// deprecated alias the platform still injects during the rename transition.
	// Prefer the new name, but a malformed value is treated as absent — an empty
	// or non-https new var must not shadow a valid alias, which is exactly the
	// mixed-injection window this fallback exists for.
	const publicUrl = [env.PRIVOS_APP_PUBLIC_URL, env.PRIVOS_PUBLIC_URL].find(
		(value): value is string => typeof value === 'string' && value.startsWith('https://'),
	);
	const accessMode = env.PRIVOS_ACCESS_MODE;
	return {
		...(publicUrl ? { publicUrl } : {}),
		...(isAccessMode(accessMode) ? { accessMode } : {}),
	};
}

/**
 * Absolute URL for a path on this app's public origin, or `undefined` when no
 * public origin was injected. Prefer this over string concatenation so a
 * missing origin is a visible `undefined` rather than a relative URL that
 * silently resolves against the wrong host.
 */
export function publicUrlFor(path: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const { publicUrl } = getPlatformContext(env);
	if (!publicUrl) return undefined;
	return new URL(path, publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`).toString();
}
