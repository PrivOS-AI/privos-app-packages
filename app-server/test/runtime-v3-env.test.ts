import { describe, expect, it } from 'vitest';

import { RuntimeModeError } from '../src/runtime-mode.js';
import {
	RUNTIME_V3_ALLOW_UNSIGNED_READINESS_ENV_KEY,
	RUNTIME_V3_SECURITY_MODE_ENV_KEY,
	RUNTIME_V3_TRUST_ENV_KEY,
	isRuntimeV3SecurityModeEnv,
	parseRuntimeV3Env,
} from '../src/runtime-v3-env.js';
import { RUNTIME_V3_PREACTIVATION_TRUST } from './fixtures/runtime-v3-dispatch-trust-vector.js';

describe('isRuntimeV3SecurityModeEnv', () => {
	it('is true only for the exact literal value', () => {
		expect(isRuntimeV3SecurityModeEnv({ [RUNTIME_V3_SECURITY_MODE_ENV_KEY]: 'runtime-v3' })).toBe(true);
		expect(isRuntimeV3SecurityModeEnv({ [RUNTIME_V3_SECURITY_MODE_ENV_KEY]: 'managed' })).toBe(false);
		expect(isRuntimeV3SecurityModeEnv({})).toBe(false);
	});
});

describe('parseRuntimeV3Env', () => {
	it('parses the real driver-emitted trust vector and the unsigned-readiness flag', () => {
		const env = {
			[RUNTIME_V3_TRUST_ENV_KEY]: JSON.stringify(RUNTIME_V3_PREACTIVATION_TRUST),
			[RUNTIME_V3_ALLOW_UNSIGNED_READINESS_ENV_KEY]: 'true',
		};
		const parsed = parseRuntimeV3Env(env);
		expect(parsed).toEqual({
			trust: RUNTIME_V3_PREACTIVATION_TRUST,
			allowUnsignedPreactivationReadiness: true,
		});
	});

	it('defaults allowUnsignedPreactivationReadiness to false for any non-"true" value', () => {
		for (const value of [undefined, '', 'false', 'TRUE', '1']) {
			const env: NodeJS.ProcessEnv = { [RUNTIME_V3_TRUST_ENV_KEY]: JSON.stringify(RUNTIME_V3_PREACTIVATION_TRUST) };
			if (value !== undefined) env[RUNTIME_V3_ALLOW_UNSIGNED_READINESS_ENV_KEY] = value;
			expect(parseRuntimeV3Env(env).allowUnsignedPreactivationReadiness).toBe(false);
		}
	});

	it('throws RuntimeModeError(RUNTIME_V3_TRUST_INVALID) when the trust env var is absent', () => {
		try {
			parseRuntimeV3Env({});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(RuntimeModeError);
			expect((error as RuntimeModeError).code).toBe('RUNTIME_V3_TRUST_INVALID');
		}
	});

	it('throws RuntimeModeError(RUNTIME_V3_TRUST_INVALID) on unparseable JSON', () => {
		expect(() => parseRuntimeV3Env({ [RUNTIME_V3_TRUST_ENV_KEY]: '{not-json' })).toThrow(RuntimeModeError);
	});

	it('throws RuntimeModeError(RUNTIME_V3_TRUST_INVALID) when a required affinity key is missing', () => {
		const { workspaceId: _workspaceId, ...incompleteAffinity } = RUNTIME_V3_PREACTIVATION_TRUST.affinity;
		const broken = { ...RUNTIME_V3_PREACTIVATION_TRUST, affinity: incompleteAffinity };
		try {
			parseRuntimeV3Env({ [RUNTIME_V3_TRUST_ENV_KEY]: JSON.stringify(broken) });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(RuntimeModeError);
			expect((error as RuntimeModeError).code).toBe('RUNTIME_V3_TRUST_INVALID');
		}
	});

	it('throws RuntimeModeError(RUNTIME_V3_TRUST_INVALID) when hubKid does not match the JWK thumbprint', () => {
		const broken = { ...RUNTIME_V3_PREACTIVATION_TRUST, hubKid: 'x'.repeat(43) };
		expect(() => parseRuntimeV3Env({ [RUNTIME_V3_TRUST_ENV_KEY]: JSON.stringify(broken) })).toThrow(RuntimeModeError);
	});
});
