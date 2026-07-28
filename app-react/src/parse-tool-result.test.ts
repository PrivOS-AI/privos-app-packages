import { describe, expect, it } from 'vitest';

import { parseToolResult } from './parse-tool-result.js';

describe('parseToolResult', () => {
	it('parses content[0].text JSON', () => {
		expect(
			parseToolResult({
				content: [{ type: 'text', text: JSON.stringify({ userId: 'u1', roomId: 'r1' }) }],
			}),
		).toEqual({ userId: 'u1', roomId: 'r1' });
	});

	it('throws on isError payloads', () => {
		expect(() =>
			parseToolResult({
				isError: true,
				content: [{ type: 'text', text: 'Caller identity token is invalid' }],
			}),
		).toThrow(/Caller identity token is invalid/);
	});

	it('returns plain objects that already look like context', () => {
		expect(parseToolResult({ userId: 'u1', username: 'alice' })).toEqual({
			userId: 'u1',
			username: 'alice',
		});
	});
});
