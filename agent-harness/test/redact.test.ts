import { describe, expect, it } from 'vitest';
import { redact, redactDeep } from '../src/redact.js';

describe('redact', () => {
	it('replaces privos_ tokens with a redacted marker', () => {
		expect(redact('Authorization: Bearer privos_abc123XYZ_9')).toBe('Authorization: Bearer privos_[redacted]');
	});

	it('redacts every occurrence in a string', () => {
		expect(redact('privos_one and privos_two')).toBe('privos_[redacted] and privos_[redacted]');
	});

	it('leaves unrelated text untouched', () => {
		expect(redact('no secrets here')).toBe('no secrets here');
	});

	it('redactDeep walks nested objects and arrays', () => {
		const input = { a: 'privos_secret', b: [{ c: 'privos_nested' }], d: 42, e: null };
		expect(redactDeep(input)).toEqual({ a: 'privos_[redacted]', b: [{ c: 'privos_[redacted]' }], d: 42, e: null });
	});
});
