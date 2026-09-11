import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listBusyRooms, setRoomBusy } from '../src/skills-installer.js';

describe('room busy tracking (skills update cross-process refusal)', () => {
	let workspaceDir: string;
	beforeEach(() => {
		workspaceDir = mkdtempSync(join(tmpdir(), 'agent-harness-busy-rooms-test-'));
	});
	afterEach(() => rmSync(workspaceDir, { recursive: true, force: true }));

	it('lists a room as busy once marked, and no longer once cleared', () => {
		expect(listBusyRooms(workspaceDir)).toEqual([]);
		setRoomBusy(workspaceDir, 'room-a', true);
		expect(listBusyRooms(workspaceDir)).toEqual(['room-a']);
		setRoomBusy(workspaceDir, 'room-a', false);
		expect(listBusyRooms(workspaceDir)).toEqual([]);
	});

	it('tracks multiple rooms independently', () => {
		setRoomBusy(workspaceDir, 'room-a', true);
		setRoomBusy(workspaceDir, 'room-b', true);
		expect(listBusyRooms(workspaceDir).sort()).toEqual(['room-a', 'room-b']);
		setRoomBusy(workspaceDir, 'room-a', false);
		expect(listBusyRooms(workspaceDir)).toEqual(['room-b']);
	});

	it('survives across separate reads, the way two different CLI processes would see it', () => {
		setRoomBusy(workspaceDir, 'room-a', true);
		// Simulates `skills update` running as a brand new process: nothing but
		// the on-disk file is shared, so a second, independent call must still see it.
		expect(listBusyRooms(workspaceDir)).toEqual(['room-a']);
	});
});
