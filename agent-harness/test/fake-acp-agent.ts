#!/usr/bin/env node
/**
 * Minimal stdio ACP agent used only by tests. Controlled by magic markers
 * inside the prompt text it receives (so the real `<privos_turn>` framing and
 * preamble around it never interferes with scenario selection):
 *
 * - `FAKE_SCENARIO=echo` (or no marker at all): streams two text chunks, one
 *   `tool_call` + `tool_call_update`, then `end_turn`.
 * - `FAKE_SCENARIO=cancel_cooperative`: streams one chunk, then waits for
 *   `session/cancel` and answers with `stopReason: 'cancelled'`.
 * - `FAKE_SCENARIO=hang`: never resolves `session/prompt` and ignores cancel —
 *   exercises the bridge's 30s-then-SIGKILL path.
 * - `FAKE_SCENARIO=permission`: issues two `session/request_permission`
 *   requests (kinds `read` and `execute`, option ids random and
 *   kind-prefixed only for this fixture's own bookkeeping — the bridge under
 *   test must still pick by `.kind`, never by parsing the id) and reports the
 *   chosen option kind for each back as the final message text.
 * - `FAKE_SCENARIO=fs_read_target` / `fs_write_target`: attempts a real
 *   filesystem read/write of `process.env.FAKE_TEST_TARGET_PATH` and reports
 *   `*_OK`/`*_DENIED` — isolation integration tests only; the outcome is
 *   decided by whatever OS sandbox wraps THIS process, not by the fixture.
 *
 * `session/load` on a session id this process minted replays one bogus
 * `agent_message_chunk` update before resolving, to exercise replay gating.
 *
 * Phase-04 mid-turn steer: `FAKE_STEERING_SUPPORTED=1` advertises
 * `_meta.steering.supported` in the `initialize` response. `_session/steering`
 * requests are answered per `FAKE_STEERING_RESULT`:
 *   - `injected` (default) -> `{ outcome: 'injected' }`
 *   - `promptRequired` -> `{ outcome: 'promptRequired' }`
 *   - `empty` -> `{}` (a bare JSON-RPC success with no `outcome` field)
 *   - `startedNewTurn` -> `{ outcome: 'startedNewTurn' }`
 *   - `hang` -> never resolves (exercises the bridge's own cancel-abort path)
 * A `FAKE_SCENARIO=report_steering_count` prompt reports how many
 * `_session/steering` requests this process has received so far, as its
 * final message text -- the only way a test can observe "nothing was
 * written to the wire" for an unsupported/gated adapter without adding a
 * test-only escape hatch to `AcpSession` itself.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream, type AgentContext, type ContentBlock, type Stream } from '@agentclientprotocol/sdk';

const knownSessions = new Set<string>();
const pendingCancels = new Map<string, () => void>();
let steeringCallCount = 0;

function textOf(blocks: ContentBlock[]): string {
	return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

async function sendChunk(client: AgentContext, sessionId: string, text: string): Promise<void> {
	await client.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
}

const app = agent({ name: 'fake-acp-agent' });

app.onRequest('initialize', async () => ({
	protocolVersion: 1,
	agentCapabilities: { loadSession: true },
	agentInfo: { name: 'fake-acp-agent', version: '0.0.0-test' },
	...(process.env.FAKE_STEERING_SUPPORTED === '1' && { _meta: { steering: { supported: true } } }),
}));

app.onRequest(
	'_session/steering',
	(raw: unknown) => raw as { sessionId: string; prompt: ContentBlock[] },
	async () => {
		steeringCallCount++;
		const scenario = process.env.FAKE_STEERING_RESULT ?? 'injected';
		if (scenario === 'hang') return new Promise(() => undefined);
		if (scenario === 'promptRequired') return { outcome: 'promptRequired' };
		if (scenario === 'empty') return {};
		if (scenario === 'startedNewTurn') return { outcome: 'startedNewTurn' };
		return { outcome: 'injected' };
	},
);

app.onRequest('session/new', async () => {
	const sessionId = randomUUID();
	knownSessions.add(sessionId);
	return { sessionId };
});

app.onRequest('session/load', async ({ params, client }) => {
	if (!knownSessions.has(params.sessionId)) throw new Error('fake-acp-agent: unknown session id');
	await sendChunk(client, params.sessionId, 'REPLAYED-HISTORY-SHOULD-NEVER-STREAM-AS-A-TURN-CHUNK');
	return undefined;
});

app.onNotification('session/cancel', ({ params }) => {
	pendingCancels.get(params.sessionId)?.();
});

app.onRequest('session/prompt', async ({ params, client }) => {
	const sessionId = params.sessionId;
	const text = textOf(params.prompt);

	if (text.includes('FAKE_SCENARIO=hang')) {
		await new Promise<void>(() => undefined); // never resolves; only process kill ends this
		return { stopReason: 'end_turn' as const };
	}

	if (text.includes('FAKE_SCENARIO=cancel_cooperative')) {
		await sendChunk(client, sessionId, 'partial-before-cancel');
		const cancelled = await new Promise<boolean>((resolve) => {
			pendingCancels.set(sessionId, () => resolve(true));
			// Generous safety valve, not a real timeout contract: under a heavily
			// loaded parallel test run (many concurrent subprocess spawns across
			// the whole suite) even DETECTING the first chunk can itself take
			// several seconds, so a short cap here can race legitimate
			// slow-but-still-passing tests that hold this turn open on purpose
			// (phase-04 mid-turn steer tests).
			setTimeout(() => resolve(false), 120_000).unref();
		});
		pendingCancels.delete(sessionId);
		return { stopReason: cancelled ? ('cancelled' as const) : ('end_turn' as const) };
	}

	if (text.includes('FAKE_SCENARIO=permission')) {
		const askOnce = async (toolCallId: string, kind: 'read' | 'execute', title: string) => {
			const response = await client.request('session/request_permission', {
				sessionId,
				toolCall: { toolCallId, kind, title },
				options: [
					{ optionId: `allow_once::${randomUUID()}`, name: 'Allow', kind: 'allow_once' },
					{ optionId: `reject_once::${randomUUID()}`, name: 'Deny', kind: 'reject_once' },
				],
			});
			return response.outcome.outcome === 'selected' ? response.outcome.optionId.split('::')[0] : 'cancelled';
		};
		const readDecision = await askOnce('tool-read', 'read', 'Read a file');
		const execDecision = await askOnce('tool-exec', 'execute', 'Run a shell command');
		await sendChunk(client, sessionId, `read=${readDecision} execute=${execDecision}`);
		return { stopReason: 'end_turn' as const };
	}

	// Isolation integration tests only: reads/writes `process.env.FAKE_TEST_TARGET_PATH`
	// (never a path embedded in the prompt text) so a real OS sandbox around
	// THIS process is what decides the outcome, not anything the fake agent
	// itself enforces.
	if (text.includes('FAKE_SCENARIO=fs_read_target')) {
		const target = process.env.FAKE_TEST_TARGET_PATH ?? '';
		let result: string;
		try {
			readFileSync(target);
			result = 'READ_OK';
		} catch {
			result = 'READ_DENIED';
		}
		await sendChunk(client, sessionId, result);
		return { stopReason: 'end_turn' as const };
	}
	if (text.includes('FAKE_SCENARIO=fs_write_target')) {
		const target = process.env.FAKE_TEST_TARGET_PATH ?? '';
		let result: string;
		try {
			writeFileSync(target, 'planted-by-fake-agent');
			result = 'WRITE_OK';
		} catch {
			result = 'WRITE_DENIED';
		}
		await sendChunk(client, sessionId, result);
		return { stopReason: 'end_turn' as const };
	}

	if (text.includes('FAKE_SCENARIO=report_steering_count')) {
		await sendChunk(client, sessionId, `steering_calls=${steeringCallCount}`);
		return { stopReason: 'end_turn' as const };
	}

	// Default / FAKE_SCENARIO=echo.
	await sendChunk(client, sessionId, 'Echo: ');
	await sendChunk(client, sessionId, text);
	await client.notify('session/update', {
		sessionId,
		update: { sessionUpdate: 'tool_call', toolCallId: 'search-1', title: 'Search files', kind: 'search', status: 'in_progress', rawInput: { query: 'x' } },
	});
	await client.notify('session/update', {
		sessionId,
		update: { sessionUpdate: 'tool_call_update', toolCallId: 'search-1', status: 'completed', title: 'Search files' },
	});
	return { stopReason: 'end_turn' as const };
});

const stream: Stream = ndJsonStream(
	Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
	Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
);
app.connect(stream);
