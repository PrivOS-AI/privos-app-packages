import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materializeRoomDir, materializeWorkspaceRoot, pruneRoomDirs, writeIdentityFile } from '../src/skills-installer.js';
import { extractSystemIdentity } from '../src/prompt-frame.js';

describe('materializeWorkspaceRoot + writeIdentityFile', () => {
	let workspaceDir: string;
	beforeEach(() => {
		workspaceDir = mkdtempSync(join(tmpdir(), 'agent-harness-workspace-root-test-'));
	});
	afterEach(() => rmSync(workspaceDir, { recursive: true, force: true }));

	it('creates .privos/, rooms/, and a placeholder IDENTITY.md', () => {
		materializeWorkspaceRoot(workspaceDir);
		expect(existsSync(join(workspaceDir, '.privos'))).toBe(true);
		expect(existsSync(join(workspaceDir, 'rooms'))).toBe(true);
		expect(readFileSync(join(workspaceDir, 'IDENTITY.md'), 'utf-8')).toContain('not yet set by the hub');
	});

	it('never overwrites an existing IDENTITY.md', () => {
		materializeWorkspaceRoot(workspaceDir);
		writeFileSync(join(workspaceDir, 'IDENTITY.md'), '# Real identity\n');
		materializeWorkspaceRoot(workspaceDir);
		expect(readFileSync(join(workspaceDir, 'IDENTITY.md'), 'utf-8')).toBe('# Real identity\n');
	});

	it('writeIdentityFile only touches disk when the content actually changed', () => {
		materializeWorkspaceRoot(workspaceDir);
		writeIdentityFile(workspaceDir, '# Agent Alice\n');
		expect(readFileSync(join(workspaceDir, 'IDENTITY.md'), 'utf-8')).toBe('# Agent Alice\n');

		const before = statSync(join(workspaceDir, 'IDENTITY.md')).mtimeMs;
		writeIdentityFile(workspaceDir, '# Agent Alice\n'); // same content -> no-op
		const after = statSync(join(workspaceDir, 'IDENTITY.md')).mtimeMs;
		expect(after).toBe(before);

		writeIdentityFile(workspaceDir, '# Agent Alice (renamed)\n');
		expect(readFileSync(join(workspaceDir, 'IDENTITY.md'), 'utf-8')).toBe('# Agent Alice (renamed)\n');
	});
});

describe('extractSystemIdentity', () => {
	it('extracts and trims the block when present', () => {
		const text = 'before\n<system_identity>\n# Agent Alice\nRole: assistant\n</system_identity>\nafter';
		expect(extractSystemIdentity(text)).toBe('# Agent Alice\nRole: assistant');
	});

	it('returns undefined when no block is present', () => {
		expect(extractSystemIdentity('just a normal prompt')).toBeUndefined();
	});
});

