/**
 * Room-message attachments delivered inline on `turn.start` (base64) are written
 * under the room workdir so the adapter can read them by path / resource_link,
 * then handed to the ACP session as content blocks. Kept separate from the ACP
 * wire logic so the file I/O is easy to test and reuse.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { AgentHarnessTurnAttachment } from './hub-relay-client.js';

/** Subdirectory (under the room workdir) that holds a turn's attachment files. */
const ATTACHMENTS_DIR = '.privos-attachments';

/** An attachment after it has been materialised on disk. */
export interface WrittenAttachment {
	/** Absolute path to the written file. */
	path: string;
	/** Original (sanitised) file name. */
	name: string;
	mimeType: string;
}

/**
 * Write each attachment to `<cwd>/.privos-attachments/<turnId>/<name>`.
 * Never throws: an unwritable file is skipped (logged) so the turn still runs.
 * Names are basename-only to prevent path traversal outside the turn directory.
 */
export async function writeTurnAttachments(
	cwd: string,
	turnId: string,
	attachments: AgentHarnessTurnAttachment[],
): Promise<WrittenAttachment[]> {
	const dir = join(cwd, ATTACHMENTS_DIR, sanitizeSegment(turnId));
	const written: WrittenAttachment[] = [];
	try {
		await mkdir(dir, { recursive: true });
	} catch (err) {
		process.stderr.write(`[agent-harness] could not create attachment dir ${dir}: ${String(err)}\n`);
		return written;
	}
	for (const att of attachments) {
		const name = safeName(att.name);
		const path = join(dir, name);
		try {
			await writeFile(path, Buffer.from(att.data, 'base64'));
			written.push({ path, name, mimeType: att.mimeType });
		} catch (err) {
			process.stderr.write(`[agent-harness] could not write attachment ${name}: ${String(err)}\n`);
		}
	}
	return written;
}

/** basename + strip anything but a safe set, so a crafted name can't escape the dir. */
function safeName(name: string): string {
	const base = basename(name || 'file').replace(/[^A-Za-z0-9._-]/g, '_');
	return base.replace(/^\.+/, '') || 'file';
}

function sanitizeSegment(seg: string): string {
	return seg.replace(/[^A-Za-z0-9._-]/g, '_') || 'turn';
}
