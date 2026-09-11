import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpSession } from '../src/acp/acp-session.js';
import type { AdapterSpec } from '../src/acp/adapter-table.js';

// Regression: a missing adapter binary used to let the web-stream adapter over
// the dead child's stdio throw an uncaught AbortError that crashed the whole
// bridge. It must instead surface as a rejected turn naming the real cause, so
// TurnRunner can report `turn.done status:failed` and keep serving.
const spec: AdapterSpec = {
	id: 'claude',
	testedVersion: 'n/a',
	command: 'definitely-not-an-installed-acp-adapter',
	args: [],
	systemPromptTransport: 'meta',
	authHint: 'n/a',
	installHint: 'n/a',
	expectedLoadSession: true,
	steering: 'none',
	credentialFiles: [],
	realStateDir: () => '',
	writeNativeSandboxConfig: () => undefined,
};

describe('AcpSession when the adapter binary is missing', () => {
	let workspace: string;
	let session: AcpSession;
	afterEach(async () => {
		await session.dispose();
		rmSync(workspace, { recursive: true, force: true });
	});

	it('rejects the turn naming the failed adapter, without crashing the process', async () => {
		workspace = mkdtempSync(join(tmpdir(), 'agent-harness-missing-binary-'));
		session = new AcpSession(spec, { cwd: workspace, env: process.env, verbose: false, isolation: 'none', cancelGraceMs: 300 });
		await expect(
			session.runTurn({
				turnId: 't1',
				sessionKey: 'k',
				roomId: 'room-1',
				senderName: 'Alice',
				prompt: 'hi',
				promptFull: 'hi',
				resume: false,
				savedSessionId: undefined,
				policy: 'auto',
				idleTimeoutMs: 5_000,
				deadlineMs: Date.now() + 10_000,
				onChunk: () => undefined,
				onToolUse: () => undefined,
				onActivity: () => undefined,
			}),
		).rejects.toThrow(/failed to start/);
	});
});
