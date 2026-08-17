import { describe, expect, it } from 'vitest';

import { resolveRuntimeMode, RuntimeModeError } from '../../src/runtime-mode.js';

const WORKLOAD_SOCKET_PATH = '/run/privos/identity.sock';
const IDENTITY_FILE_PATH = '/app/privos-standalone-identity.json';

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
