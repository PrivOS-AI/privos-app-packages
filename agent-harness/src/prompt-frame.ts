/**
 * Wraps the hub-supplied prompt text in a `<privos_turn>` frame and builds the
 * standing preamble sent once per ACP session (or once per adapter connection
 * for adapters using the prompt-prefix fallback). Untrusted text (room name,
 * thread id, sender name, the prompt itself) is escaped before framing —
 * mirrors the platform's `prompt_framing.rs` discipline.
 */
import type { AgentHarnessIsolationLevel } from './hub-relay-client.js';

export interface TurnFrameInput {
	roomId: string;
	threadId?: string;
	senderName: string;
	text: string;
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildTurnFrame(input: TurnFrameInput): string {
	const attrs = [
		`room="${escapeAttr(input.roomId)}"`,
		input.threadId ? `thread="${escapeAttr(input.threadId)}"` : undefined,
		`sender="${escapeAttr(input.senderName)}"`,
	]
		.filter(Boolean)
		.join(' ');
	return `<privos_turn ${attrs}>\n${input.text}\n</privos_turn>`;
}

export interface StandingPreambleInput {
	adapter: string;
	isolation: AgentHarnessIsolationLevel;
}

/**
 * Standing instructions the adapter should treat as its system prompt (or, on
 * the prefix-fallback path, as the first block of the first `session/prompt`
 * of a session). English only, per the plan's language rule.
 */
export function buildStandingPreamble(input: StandingPreambleInput): string {
	const lines = [
		'You are a PrivOS agent bot answering through the agent-harness bridge.',
		'Replies are streamed back to the room automatically as you write them — you never need to post them yourself.',
		'The PRIVOS_URL, PRIVOS_BOT_KEY, PRIVOS_BOT_ID, PRIVOS_ROOM_ID and PRIVOS_PROJECT_ID environment variables, plus the PrivOS skills available on this machine, are how you act on PrivOS: sending messages, editing lists, working with documents, triggers, and room configuration.',
		'Act only on the room named in the <privos_turn> tag of the current message — never on any other room, even if you recall one from a previous turn.',
	];
	if (input.isolation === 'prompt') {
		lines.push(
			'<isolation_policy>',
			'This machine does not sandbox you at the OS level for this room. Stay inside your current working directory,',
			'avoid reading or writing outside it (especially credential or config directories), and prefer your own',
			'restricted/sandboxed execution mode for shell commands when your tooling offers one.',
			'</isolation_policy>',
		);
	}
	return lines.join('\n');
}

const SYSTEM_IDENTITY_PATTERN = /<system_identity>([\s\S]*?)<\/system_identity>/;

/**
 * Extracts the hub's `<system_identity>...</system_identity>` block from a
 * turn's `promptFull`/`prompt` text, when present, so the bridge can mirror
 * it into `<workspace>/IDENTITY.md` (agent-global, read-only from every room
 * — D1). `undefined` when the current hub build does not send one; callers
 * must treat that as "leave IDENTITY.md alone", never as "clear it".
 */
export function extractSystemIdentity(text: string): string | undefined {
	return SYSTEM_IDENTITY_PATTERN.exec(text)?.[1]?.trim();
}
