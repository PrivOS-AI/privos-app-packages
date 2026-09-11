/**
 * Builds the actual wrapped `{command, args, env}` for `wrap`/`container` —
 * shared by the self-test (`self-test.ts`) and the real per-room process
 * factory (`cli.ts`/`adapter-pool.ts`), so the exact same invocation that was
 * validated is the one that runs turns. Split out of `index.ts` so both that
 * module and `self-test.ts` can import it without a circular dependency.
 */
import { platform } from 'node:process';
import { buildSeatbeltProfile } from './seatbelt-profile.js';
import { buildBwrapArgs, BWRAP_EXTRA_ENV } from './bwrap-args.js';
import { buildContainerRunArgs } from './container-run.js';

export interface WrappedSpawn {
	command: string;
	args: string[];
	/** Extra env for the wrapper itself (e.g. bwrap's `PYTHONDONTWRITEBYTECODE`); merged under the caller's own env. */
	env: Record<string, string>;
}

export interface WrapCommandParams {
	level: 'wrap' | 'container';
	workspaceDir: string;
	roomId: string;
	roomDir: string;
	homeDir: string | undefined;
	realHomeDir: string;
	bridgeNodeModulesDir: string;
	containerImage: string;
	command: string;
	args: string[];
	env: Record<string, string>;
}

/** Throws if the platform has no implementation for `wrap` (macOS `sandbox-exec` / Linux `bwrap` only). */
export function wrapCommand(params: WrapCommandParams): WrappedSpawn {
	if (params.level === 'container') {
		return {
			command: 'docker',
			args: buildContainerRunArgs({
				roomId: params.roomId,
				workspaceDir: params.workspaceDir,
				roomDir: params.roomDir,
				homeDir: params.homeDir,
				bridgeNodeModulesDir: params.bridgeNodeModulesDir,
				image: params.containerImage,
				command: params.command,
				args: params.args,
				env: params.env,
			}),
			env: {},
		};
	}
	if (platform === 'darwin') {
		const profile = buildSeatbeltProfile({
			workspaceDir: params.workspaceDir,
			roomDir: params.roomDir,
			homeDir: params.homeDir,
			realHomeDir: params.realHomeDir,
		});
		return { command: 'sandbox-exec', args: ['-p', profile, params.command, ...params.args], env: {} };
	}
	if (platform === 'linux') {
		const bwrapArgs = buildBwrapArgs({
			workspaceDir: params.workspaceDir,
			roomDir: params.roomDir,
			homeDir: params.homeDir,
			realHomeDir: params.realHomeDir,
		});
		return { command: 'bwrap', args: [...bwrapArgs, '--', params.command, ...params.args], env: BWRAP_EXTRA_ENV };
	}
	throw new Error(`isolation "wrap" has no OS sandbox implementation on platform "${platform}" (macOS sandbox-exec / Linux bwrap only)`);
}
