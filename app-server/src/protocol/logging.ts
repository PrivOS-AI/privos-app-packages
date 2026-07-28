export interface RedactedLogFields {
	method?: string;
	toolName?: string;
	id?: string | number | null;
	durationMs?: number;
	resultBytes?: number;
	errorCode?: number;
	identityState?: string;
	transport?: string;
	traceId?: string;
	warning?: string;
}

/** Safe summary for logs — never include tokens, mail bodies, or secrets. */
export function summarizeForLog(fields: RedactedLogFields): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

export function estimateJsonBytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value), 'utf8');
	} catch {
		return -1;
	}
}
