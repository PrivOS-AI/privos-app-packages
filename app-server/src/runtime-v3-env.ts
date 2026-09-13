/**
 * Parses and validates the local-runtime driver's `runtime-v3` dispatch env
 * contract — the exact three variables `runtime-service.ts`'s
 * `dispatchTrustEnv` emits into the container:
 *
 *   - `PRIVOS_RUNTIME_SECURITY_MODE=runtime-v3`
 *   - `PRIVOS_RUNTIME_DISPATCH_TRUST_V3={hubKid,hubPublicJwk,affinity{…}}`
 *   - `PRIVOS_RUNTIME_ALLOW_UNSIGNED_PREACTIVATION_READINESS=true|false`
 *
 * This module only decides whether the env is present and well-formed enough
 * to hand to `resolveRuntimeMode`. The actual trust shape rules — required
 * affinity keys, `hubKid` equal to the JWK's own thumbprint — are the SDK's
 * existing `assertRuntimeDispatchTrustConfigurationV3`, reused unchanged
 * through `parseRuntimeDispatchTrustV3Json`. Nothing here re-derives them.
 */
import { RuntimeModeError } from './runtime-mode.js';
import { parseRuntimeDispatchTrustV3Json, type RuntimeDispatchTrustV3 } from './workload/dispatch-assertion.js';

export const RUNTIME_V3_SECURITY_MODE_ENV_KEY = 'PRIVOS_RUNTIME_SECURITY_MODE';
export const RUNTIME_V3_TRUST_ENV_KEY = 'PRIVOS_RUNTIME_DISPATCH_TRUST_V3';
export const RUNTIME_V3_ALLOW_UNSIGNED_READINESS_ENV_KEY = 'PRIVOS_RUNTIME_ALLOW_UNSIGNED_PREACTIVATION_READINESS';

export type RuntimeV3EnvConfig = Readonly<{
	trust: RuntimeDispatchTrustV3;
	allowUnsignedPreactivationReadiness: boolean;
}>;

/** True only when the driver has selected `runtime-v3` as the inbound dispatch mode. */
export function isRuntimeV3SecurityModeEnv(env: NodeJS.ProcessEnv): boolean {
	return env[RUNTIME_V3_SECURITY_MODE_ENV_KEY] === 'runtime-v3';
}

/**
 * Parses `PRIVOS_RUNTIME_DISPATCH_TRUST_V3` and the unsigned-readiness flag.
 * Throws `RuntimeModeError('RUNTIME_V3_TRUST_INVALID')` when the trust env var
 * is missing/unparseable, a required affinity key is missing, or `hubKid` does
 * not match the JWK's own thumbprint.
 */
export function parseRuntimeV3Env(env: NodeJS.ProcessEnv): RuntimeV3EnvConfig {
	const raw = env[RUNTIME_V3_TRUST_ENV_KEY];
	if (typeof raw !== 'string' || raw.trim() === '') {
		throw new RuntimeModeError(
			'RUNTIME_V3_TRUST_INVALID',
			`${RUNTIME_V3_SECURITY_MODE_ENV_KEY}=runtime-v3 requires ${RUNTIME_V3_TRUST_ENV_KEY} to carry the driver's dispatch trust JSON.`,
		);
	}
	let trust: RuntimeDispatchTrustV3;
	try {
		trust = parseRuntimeDispatchTrustV3Json(raw);
	} catch (error) {
		throw new RuntimeModeError(
			'RUNTIME_V3_TRUST_INVALID',
			`${RUNTIME_V3_TRUST_ENV_KEY} is not a valid runtime dispatch trust configuration: ${(error as Error).message}`,
		);
	}
	return Object.freeze({
		trust,
		allowUnsignedPreactivationReadiness: env[RUNTIME_V3_ALLOW_UNSIGNED_READINESS_ENV_KEY] === 'true',
	});
}
