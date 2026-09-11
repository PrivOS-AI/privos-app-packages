/**
 * Resolves `--isolation auto` to the first level whose self-test passes
 * (never binary presence alone — red-team M3): tries `wrap`, then
 * `container`, then `prompt` (never `none` — explicit-only, session 9).
 */
import { runSelfTest, type SelfTestResult } from './self-test.js';
import type { AdapterSpec } from '../acp/adapter-table.js';

export type BaseIsolationLevel = 'wrap' | 'container' | 'prompt' | 'none';
export const ISOLATION_AUTO_ORDER: readonly ('wrap' | 'container' | 'prompt')[] = ['wrap', 'container', 'prompt'];

export interface ResolveIsolationParams {
	requested: 'auto' | 'wrap' | 'container' | 'prompt' | 'none';
	workspaceDir: string;
	spec: AdapterSpec;
	hubUrl: string;
	containerImage: string;
	verbose?: boolean;
}

export interface ResolvedIsolation {
	level: BaseIsolationLevel;
	/** The candidates that were actually self-tested (`--isolation auto` only; empty for an explicit choice, which is honoured unvalidated). */
	selfTests: SelfTestResult[];
}

export async function resolveIsolation(params: ResolveIsolationParams): Promise<ResolvedIsolation> {
	if (params.requested !== 'auto') {
		return { level: params.requested, selfTests: [] };
	}
	const selfTests: SelfTestResult[] = [];
	for (const level of ISOLATION_AUTO_ORDER) {
		if (level === 'prompt') return { level, selfTests }; // prompt has no OS sandbox to self-test; always the final fallback
		const result = await runSelfTest(level, params);
		selfTests.push(result);
		if (result.passed) return { level, selfTests };
	}
	return { level: 'prompt', selfTests };
}

export { runSelfTest, type SelfTestResult } from './self-test.js';
export { wrapCommand, type WrapCommandParams, type WrappedSpawn } from './wrap-command.js';
