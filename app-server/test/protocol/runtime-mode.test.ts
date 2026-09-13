import { describe, expect, it } from 'vitest';

import { resolveRuntimeMode, RuntimeModeError } from '../../src/runtime-mode.js';
import { RUNTIME_V3_PREACTIVATION_TRUST } from '../fixtures/runtime-v3-dispatch-trust-vector.js';

const WORKLOAD_SOCKET_PATH = '/run/privos/identity.sock';
const IDENTITY_FILE_PATH = '/app/privos-standalone-identity.json';
const RUNTIME_V3_ENV = {
	PRIVOS_RUNTIME_SECURITY_MODE: 'runtime-v3',
	PRIVOS_RUNTIME_DISPATCH_TRUST_V3: JSON.stringify(RUNTIME_V3_PREACTIVATION_TRUST),
	PRIVOS_RUNTIME_ALLOW_UNSIGNED_PREACTIVATION_READINESS: 'true',
};

describe('resolveRuntimeMode', () => {
	it('resolves managed when only the workload socket is present', () => {
		const result = resolveRuntimeMode({
			env: { NODE_ENV: 'production' },
			workloadSocketPath: WORKLOAD_SOCKET_PATH,
			standaloneIdentityFilePath: IDENTITY_FILE_PATH,
			workloadSocketExists: (path) => path === WORKLOAD_SOCKET_PATH,
			standaloneIdentityExists: () => false,
		});
		expect(result.mode).toBe('managed');
	});

	it('resolves standalone-production when only the identity file is present, even under NODE_ENV=production', () => {
		const result = resolveRuntimeMode({
			env: { NODE_ENV: 'production' },
			workloadSocketPath: WORKLOAD_SOCKET_PATH,
			standaloneIdentityFilePath: IDENTITY_FILE_PATH,
			workloadSocketExists: () => false,
			standaloneIdentityExists: (path) => path === IDENTITY_FILE_PATH,
		});
		expect(result.mode).toBe('standalone-production');
	});

	it('resolves development when neither is present and NODE_ENV is not production', () => {
		const result = resolveRuntimeMode({
			env: { NODE_ENV: 'test' },
			workloadSocketPath: WORKLOAD_SOCKET_PATH,
			standaloneIdentityFilePath: IDENTITY_FILE_PATH,
			workloadSocketExists: () => false,
			standaloneIdentityExists: () => false,
		});
		expect(result.mode).toBe('development');
	});

	it('resolves development when NODE_ENV is unset', () => {
		const result = resolveRuntimeMode({
			env: {},
			workloadSocketExists: () => false,
			standaloneIdentityExists: () => false,
		});
		expect(result.mode).toBe('development');
	});

	it('refuses NODE_ENV=production with neither managed nor standalone identity present (only dev flags)', () => {
		expect(() =>
			resolveRuntimeMode({
				env: { NODE_ENV: 'production' },
				workloadSocketPath: WORKLOAD_SOCKET_PATH,
				standaloneIdentityFilePath: IDENTITY_FILE_PATH,
				workloadSocketExists: () => false,
				standaloneIdentityExists: () => false,
			}),
		).toThrow(RuntimeModeError);
		try {
			resolveRuntimeMode({
				env: { NODE_ENV: 'production' },
				workloadSocketExists: () => false,
				standaloneIdentityExists: () => false,
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(RuntimeModeError);
			expect((error as RuntimeModeError).code).toBe('PRODUCTION_WITHOUT_IDENTITY');
			expect((error as RuntimeModeError).message).toMatch(/NODE_ENV=production/);
		}
	});

	it('refuses ambiguity when both a workload socket and a standalone identity file are present — never a silent pick', () => {
		try {
			resolveRuntimeMode({
				env: { NODE_ENV: 'production' },
				workloadSocketPath: WORKLOAD_SOCKET_PATH,
				standaloneIdentityFilePath: IDENTITY_FILE_PATH,
				workloadSocketExists: () => true,
				standaloneIdentityExists: () => true,
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(RuntimeModeError);
			expect((error as RuntimeModeError).code).toBe('AMBIGUOUS_RUNTIME_IDENTITY');
		}
	});

	it('ambiguity refusal takes precedence over any NODE_ENV value', () => {
		expect(() =>
			resolveRuntimeMode({
				env: { NODE_ENV: 'development' },
				workloadSocketExists: () => true,
				standaloneIdentityExists: () => true,
			}),
		).toThrow(RuntimeModeError);
	});

	it('managed takes precedence over standalone-production when both would independently apply (guarded by ambiguity, never reached in practice)', () => {
		// Precedence is documented as managed > standalone-production > development,
		// but the two identity sources being simultaneously present is itself an
		// error (see ambiguity test) — this only exercises the resolver's env
		// plumbing (default paths) when explicit overrides are omitted.
		const result = resolveRuntimeMode({
			env: { NODE_ENV: 'production', PRIVOS_WORKLOAD_SOCKET: WORKLOAD_SOCKET_PATH },
			workloadSocketExists: (path) => path === WORKLOAD_SOCKET_PATH,
			standaloneIdentityExists: () => false,
		});
		expect(result.mode).toBe('managed');
		expect(result.workloadSocketPath).toBe(WORKLOAD_SOCKET_PATH);
	});
});

describe('resolveRuntimeMode — runtime-v3 precedence', () => {
	it('the driver env alone resolves runtime-v3 with the parsed trust attached', () => {
		const result = resolveRuntimeMode({
			env: RUNTIME_V3_ENV,
			workloadSocketPath: WORKLOAD_SOCKET_PATH,
			standaloneIdentityFilePath: IDENTITY_FILE_PATH,
			workloadSocketExists: () => false,
			standaloneIdentityExists: () => false,
		});
		expect(result.mode).toBe('runtime-v3');
		expect(result.runtimeV3).toEqual({
			trust: RUNTIME_V3_PREACTIVATION_TRUST,
			allowUnsignedPreactivationReadiness: true,
		});
	});

	it('the driver env plus a MANAGED workload socket still resolves runtime-v3 (socket is the outbound identity)', () => {
		const result = resolveRuntimeMode({
			env: RUNTIME_V3_ENV,
			workloadSocketPath: WORKLOAD_SOCKET_PATH,
			standaloneIdentityFilePath: IDENTITY_FILE_PATH,
			workloadSocketExists: (path) => path === WORKLOAD_SOCKET_PATH,
			standaloneIdentityExists: () => false,
		});
		expect(result.mode).toBe('runtime-v3');
		expect(result.workloadSocketPath).toBe(WORKLOAD_SOCKET_PATH);
	});

	it('the driver env plus a standalone identity file is ambiguous — never a silent pick', () => {
		try {
			resolveRuntimeMode({
				env: RUNTIME_V3_ENV,
				workloadSocketPath: WORKLOAD_SOCKET_PATH,
				standaloneIdentityFilePath: IDENTITY_FILE_PATH,
				workloadSocketExists: () => false,
				standaloneIdentityExists: (path) => path === IDENTITY_FILE_PATH,
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(RuntimeModeError);
			expect((error as RuntimeModeError).code).toBe('AMBIGUOUS_RUNTIME_IDENTITY');
		}
	});

	it('the driver env with an invalid trust value fails closed with RUNTIME_V3_TRUST_INVALID', () => {
		try {
			resolveRuntimeMode({
				env: { ...RUNTIME_V3_ENV, PRIVOS_RUNTIME_DISPATCH_TRUST_V3: '{not-json' },
				workloadSocketExists: () => false,
				standaloneIdentityExists: () => false,
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(RuntimeModeError);
			expect((error as RuntimeModeError).code).toBe('RUNTIME_V3_TRUST_INVALID');
		}
	});

	it('absent the driver env, resolution is exactly the pre-existing behavior (managed)', () => {
		const result = resolveRuntimeMode({
			env: { NODE_ENV: 'production' },
			workloadSocketPath: WORKLOAD_SOCKET_PATH,
			standaloneIdentityFilePath: IDENTITY_FILE_PATH,
			workloadSocketExists: (path) => path === WORKLOAD_SOCKET_PATH,
			standaloneIdentityExists: () => false,
		});
		expect(result.mode).toBe('managed');
		expect(result.runtimeV3).toBeUndefined();
	});
});
