/**
 * `container` isolation level: `docker run --rm -i --name privos-room-<roomId>`
 * per room. Room dir rw, the shared `.privos` + `IDENTITY.md` ro, the seeded
 * per-room adapter state rw, the bridge's own `node_modules` ro with
 * `NODE_PATH` pointing inside the container so the skill-sdk imports still
 * resolve. Building/publishing the actual image (`node:22-bookworm` +
 * `python3` + the chosen adapter, per the operator guideline) is out of
 * scope for the bridge — `--container-image` lets an operator point at one
 * they built; `self-test.ts` is what verifies a given image/daemon actually
 * works before this level is ever selected by `auto`.
 */
import { join } from 'node:path';

export interface ContainerRunInput {
	roomId: string;
	workspaceDir: string;
	roomDir: string;
	/** The adapter's per-room state dir, or `undefined` for a shared-state adapter. */
	homeDir: string | undefined;
	/** The bridge's own `node_modules` (skill-sdk, axios), mounted read-only. */
	bridgeNodeModulesDir: string;
	image: string;
	command: string;
	args: string[];
	env: Record<string, string>;
}

/** `docker kill privos-room-<roomId>` — the container-level cancel/reap primitive. */
export function containerNameFor(roomId: string): string {
	return `privos-room-${roomId}`;
}

/** Builds the full `docker run ...` argv (everything after `docker`). */
export function buildContainerRunArgs(input: ContainerRunInput): string[] {
	const privosSharedDir = join(input.workspaceDir, '.privos');
	const identityFile = join(input.workspaceDir, 'IDENTITY.md');

	const args = [
		'run',
		'--rm',
		'-i',
		'--name',
		containerNameFor(input.roomId),
		'-v',
		`${input.roomDir}:${input.roomDir}`,
		'-v',
		`${privosSharedDir}:${privosSharedDir}:ro`,
		'-v',
		`${identityFile}:${identityFile}:ro`,
		'-v',
		`${input.bridgeNodeModulesDir}:${input.bridgeNodeModulesDir}:ro`,
		'-w',
		input.roomDir,
		'-e',
		`NODE_PATH=${input.bridgeNodeModulesDir}`,
	];
	if (input.homeDir) args.push('-v', `${input.homeDir}:${input.homeDir}`);
	// Name-only `-e KEY` (no `=value`): docker inherits each value from its own
	// process env (the bridge spawns `docker` with this same `input.env`), so the
	// bot token and other secrets never appear in the `docker run` argv (visible
	// via `ps`). Keeps the "token never in argv" invariant on the container path.
	for (const key of Object.keys(input.env)) args.push('-e', key);
	args.push(input.image, input.command, ...input.args);
	return args;
}
