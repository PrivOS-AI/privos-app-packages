import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeTurnAttachments } from '../src/turn-attachments.js';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'att-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('writeTurnAttachments', () => {
	it('writes each attachment under .privos-attachments/<turnId> and returns paths', async () => {
		const written = await writeTurnAttachments(dir, 'turn-1', [
			{ name: 'report.pdf', mimeType: 'application/pdf', data: Buffer.from('PDF-BYTES').toString('base64') },
			{ name: 'photo.png', mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') },
		]);
		expect(written.map((w) => w.name)).toEqual(['report.pdf', 'photo.png']);
		expect(written[0].path).toContain(join('.privos-attachments', 'turn-1'));
		expect(readFileSync(written[0].path, 'utf-8')).toBe('PDF-BYTES');
		expect(readFileSync(written[1].path)).toEqual(Buffer.from([1, 2, 3]));
	});

	it('sanitises names so a crafted path cannot escape the turn directory', async () => {
		const written = await writeTurnAttachments(dir, 'turn-2', [
			{ name: '../../etc/passwd', mimeType: 'text/plain', data: Buffer.from('x').toString('base64') },
		]);
		expect(written).toHaveLength(1);
		expect(written[0].path).toContain(join('.privos-attachments', 'turn-2'));
		expect(written[0].path).not.toContain('etc/passwd');
		expect(written[0].name).not.toContain('/');
	});
});
