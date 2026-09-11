/**
 * Redacts any `privos_*` credential-shaped token from a string before it is
 * logged, printed, or otherwise leaves the process. Applied everywhere the
 * bridge writes to stdout/stderr — bot tokens, one-time pairing keys, and
 * skills-link tokens all share this `privos_` prefix convention.
 */
const PRIVOS_TOKEN_PATTERN = /privos_[A-Za-z0-9_]+/g;

export function redact(input: string): string {
	return input.replace(PRIVOS_TOKEN_PATTERN, 'privos_[redacted]');
}

/** Redacts every string value (recursively) in an arbitrary object, for structured log lines. */
export function redactDeep<T>(value: T): T {
	if (typeof value === 'string') return redact(value) as unknown as T;
	if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as unknown as T;
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			out[key] = redactDeep(val);
		}
		return out as T;
	}
	return value;
}
