import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSeatbeltProfile } from '../src/isolation/seatbelt-profile.js';

describe('buildSeatbeltProfile', () => {
	let base: string;
	beforeEach(() => {
		// realpath'd up front (macOS $TMPDIR is itself a symlink, e.g.
		// `/var/folders/...` -> `/private/var/folders/...`) so every expected
		// path below matches what the generator emits after its OWN H2 realpath
		// pass, instead of the test asserting the wrong (pre-realpath) string.
		base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-harness-seatbelt-test-')));
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	function scaffold() {
		const workspaceDir = join(base, 'workspace');
		const roomDir = join(workspaceDir, 'rooms', 'room-1');
		mkdirSync(roomDir, { recursive: true });
		return { workspaceDir, roomDir };
	}

	it('realpaths a symlinked workspace root (H2) instead of emitting the symlink path', () => {
		const { workspaceDir: realWorkspace, roomDir } = scaffold();
		const linkedWorkspace = join(base, 'workspace-link');
		symlinkSync(realWorkspace, linkedWorkspace, 'dir');

		const profile = buildSeatbeltProfile({ workspaceDir: linkedWorkspace, roomDir, homeDir: undefined, realHomeDir: base });
		expect(profile).not.toContain(linkedWorkspace);
		expect(profile).toContain(realWorkspace);
	});

	it('allows file-write* for the room, $TMPDIR, and the explicit /dev nodes (H3)', () => {
		const { workspaceDir, roomDir } = scaffold();
		const profile = buildSeatbeltProfile({ workspaceDir, roomDir, homeDir: undefined, realHomeDir: base });
		expect(profile).toMatch(/\(deny file-write\*\)/);
		expect(profile).toContain('(literal "/dev/null")');
		expect(profile).toContain('(literal "/dev/tty")');
		expect(profile).toContain('(regex #"^/dev/ttys")');
		expect(profile).toContain('(subpath "/dev/fd")');
		expect(profile).toContain('(literal "/dev/zero")');
		expect(profile).toContain('(literal "/dev/random")');
		expect(profile).toContain('(literal "/dev/urandom")');
		expect(profile).toContain('(literal "/dev/dtracehelper")');
		expect(profile).toContain(`(subpath "${roomDir}")`);
	});

	it('allows file-write* for a seeded per-room home dir when one is supplied', () => {
		const { workspaceDir, roomDir } = scaffold();
		const homeDir = join(roomDir, '.home');
		mkdirSync(homeDir, { recursive: true });
		const profile = buildSeatbeltProfile({ workspaceDir, roomDir, homeDir, realHomeDir: base });
		expect(profile).toContain(`(subpath "${homeDir}")`);
	});

	it('denies file-read* for rooms/ and every real credential dir, then re-allows only this room + shared skills + identity', () => {
		const { workspaceDir, roomDir } = scaffold();
		const roomsRoot = join(workspaceDir, 'rooms');
		const profile = buildSeatbeltProfile({ workspaceDir, roomDir, homeDir: undefined, realHomeDir: base });

		expect(profile).toContain(`(subpath "${roomsRoot}")`); // denied
		expect(profile).toContain(`(subpath "${join(base, '.claude')}")`);
		expect(profile).toContain(`(literal "${join(base, '.claude.json')}")`);
		expect(profile).toContain(`(subpath "${join(base, '.codex')}")`);
		expect(profile).toContain(`(subpath "${join(base, '.ssh')}")`);
		expect(profile).toContain(`(subpath "${join(base, '.aws')}")`);
		expect(profile).toContain(`(subpath "${join(base, '.gnupg')}")`);
		expect(profile).toContain(`(subpath "${join(base, '.privos')}")`);

		expect(profile).toContain(`(allow file-read* (subpath "${roomDir}") (subpath "${join(workspaceDir, '.privos')}") (literal "${join(workspaceDir, 'IDENTITY.md')}"))`);
	});

	it('allows file-read-metadata on the deny-root parent of the allowed room (H1)', () => {
		const { workspaceDir, roomDir } = scaffold();
		const roomsRoot = join(workspaceDir, 'rooms');
		const profile = buildSeatbeltProfile({ workspaceDir, roomDir, homeDir: undefined, realHomeDir: base });
		expect(profile).toContain(`(allow file-read-metadata (literal "${roomsRoot}"))`);
	});

	it('is deterministic and compiles under sandbox-exec on macOS', () => {
		if (platform() !== 'darwin') return; // this specific assertion only makes sense on the platform sandbox-exec actually runs on
		const { workspaceDir, roomDir } = scaffold();
		const profile = buildSeatbeltProfile({ workspaceDir, roomDir, homeDir: undefined, realHomeDir: base });
		const result = spawnSync('sandbox-exec', ['-p', profile, '/usr/bin/true'], { encoding: 'utf-8' });
		expect(result.status).toBe(0);
	});
});