describe('materializeRoomDir', () => {
	let workspaceDir: string;
	beforeEach(() => {
		workspaceDir = mkdtempSync(join(tmpdir(), 'agent-harness-room-dir-test-'));
		materializeWorkspaceRoot(workspaceDir);
		mkdirSync(join(workspaceDir, '.privos', 'skills', 'fake-skill'), { recursive: true });
		writeFileSync(join(workspaceDir, '.privos', 'skills', 'fake-skill', 'SKILL.md'), '# fake skill');
		mkdirSync(join(workspaceDir, '.privos', 'skill-sdk'), { recursive: true });
		writeFileSync(join(workspaceDir, '.privos', 'skill-sdk', 'privos_skill.py'), '# sdk');
	});
	afterEach(() => rmSync(workspaceDir, { recursive: true, force: true }));

	it('symlinks .privos/skills and .privos/skill-sdk into the room (not copies)', () => {
		const roomDir = materializeRoomDir(workspaceDir, 'room-1');
		expect(lstatSync(join(roomDir, '.privos', 'skills')).isSymbolicLink()).toBe(true);
		expect(lstatSync(join(roomDir, '.privos', 'skill-sdk')).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(roomDir, '.privos', 'skills', 'fake-skill', 'SKILL.md'), 'utf-8')).toBe('# fake skill');
	});

	it('creates the .claude/skills alias and room CLAUDE.md/AGENTS.md naming the room id', () => {
		const roomDir = materializeRoomDir(workspaceDir, 'room-42');
		expect(lstatSync(join(roomDir, '.claude', 'skills')).isSymbolicLink()).toBe(true);
		const claudeMd = readFileSync(join(roomDir, 'CLAUDE.md'), 'utf-8');
		expect(claudeMd).toContain('room `room-42`');
		expect(readFileSync(join(roomDir, 'AGENTS.md'), 'utf-8')).toBe(claudeMd);
	});

	it('leaves a real (non-symlink) .privos/skills a user created alone', () => {
		const roomDir = join(workspaceDir, 'rooms', 'room-1');
		mkdirSync(join(roomDir, '.privos', 'skills'), { recursive: true });
		writeFileSync(join(roomDir, '.privos', 'skills', 'user-file.txt'), 'mine');
		materializeRoomDir(workspaceDir, 'room-1');
		expect(lstatSync(join(roomDir, '.privos', 'skills')).isSymbolicLink()).toBe(false);
		expect(existsSync(join(roomDir, '.privos', 'skills', 'user-file.txt'))).toBe(true);
	});
});

describe('pruneRoomDirs', () => {
	let workspaceDir: string;
	beforeEach(() => {
		workspaceDir = mkdtempSync(join(tmpdir(), 'agent-harness-prune-test-'));
		mkdirSync(join(workspaceDir, 'rooms'), { recursive: true });
	});
	afterEach(() => rmSync(workspaceDir, { recursive: true, force: true }));

	function makeRoom(roomId: string, ageMs: number): void {
		const dir = join(workspaceDir, 'rooms', roomId);
		mkdirSync(dir, { recursive: true });
		const mtime = new Date(Date.now() - ageMs);
		utimesSync(dir, mtime, mtime);
	}

	it('prunes a room older than 30 days', () => {
		makeRoom('old-room', 31 * 24 * 60 * 60 * 1000);
		makeRoom('fresh-room', 0);
		pruneRoomDirs(workspaceDir, new Set());
		expect(existsSync(join(workspaceDir, 'rooms', 'old-room'))).toBe(false);
		expect(existsSync(join(workspaceDir, 'rooms', 'fresh-room'))).toBe(true);
	});

	it('never prunes a room with a live process, even if stale', () => {
		makeRoom('old-but-live', 31 * 24 * 60 * 60 * 1000);
		pruneRoomDirs(workspaceDir, new Set(['old-but-live']));
		expect(existsSync(join(workspaceDir, 'rooms', 'old-but-live'))).toBe(true);
	});

	it('keeps only the newest 200 rooms beyond the count cap', () => {
		for (let i = 0; i < 202; i++) makeRoom(`room-${i}`, (202 - i) * 1000); // room-0 oldest, room-201 newest
		pruneRoomDirs(workspaceDir, new Set());
		expect(existsSync(join(workspaceDir, 'rooms', 'room-0'))).toBe(false);
		expect(existsSync(join(workspaceDir, 'rooms', 'room-1'))).toBe(false);
		expect(existsSync(join(workspaceDir, 'rooms', 'room-201'))).toBe(true);
	});

	it('removes a room\'s .home/ along with the room dir', () => {
		makeRoom('old-room', 31 * 24 * 60 * 60 * 1000);
		mkdirSync(join(workspaceDir, 'rooms', 'old-room', '.home'), { recursive: true });
		writeFileSync(join(workspaceDir, 'rooms', 'old-room', '.home', '.credentials.json'), '{}');
		makeRoom('old-room', 31 * 24 * 60 * 60 * 1000); // re-stamp: creating .home/ above bumped the room dir's own mtime
		pruneRoomDirs(workspaceDir, new Set());
		expect(existsSync(join(workspaceDir, 'rooms', 'old-room', '.home'))).toBe(false);
	});
});
