/** Parse MCP tool / host bridge responses into plain objects. */
export function parseToolResult(result: unknown): Record<string, unknown> {
	if (!result || typeof result !== 'object') return {};

	const r = result as Record<string, unknown>;
	if (r.isError) {
		const msg =
			(typeof (r.content as unknown[])?.[0] === 'object' &&
				(r.content as Array<{ text?: string }>)?.[0]?.text) ||
			'Tool call failed';
		throw new Error(msg);
	}

	const nested = r.result as Record<string, unknown> | undefined;
	const content = (r.content ?? nested?.content) as Array<{ text?: string }> | undefined;
	const text = content?.[0]?.text;
	if (typeof text === 'string' && text.trim()) {
		try {
			return JSON.parse(text) as Record<string, unknown>;
		} catch {
			return { raw: text };
		}
	}

	if (typeof r.userId === 'string') return r;
	if (nested && typeof nested === 'object' && typeof nested.userId === 'string') return nested;

	return r;
}
