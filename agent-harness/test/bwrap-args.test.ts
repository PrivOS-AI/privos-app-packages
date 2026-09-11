import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBwrapArgs } from '../src/isolation/bwrap-args.js';

describe('buildBwrapArgs', () => {
	const workspaceDir = '/home/user/privos-harness/agent-1';
	const roomDir = join(workspaceDir, 'rooms', 'room-1');
	const realHomeDir = '/home/user';

	it('orders every tmpfs over a PARENT before the --bind of its CHILD (M2)', () => {
		const args = buildBwrapArgs({ workspaceDir, roomDir, homeDir: undefined, realHomeDir });
		const roomsRoot = join(workspaceDir, 'rooms');
		const tmpfsRoomsIndex = indexOfPair(args, '--tmpfs', roomsRoot);
		const bindRoomIndex = indexOfPair(args, '--bind', roomDir);
		expect(tmpfsRoomsIndex).toBeGreaterThanOrEqual(0);
		expect(bindRoomIndex).toBeGreaterThan(tmpfsRoomsIndex);
	});

	it('tmpfs-hides every real credential/config dir (.ssh, .aws, .gnupg, .privos, .claude, .codex)', () => {
		const args = buildBwrapArgs({ workspaceDir, roomDir, homeDir: undefined, realHomeDir });
		for (const dir of ['.ssh', '.aws', '.gnupg', '.privos', '.claude', '.codex']) {
			expect(indexOfPair(args, '--tmpfs', join(realHomeDir, dir))).toBeGreaterThanOrEqual(0);
		}
	});

	it('ro-binds the shared .privos dir and IDENTITY.md', () => {
		const args = buildBwrapArgs({ workspaceDir, roomDir, homeDir: undefined, realHomeDir });
		expect(indexOfPair(args, '--ro-bind', join(workspaceDir, '.privos'))).toBeGreaterThanOrEqual(0);
		expect(indexOfPair(args, '--ro-bind', join(workspaceDir, 'IDENTITY.md'))).toBeGreaterThanOrEqual(0);
	});

	it('binds a seeded per-room home dir rw when supplied, and omits it entirely otherwise', () => {
		const homeDir = join(roomDir, '.home');
		const withHome = buildBwrapArgs({ workspaceDir, roomDir, homeDir, realHomeDir });
		expect(indexOfPair(withHome, '--bind', homeDir)).toBeGreaterThanOrEqual(0);

		const withoutHome = buildBwrapArgs({ workspaceDir, roomDir, homeDir: undefined, realHomeDir });
		expect(withoutHome.includes(homeDir)).toBe(false);
	});

	it('unshares every namespace but networking, and dies with the parent', () => {
		const args = buildBwrapArgs({ workspaceDir, roomDir, homeDir: undefined, realHomeDir });
		expect(args).toEqual(expect.arrayContaining(['--unshare-all', '--share-net', '--die-with-parent']));
	});
});

function indexOfPair(args: string[], flag: string, value: string): number {
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === flag && args[i + 1] === value) return i;
	}
	return -1;
}
