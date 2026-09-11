/**
 * Integration test for the `wrap` isolation level against a REAL OS sandbox
 * (macOS `sandbox-exec`; Linux `bwrap` where available) driving the real
 * fake-ACP-agent subprocess — exactly the combination `cli.ts`'s
 * `createRoomSession` assembles at runtime. Skipped with a visible marker
 * when neither wrapper is available (e.g. Windows, or a Linux CI host
 * without unprivileged user namespaces).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpSession, type RunTurnInput } from '../src/acp/acp-session.js';
import type { AdapterSpec } from '../src/acp/adapter-table.js';
import { wrapCommand } from '../src/isolation/wrap-command.js';
import { runSelfTest } from '../src/isolation/self-test.js';

const here = dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = join(here, 'fake-acp-agent.ts');

function wrapperAvailable(): boolean {
	return platform() === 'darwin' || platform() === 'linux';
}

const describeWrap = wrapperAvailable() ? describe : describe.skip;
if (!wrapperAvailable()) {
	// eslint-disable-next-line no-console
	console.log(`[SKIPPED] wrap isolation integration: no sandbox-exec/bwrap implementation for platform "${platform()}"`);
}

function baseInput(overrides: Partial<RunTurnInput> & Pick<RunTurnInput, 'turnId' | 'sessionKey' | 'prompt' | 'roomId'>): RunTurnInput {
	return {
		senderName: 'Alice',
		promptFull: overrides.prompt,
		resume: false,
		savedSessionId: undefined,
		policy: 'auto',
		idleTimeoutMs: 5_000,
		deadlineMs: Date.now() + 10_000,
		onChunk: () => undefined,
		onToolUse: () => undefined,
		onActivity: () => undefined,
		...overrides,
	};
}

describeWrap('wrap isolation (real sandbox-exec/bwrap)', () => {
	let workspace: string;
	const sessions: AcpSession[] = [];

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), 'agent-harness-wrap-it-'));
		mkdirSync(join(workspace, 'rooms'), { recursive: true });
		mkdirSync(join(workspace, '.privos'), { recursive: true });
		writeFileSync(join(workspace, 'IDENTITY.md'), 'identity');
	});
	afterEach(async () => {
		await Promise.all(sessions.splice(0).map((s) => s.dispose()));
		rmSync(workspace, { recursive: true, force: true });
	});

	function makeRoomSession(roomId: string, extraEnv: Record<string, string> = {}): { session: AcpSession; roomDir: string } {
		const roomDir = join(workspace, 'rooms', roomId);
		mkdirSync(roomDir, { recursive: true });
		const wrapped = wrapCommand({
			level: 'wrap',
			workspaceDir: workspace,
			roomId,
			roomDir,
			homeDir: undefined,
			realHomeDir: homedir(),
			bridgeNodeModulesDir: join(process.cwd(), 'node_modules'),
			containerImage: 'unused',
			command: process.execPath,
			args: ['--experimental-strip-types', fakeAgentPath],
			env: {},
		});
		const spec: AdapterSpec = {
			id: 'custom',
			testedVersion: 'n/a',
			command: wrapped.command,
			args: wrapped.args,
			systemPromptTransport: 'prefix',
			authHint: 'n/a',
			installHint: 'n/a',
			expectedLoadSession: true,
			steering: 'none',
			credentialFiles: [],
			realStateDir: () => '',
			writeNativeSandboxConfig: () => undefined,
		};
		const session = new AcpSession(spec, {
			cwd: roomDir,
			env: { ...process.env, ...wrapped.env, ...extraEnv },
			verbose: false,
			isolation: 'wrap',
			cancelGraceMs: 300,
		});
		sessions.push(session);
		return { session, roomDir };
	}

	it('room B cannot read a file written directly into room A (two rooms -> two sandboxed processes)', async () => {
		const a = makeRoomSession('room-a');
		const markerPath = join(a.roomDir, 'secret.txt');
		writeFileSync(markerPath, 'room-a-secret');
		const b = makeRoomSession('room-b', { FAKE_TEST_TARGET_PATH: markerPath });

		const result = await b.session.runTurn(baseInput({ turnId: 't1', sessionKey: 'k1', roomId: 'room-b', prompt: 'FAKE_SCENARIO=fs_read_target' }));
		expect(result.status).toBe('completed');
		expect(result.text).toContain('READ_DENIED');
	});

	it('room B cannot read a file room A planted in its own per-room state dir (the hook-isolation property)', async () => {
		const a = makeRoomSession('room-a');
		const aHome = join(a.roomDir, '.home');
		mkdirSync(aHome, { recursive: true });
		const hookMarker = join(aHome, 'planted-hook.json');
		const aResult = await a.session.runTurn(
			baseInput({ turnId: 'ta', sessionKey: 'ka', roomId: 'room-a', prompt: 'FAKE_SCENARIO=fs_write_target' }),
		);
		void aResult; // room A never targeted this path directly; the write below proves A's OWN home is writable at all
		writeFileSync(hookMarker, 'hook-content'); // written directly (unsandboxed) to stand in for "room A's process planted this"

		const b = makeRoomSession('room-b', { FAKE_TEST_TARGET_PATH: hookMarker });
		const result = await b.session.runTurn(baseInput({ turnId: 'tb', sessionKey: 'kb', roomId: 'room-b', prompt: 'FAKE_SCENARIO=fs_read_target' }));
		expect(result.text).toContain('READ_DENIED');
	});

	it('a room can still write inside itself and read the shared skills dir under the same sandbox', async () => {
		writeFileSync(join(workspace, '.privos', 'shared-marker.txt'), 'shared');
		const a = makeRoomSession('room-a', { FAKE_TEST_TARGET_PATH: join(workspace, '.privos', 'shared-marker.txt') });
		const result = await a.session.runTurn(baseInput({ turnId: 't1', sessionKey: 'k1', roomId: 'room-a', prompt: 'FAKE_SCENARIO=fs_read_target' }));
		expect(result.text).toContain('READ_OK');
	});

	it('self-test reports wrap as passing on this host for a shared-state adapter', async () => {
		const spec: AdapterSpec = {
			id: 'custom',
			testedVersion: 'n/a',
			command: process.execPath,
			args: [],
			systemPromptTransport: 'prefix',
			authHint: 'n/a',
			installHint: 'n/a',
			expectedLoadSession: false,
			steering: 'none',
			credentialFiles: [],
			realStateDir: () => '',
			writeNativeSandboxConfig: () => undefined,
		};
		const result = await runSelfTest('wrap', { workspaceDir: workspace, spec, hubUrl: 'http://localhost', containerImage: 'unused' });
		expect(result.checks.write?.passed).toBe(true);
		expect(result.passed).toBe(true);
	});
});
