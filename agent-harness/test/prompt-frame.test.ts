import { describe, expect, it } from 'vitest';
import { buildStandingPreamble, buildTurnFrame } from '../src/prompt-frame.js';

describe('buildTurnFrame', () => {
	it('wraps text in a privos_turn tag with escaped attributes', () => {
		const frame = buildTurnFrame({ roomId: 'room"1', threadId: 'thread<2>', senderName: 'A & B', text: 'hello' });
		expect(frame).toContain('room="room&quot;1"');
		expect(frame).toContain('thread="thread&lt;2&gt;"');
		expect(frame).toContain('sender="A &amp; B"');
		expect(frame).toContain('\nhello\n');
		expect(frame.startsWith('<privos_turn ')).toBe(true);
		expect(frame.endsWith('</privos_turn>')).toBe(true);
	});

	it('omits the thread attribute when no threadId is given', () => {
		const frame = buildTurnFrame({ roomId: 'r1', senderName: 'bob', text: 'hi' });
		expect(frame).not.toContain('thread=');
	});
});

describe('buildStandingPreamble', () => {
	it('always mentions the PRIVOS_ env vars and the room-scoping rule', () => {
		const preamble = buildStandingPreamble({ adapter: 'claude', isolation: 'none' });
		expect(preamble).toContain('PRIVOS_URL');
		expect(preamble).toContain('Act only on the room named');
		expect(preamble).not.toContain('isolation_policy');
	});

	it('adds the isolation_policy block only for isolation "prompt"', () => {
		const preamble = buildStandingPreamble({ adapter: 'claude', isolation: 'prompt' });
		expect(preamble).toContain('<isolation_policy>');
		expect(preamble).toContain('</isolation_policy>');
	});
});
