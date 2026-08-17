/**
 * Readiness contract for `standalone-production` mode, matching the managed
 * workload's `/health` (process alive) + `/ready` JSON shape so operator
 * dashboards built against one mode work unmodified against the other.
 *
 * `/ready` is ok only when all of: the identity file loaded and validated,
 * the pinned trust configuration is structurally valid, the Relay connection
 * is currently authenticated, the local manifest lints clean, and the local
 * manifest's canonical digest still matches the digest pinned at pairing
 * (`MANIFEST_DRIFT` otherwise — the standalone analogue of the managed
 * image-label digest check).
 */
import { lintManifest } from '../manifest-tools.js';
import {
	loadStandaloneIdentity,
	StandaloneIdentityError,
	type LoadedStandaloneIdentity,
} from './standalone-identity.js';

export type StandaloneReadinessReason =
	| 'IDENTITY_NOT_LOADED'
	| 'RELAY_NOT_AUTHENTICATED'
	| 'MANIFEST_LINT_INVALID'
	| 'MANIFEST_DRIFT';

export type StandaloneReadinessResult = Readonly<{
	ok: boolean;
	status: number;
	body: Readonly<{
		ok: boolean;
		status: 'ready' | 'not_ready';
		mode: 'standalone-production';
		reason?: StandaloneReadinessReason;
		detail?: string;
		fingerprint?: string;
	}>;
}>;

export type StandaloneReadinessCheckOptions = Readonly<{
	/** Resolve current identity fresh on every check (rotation-safe). Defaults to `loadStandaloneIdentity`. */
	loadIdentity?: (filePath?: string) => LoadedStandaloneIdentity;
	filePath?: string;
	/** True only while the Relay WebSocket is open and past the authenticated handshake. */
	isRelayAuthenticated: () => boolean;
	/** The app's own published manifest object (parsed `privos-app.json`), recomputed fresh each check. */
	resolveManifest: () => unknown | Promise<unknown>;
}>;

/** Recomputes the local manifest's canonical digest and compares it to the digest pinned at pairing. */
export function checkManifestDigestDrift(
	manifest: unknown,
	pinnedManifestDigest: string,
): Readonly<{ drift: boolean; canonicalManifestHash: string; lintValid: boolean; lintErrors: readonly string[] }> {
	const lint = lintManifest(manifest);
	return Object.freeze({
		drift: lint.canonicalManifestHash !== pinnedManifestDigest,
		canonicalManifestHash: lint.canonicalManifestHash,
		lintValid: lint.valid,
		lintErrors: lint.errors,
	});
}

/** Builds a `ready.check` callback compatible with `HttpIngressAppOptions`. */
export function createStandaloneReadinessCheck(
	options: StandaloneReadinessCheckOptions,
): () => Promise<StandaloneReadinessResult> {
	const loadIdentity = options.loadIdentity ?? ((filePath?: string) => loadStandaloneIdentity({ filePath }));

	return async function check(): Promise<StandaloneReadinessResult> {
		let identity: LoadedStandaloneIdentity;
		try {
			identity = loadIdentity(options.filePath);
		} catch (error) {
			const detail = error instanceof StandaloneIdentityError ? error.message : 'Standalone identity is not loaded.';
			return notReady('IDENTITY_NOT_LOADED', detail);
		}

		if (!options.isRelayAuthenticated()) {
			return notReady('RELAY_NOT_AUTHENTICATED', 'The Relay WebSocket is not currently authenticated.', identity.fingerprint);
		}

		let manifest: unknown;
		try {
			manifest = await options.resolveManifest();
		} catch (error) {
			return notReady(
				'MANIFEST_LINT_INVALID',
				`Failed to resolve the local manifest: ${error instanceof Error ? error.message : String(error)}`,
				identity.fingerprint,
			);
		}
		const digestCheck = checkManifestDigestDrift(manifest, identity.trust.affinity.manifestDigest);
		if (!digestCheck.lintValid) {
			return notReady('MANIFEST_LINT_INVALID', digestCheck.lintErrors.join('; '), identity.fingerprint);
		}
		if (digestCheck.drift) {
			return notReady(
				'MANIFEST_DRIFT',
				`Local manifest digest ${digestCheck.canonicalManifestHash} does not match the digest pinned at pairing (${identity.trust.affinity.manifestDigest}).`,
				identity.fingerprint,
			);
		}

		return Object.freeze({
			ok: true,
			status: 200,
			body: Object.freeze({
				ok: true as const,
				status: 'ready' as const,
				mode: 'standalone-production' as const,
				fingerprint: identity.fingerprint,
			}),
		});
	};
}

function notReady(reason: StandaloneReadinessReason, detail: string, fingerprint?: string): StandaloneReadinessResult {
	return Object.freeze({
		ok: false,
		status: 503,
		body: Object.freeze({
			ok: false as const,
			status: 'not_ready' as const,
			mode: 'standalone-production' as const,
			reason,
			detail,
			...(fingerprint ? { fingerprint } : {}),
		}),
	});
}
