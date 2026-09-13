/**
 * Resolves exactly one of the four supported runtime modes so an app never
 * has to hand-roll the decision (or silently default into the wrong one):
 *
 * - `managed`   — a workload identity socket is present (current production
 *                 cluster-routed path).
 * - `runtime-v3` — the local-runtime driver's env selects it
 *                 (`PRIVOS_RUNTIME_SECURITY_MODE=runtime-v3` +
 *                 `PRIVOS_RUNTIME_DISPATCH_TRUST_V3`); inbound dispatch is the
 *                 Hub-signed runtime-v3 assertion (+ the unsigned
 *                 pre-activation readiness triple when the driver allows it),
 *                 outbound identity is the MANAGED broker socket when present.
 * - `standalone-production` — a paired standalone identity file is present
 *                 (phase 3); Relay transport with mandatory assertion
 *                 verification, `NODE_ENV=production` allowed.
 * - `development` — none of the above is present; only permitted when
 *                 `NODE_ENV` is not `production` (the current, unchanged
 *                 legacy behavior).
 *
 * Precedence: the driver env (`runtime-v3`) is checked first — a standalone
 * identity file present alongside it is an `AMBIGUOUS_RUNTIME_IDENTITY`
 * configuration error, but the MANAGED workload socket may coexist (it is
 * runtime-v3's outbound identity, not a competing inbound mode). Absent the
 * driver env, precedence is unchanged: managed > standalone-production >
 * development, and a workload socket AND a standalone identity file both
 * present is likewise a configuration error, never a silent pick — running
 * both at once means either stale leftover state from a prior deployment
 * mode, or a misconfigured host, and guessing which one the operator meant
 * would be unsafe.
 */
import fsSync from 'node:fs';

import { DEFAULT_WORKLOAD_SOCKET } from './workload/workload-identity.js';
import { DEFAULT_STANDALONE_IDENTITY_FILE, standaloneIdentityFileExists } from './relay/standalone-identity.js';
import { isRuntimeV3SecurityModeEnv, parseRuntimeV3Env, type RuntimeV3EnvConfig } from './runtime-v3-env.js';

export type RuntimeMode = 'managed' | 'runtime-v3' | 'standalone-production' | 'development';

export type RuntimeModeResolution = Readonly<{
	mode: RuntimeMode;
	reason: string;
	workloadSocketPath: string;
	standaloneIdentityFilePath: string;
	/** Present only when `mode === 'runtime-v3'`: the driver's parsed dispatch trust + unsigned-readiness posture. */
	runtimeV3?: RuntimeV3EnvConfig;
}>;

export type RuntimeModeErrorCode =
	| 'AMBIGUOUS_RUNTIME_IDENTITY'
	| 'PRODUCTION_WITHOUT_IDENTITY'
	| 'TRANSPORT_OVERRIDE_NOT_ALLOWED'
	| 'RUNTIME_V3_TRUST_INVALID';

export class RuntimeModeError extends Error {
	constructor(
		public readonly code: RuntimeModeErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'RuntimeModeError';
	}
}

export type ResolveRuntimeModeOptions = Readonly<{
	env?: NodeJS.ProcessEnv;
	/** Override for tests; defaults to `PRIVOS_WORKLOAD_SOCKET` / the SDK default. */
	workloadSocketPath?: string;
	/** Override for tests; defaults to `PRIVOS_STANDALONE_IDENTITY_FILE` / the SDK default. */
	standaloneIdentityFilePath?: string;
	/** Injectable presence check for the workload socket; defaults to `fs.existsSync`. */
	workloadSocketExists?: (path: string) => boolean;
	/** Injectable presence check for the standalone identity file; defaults to the real file check. */
	standaloneIdentityExists?: (path: string) => boolean;
}>;

export function resolveRuntimeMode(options: ResolveRuntimeModeOptions = {}): RuntimeModeResolution {
	const env = options.env ?? process.env;
	const workloadSocketPath = options.workloadSocketPath ?? env.PRIVOS_WORKLOAD_SOCKET ?? DEFAULT_WORKLOAD_SOCKET;
	const standaloneIdentityFilePath =
		options.standaloneIdentityFilePath ?? env.PRIVOS_STANDALONE_IDENTITY_FILE ?? DEFAULT_STANDALONE_IDENTITY_FILE;
	const workloadSocketExists = options.workloadSocketExists ?? ((path: string) => fsSync.existsSync(path));
	const standaloneIdentityExists =
		options.standaloneIdentityExists ?? ((path: string) => standaloneIdentityFileExists({ filePath: path }));

	const managedPresent = workloadSocketExists(workloadSocketPath);
	const standalonePresent = standaloneIdentityExists(standaloneIdentityFilePath);

	if (isRuntimeV3SecurityModeEnv(env)) {
		if (standalonePresent) {
			throw new RuntimeModeError(
				'AMBIGUOUS_RUNTIME_IDENTITY',
				`Both PRIVOS_RUNTIME_SECURITY_MODE=runtime-v3 and a standalone identity file (${standaloneIdentityFilePath}) ` +
					'are present. Refusing to silently pick a runtime mode — remove whichever one does not apply to this ' +
					'deployment (stale leftover state from a prior mode is the usual cause).',
			);
		}
		const runtimeV3 = parseRuntimeV3Env(env);
		return Object.freeze({
			mode: 'runtime-v3',
			reason: managedPresent
				? `PRIVOS_RUNTIME_SECURITY_MODE=runtime-v3, with a workload identity socket present at ${workloadSocketPath} for outbound Hub calls`
				: 'PRIVOS_RUNTIME_SECURITY_MODE=runtime-v3',
			workloadSocketPath,
			standaloneIdentityFilePath,
			runtimeV3,
		});
	}

	if (managedPresent && standalonePresent) {
		throw new RuntimeModeError(
			'AMBIGUOUS_RUNTIME_IDENTITY',
			`Both a managed workload identity socket (${workloadSocketPath}) and a standalone identity file ` +
				`(${standaloneIdentityFilePath}) are present. Refusing to silently pick a runtime mode — remove ` +
				'whichever one does not apply to this deployment (stale leftover state from a prior mode is the usual cause).',
		);
	}

	if (managedPresent) {
		return Object.freeze({
			mode: 'managed',
			reason: `workload identity socket present at ${workloadSocketPath}`,
			workloadSocketPath,
			standaloneIdentityFilePath,
		});
	}

	if (standalonePresent) {
		return Object.freeze({
			mode: 'standalone-production',
			reason: `standalone identity file present at ${standaloneIdentityFilePath}`,
			workloadSocketPath,
			standaloneIdentityFilePath,
		});
	}

	if ((env.NODE_ENV ?? '').trim() === 'production') {
		throw new RuntimeModeError(
			'PRODUCTION_WITHOUT_IDENTITY',
			'NODE_ENV=production requires either a managed workload identity socket ' +
				`(${workloadSocketPath}) or a paired standalone identity file (${standaloneIdentityFilePath}). ` +
				'Development mode (relaxed verification) is never permitted in production — pair the app first ' +
				'with pairOverWebSocket, or deploy it behind the managed workload broker.',
		);
	}

	return Object.freeze({
		mode: 'development',
		reason: 'no managed workload socket or standalone identity file present, and NODE_ENV is not production',
		workloadSocketPath,
		standaloneIdentityFilePath,
	});
}
