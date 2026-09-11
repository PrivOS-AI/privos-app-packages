import { describe, expect, it } from 'vitest';
import { buildContainerRunArgs, containerNameFor } from '../src/isolation/container-run.js';

describe('buildContainerRunArgs', () => {
	const input = {
		roomId: 'room1',
		workspaceDir: '/ws',
		roomDir: '/ws/rooms/room1',
		homeDir: '/ws/rooms/room1/.home',
		bridgeNodeModulesDir: '/bridge/node_modules',
		image: 'node:22-bookworm',
		command: 'claude-agent-acp',
		args: [],
		env: { PRIVOS_BOT_KEY: 'privos_secrettoken', PRIVOS_URL: 'https://hub.example', PRIVOS_ROOM_ID: 'room1' },
	};

	it('never places a secret value in the docker argv — env is passed name-only', () => {
		const args = buildContainerRunArgs(input);
		// The token value must be inheritable from the docker process env, not in argv (ps-visible).
		expect(args.join(' ')).not.toContain('privos_secrettoken');
		// Name-only form: `-e PRIVOS_BOT_KEY` with no `=value` next to it.
		const i = args.indexOf('PRIVOS_BOT_KEY');
		expect(i).toBeGreaterThan(0);
		expect(args[i - 1]).toBe('-e');
	});

	it('names the container deterministically per room', () => {
		expect(containerNameFor('abc')).toBe('privos-room-abc');
		expect(buildContainerRunArgs(input)).toContain('privos-room-room1');
	});
});
