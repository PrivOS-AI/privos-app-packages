import * as tar from 'tar';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installSkillsBundle, listInstalledSkills } from '../src/skills-installer.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// Builds a bundle EXACTLY the way the hub does: tar.c over directory NAMES with
// portable:true, so the archive carries real Directory entries (`skills/`,
// `agent-room/`, `skill-sdk/`) — the case the file-only fixtures never covered.
async function buildHubStyleBundle(): Promise<Buffer> {
	const staging = mkdtempSync(join(tmpdir(), 'hub-style-'));
	const a = Buffer.from('# skill a\n');
	const sdk = Buffer.from('def hub():\n    return None\n');
	mkdirSync(join(staging, 'skills', 'fake-a'), { recursive: true });
	mkdirSync(join(staging, 'agent-room', 'skills', 'agent-bot-edit'), { recursive: true });
	mkdirSync(join(staging, 'skill-sdk'), { recursive: true });
	writeFileSync(join(staging, 'skills', 'fake-a', 'SKILL.md'), a);
	writeFileSync(join(staging, 'agent-room', 'skills', 'agent-bot-edit', 'SKILL.md'), a);
	writeFileSync(join(staging, 'skill-sdk', 'privos_skill.py'), sdk);
	const allFiles = [
		{ path: 'skills/fake-a/SKILL.md', sha256: sha256(a) },
		{ path: 'agent-room/skills/agent-bot-edit/SKILL.md', sha256: sha256(a) },
		{ path: 'skill-sdk/privos_skill.py', sha256: sha256(sdk) },
	];
	const manifest = {
		sandboxVersion: '9.9.9',
		builtAt: new Date().toISOString(),
		skills: [
			{ name: 'fake-a', files: ['skills/fake-a/SKILL.md'], sha256: 'x' },
			{ name: 'agent-bot-edit', files: ['agent-room/skills/agent-bot-edit/SKILL.md'], sha256: 'x' },
		],
		allFiles,
	};
	writeFileSync(join(staging, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
	const chunks: Buffer[] = [];
	await new Promise<void>((resolve, reject) => {
		const s = tar.c({ gzip: true, cwd: staging, portable: true }, ['MANIFEST.json', 'skills', 'agent-room', 'skill-sdk']);
		s.on('data', (c: Buffer) => chunks.push(c));
		s.on('end', () => resolve());
		s.on('error', reject);
	});
	rmSync(staging, { recursive: true, force: true });
	return Buffer.concat(chunks);
}

describe('real hub-style bundle (tar.c over directory names, portable)', () => {
	let ws: string;
	beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'hub-bundle-ws-')); });
	afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

	it('installs without rejecting the top-level directory entries', async () => {
		const buf = await buildHubStyleBundle();
		const result = await installSkillsBundle(buf, ws, { mode: 'install' });
		expect(result.installed).toBe(true);
		expect(result.skillNames.sort()).toEqual(['agent-bot-edit', 'fake-a']);
		expect(listInstalledSkills(ws)?.sandboxVersion).toBe('9.9.9');
	});
});
