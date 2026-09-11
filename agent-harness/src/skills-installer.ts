/**
 * Installs the PrivOS skills bundle (a `.tgz` served by the hub, proxied
 * from the tenant's PrivOS Sandbox — see `agent-harness-skills-bundle.ts` in
 * privos-hub) into the harness workspace.
 *
 * Hardened extraction (plan.md red-team pass 2, D1): entries are parsed and
 * fully validated — relative path, no `..`, no symlink/hardlink, entry-count
 * and uncompressed-size caps, and a per-file sha256 check against the
 * bundle's own `MANIFEST.json` — entirely in memory before a single byte
 * touches disk. Only after every entry verifies are files staged under a
 * temp directory inside `.privos/` and atomically swapped into place per
 * skill, so a hostile or truncated bundle leaves the workspace untouched.
 *
 * Materializes into `<workspaceDir>` today (single shared workspace, Phase 4
 * baseline). Every write here takes an explicit target directory rather than
 * assuming `workspaceDir` internally, so Phase 8's per-room
 * `rooms/<roomId>/` layout can call the same functions with a room dir
 * without changing this file.
 */
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	renameSync,
	readFileSync,
	writeFileSync,
	chmodSync,
	readdirSync,
	symlinkSync,
	lstatSync,
	statSync,
	cpSync,
	unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, extname, dirname, relative } from 'node:path';
import * as tar from 'tar';

const MAX_ENTRIES = 500;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_PREFIXES = ['skills/', 'agent-room/skills/', 'skill-sdk/'];
const EXECUTABLE_EXTENSIONS = new Set(['.js', '.sh', '.py']);
const SKILLS_MANIFEST_STATE_FILE = '.skills-manifest.json';

export class HostileBundleError extends Error {}
export class SkillsLocallyModifiedError extends Error {
	constructor(public readonly conflicts: string[]) {
		super(`Local modifications detected in: ${conflicts.join(', ')}. Re-run "skills update --force" to overwrite them.`);
	}
}
export class SkillsUpdateBusyError extends Error {
	constructor(public readonly busyRoomIds: string[]) {
		super(`Refusing to update the shared skills bundle while a turn is in flight in room(s): ${busyRoomIds.join(', ')}. Try again once they are idle.`);
	}
}

export interface TemplateSkillsManifestFile {
	path: string;
	sha256: string;
}

export interface TemplateSkillsManifest {
	sandboxVersion: string;
	builtAt: string;
	skills: { name: string; files: string[]; sha256: string }[];
	allFiles: TemplateSkillsManifestFile[];
}

interface ParsedEntry {
	/** Path exactly as it appears in the tar, e.g. `skills/privos-chat/SKILL.md`. */
	archivePath: string;
	data: Buffer;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Fetches a skills bundle. Returns `undefined` (never throws) on a 503
 * (`skills_bundle_unavailable` — no workspace sandbox configured) or any
 * other non-2xx/network failure, so callers can treat a missing bundle as
 * "skip for now" rather than a fatal error.
 */
export async function downloadSkillsBundle(url: string, headers: Record<string, string> = {}): Promise<Buffer | undefined> {
	let res: Response;
	try {
		res = await fetch(url, { headers });
	} catch {
		return undefined;
	}
	if (!res.ok) {
		await res.body?.cancel().catch(() => undefined);
		return undefined;
	}
	const reader = res.body?.getReader();
	if (!reader) return undefined;
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		// eslint-disable-next-line no-await-in-loop
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_DOWNLOAD_BYTES) {
			await reader.cancel().catch(() => undefined);
			return undefined;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

// ---------------------------------------------------------------------------
// Hardened parse + validate (in memory, before any disk write)
// ---------------------------------------------------------------------------

function validateArchivePath(rawPath: string): string {
	if (!rawPath || rawPath.includes('\0') || rawPath.includes('\\') || rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath)) {
		throw new HostileBundleError(`Unsafe archive entry: ${rawPath}`);
	}
	const segments = rawPath.split('/').filter((s) => s.length > 0);
	if (segments.some((s) => s === '..' || s === '.')) {
		throw new HostileBundleError(`Unsafe archive entry: ${rawPath}`);
	}
	const normalized = segments.join('/');
	if (!normalized || !ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ) {
		if (normalized !== 'MANIFEST.json') throw new HostileBundleError(`Archive entry outside allowed roots: ${rawPath}`);
	}
	return normalized;
}

/**
 * Parses and fully validates a `.tgz` bundle: entry type/path/count/size caps,
 * then a per-file sha256 check against the bundle's own `MANIFEST.json`.
 * Returns every verified file entry plus the parsed manifest. Throws
 * `HostileBundleError` on the first violation — nothing is written to disk
 * by this function.
 */
export async function parseAndVerifyBundle(buffer: Buffer): Promise<{ entries: ParsedEntry[]; manifest: TemplateSkillsManifest }> {
	const entries: ParsedEntry[] = [];
	let entryCount = 0;
	let totalBytes = 0;
	let violation: Error | undefined;

	const parser = new tar.Parser({
		strict: true,
		onReadEntry: (entry: any) => {
			entryCount += 1;
			if (entryCount > MAX_ENTRIES) {
				violation ??= new HostileBundleError(`Archive has more than ${MAX_ENTRIES} entries`);
				entry.resume();
				return;
			}
			if (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'Directory') {
				violation ??= new HostileBundleError(`Unsafe archive entry type (${entry.type}): ${entry.path}`);
				entry.resume();
				return;
			}
			// Directory entries (`skills/`, `skills/<name>/`) are never written —
			// only file entries are materialized — so they skip path validation,
			// which would otherwise reject the bare `skills` root as "outside".
			if (entry.type === 'Directory') {
				entry.resume();
				return;
			}
			let archivePath: string;
			try {
				archivePath = validateArchivePath(entry.path);
			} catch (err) {
				violation ??= err as Error;
				entry.resume();
				return;
			}
			const chunks: Buffer[] = [];
			entry.on('data', (chunk: Buffer) => {
				totalBytes += chunk.length;
				if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
					violation ??= new HostileBundleError(`Archive exceeds ${MAX_TOTAL_UNCOMPRESSED_BYTES} uncompressed bytes`);
				}
				chunks.push(chunk);
			});
			entry.on('end', () => {
				entries.push({ archivePath, data: Buffer.concat(chunks) });
			});
		},
	});

	await new Promise<void>((resolve, reject) => {
		parser.once('end', resolve);
		parser.once('error', (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
		try {
			// `gzip: true` auto-detects; the bundle is always gzip'd, but feeding
			// a plain (ungzipped) tar to a gzip-expecting parser throws cleanly
			// rather than silently misreading, which is what we want here.
			parser.end(buffer);
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
	if (violation) throw violation;

	const manifestEntry = entries.find((e) => e.archivePath === 'MANIFEST.json');
	if (!manifestEntry) throw new HostileBundleError('Archive is missing MANIFEST.json');
	let manifest: TemplateSkillsManifest;
	try {
		manifest = JSON.parse(manifestEntry.data.toString('utf-8')) as TemplateSkillsManifest;
	} catch {
		throw new HostileBundleError('MANIFEST.json is not valid JSON');
	}
	if (typeof manifest.sandboxVersion !== 'string' || !Array.isArray(manifest.allFiles)) {
		throw new HostileBundleError('MANIFEST.json is malformed');
	}

	const expectedByPath = new Map(manifest.allFiles.map((f) => [f.path, f.sha256]));
	for (const entry of entries) {
		if (entry.archivePath === 'MANIFEST.json') continue;
		const expected = expectedByPath.get(entry.archivePath);
		if (!expected) throw new HostileBundleError(`Archive entry not listed in MANIFEST.json: ${entry.archivePath}`);
		const actual = createHash('sha256').update(entry.data).digest('hex');
		if (actual !== expected) throw new HostileBundleError(`sha256 mismatch for ${entry.archivePath}`);
	}

	return { entries, manifest };
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

function modeFor(filePath: string): number {
	return EXECUTABLE_EXTENSIONS.has(extname(filePath)) ? 0o755 : 0o644;
}

/** Maps an archive path to `{ destRoot: 'skills' | 'skill-sdk', canonicalPath }` under `.privos/`. */
function destinationFor(archivePath: string): { destRoot: 'skills' | 'skill-sdk'; canonicalPath: string } | undefined {
	if (archivePath.startsWith('skills/')) {
		return { destRoot: 'skills', canonicalPath: archivePath.slice('skills/'.length) };
	}
	if (archivePath.startsWith('agent-room/skills/')) {
		return { destRoot: 'skills', canonicalPath: archivePath.slice('agent-room/skills/'.length) };
	}
	if (archivePath.startsWith('skill-sdk/')) {
		return { destRoot: 'skill-sdk', canonicalPath: archivePath.slice('skill-sdk/'.length) };
	}
	return undefined;
}

interface PrivosSkillsState {
	sandboxVersion: string;
	/** canonicalPath ('skills/<name>/rel' or 'skill-sdk/rel') -> sha256, as last installed. */
	files: Record<string, string>;
}

function statePath(workspaceDir: string): string {
	return join(workspaceDir, '.privos', SKILLS_MANIFEST_STATE_FILE);
}

function readState(workspaceDir: string): PrivosSkillsState | undefined {
	const path = statePath(workspaceDir);
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, 'utf-8')) as PrivosSkillsState;
	} catch {
		return undefined;
	}
}

function writeState(workspaceDir: string, state: PrivosSkillsState): void {
	mkdirSync(join(workspaceDir, '.privos'), { recursive: true });
	writeFileSync(statePath(workspaceDir), JSON.stringify(state, null, 2), { mode: 0o644 });
}

// ---------------------------------------------------------------------------
// Phase 8: cross-process "a room has a turn in flight" marker
// ---------------------------------------------------------------------------
// `skills update` is normally run as a SEPARATE `privos-agent-harness`
// invocation while `start` keeps serving turns in another process, so the
// in-flight state has to cross a process boundary — a small JSON file is the
// simplest thing that works. Entries older than the stale cutoff are ignored,
// so a bridge that crashed mid-turn never wedges `skills update` forever.

const BUSY_ROOMS_FILE = '.busy-rooms.json';
const BUSY_ROOM_STALE_MS = 30 * 60 * 1000;

function busyRoomsPath(workspaceDir: string): string {
	return join(workspaceDir, '.privos', BUSY_ROOMS_FILE);
}

function readBusyRoomsMap(workspaceDir: string): Record<string, number> {
	const path = busyRoomsPath(workspaceDir);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, number>;
	} catch {
		return {};
	}
}

/** Called by the running `start` process on every room busy/idle transition (`AdapterPool.onBusyChange`). */
export function setRoomBusy(workspaceDir: string, roomId: string, busy: boolean): void {
	const map = readBusyRoomsMap(workspaceDir);
	if (busy) map[roomId] = Date.now();
	else delete map[roomId];
	mkdirSync(join(workspaceDir, '.privos'), { recursive: true });
	writeFileSync(busyRoomsPath(workspaceDir), JSON.stringify(map));
}

/** Called by `skills update` (any process) before touching the shared bundle. */
export function listBusyRooms(workspaceDir: string): string[] {
	const now = Date.now();
	return Object.entries(readBusyRoomsMap(workspaceDir))
		.filter(([, since]) => now - since < BUSY_ROOM_STALE_MS)
		.map(([roomId]) => roomId);
}

export interface SkillsInstallResult {
	/** `false` only for a true no-op: `update` mode, same `sandboxVersion`, nothing written. */
	installed: boolean;
	sandboxVersion: string;
	skillNames: string[];
}

/**
 * Installs (or updates) the skills bundle into `<workspaceDir>/.privos/`.
 *
 * `mode: 'install'` never refuses on local modifications (there is nothing
 * to protect on a first install). `mode: 'update'` short-circuits to a no-op
 * when the installed `sandboxVersion` already matches, and otherwise refuses
 * — throwing `SkillsLocallyModifiedError` — when a previously-installed file
 * was changed on disk since the last install/update, unless `force` is set.
 */
export async function installSkillsBundle(
	buffer: Buffer,
	workspaceDir: string,
	opts: { mode: 'install' | 'update'; force?: boolean },
): Promise<SkillsInstallResult> {
	const { entries, manifest } = await parseAndVerifyBundle(buffer);
	const previousState = readState(workspaceDir);

	if (opts.mode === 'update' && previousState?.sandboxVersion === manifest.sandboxVersion && !opts.force) {
		return { installed: false, sandboxVersion: manifest.sandboxVersion, skillNames: manifest.skills.map((s) => s.name) };
	}

	// The atomic per-directory swap below is visible to every running room's
	// process the instant it happens; refuse while any room has a turn in
	// flight rather than mutate `.privos/skills` under it.
	if (opts.mode === 'update') {
		const busyRoomIds = listBusyRooms(workspaceDir);
		if (busyRoomIds.length > 0) throw new SkillsUpdateBusyError(busyRoomIds);
	}

	const materialized = entries
		.map((entry) => {
			const dest = destinationFor(entry.archivePath);
			return dest ? { ...dest, data: entry.data } : undefined;
		})
		.filter((v): v is { destRoot: 'skills' | 'skill-sdk'; canonicalPath: string; data: Buffer } => v !== undefined);

	if (opts.mode === 'update' && previousState && !opts.force) {
		const conflicts: string[] = [];
		for (const item of materialized) {
			const stateKey = `${item.destRoot}/${item.canonicalPath}`;
			const previousDigest = previousState.files[stateKey];
			if (!previousDigest) continue; // new file — not a conflict
			const finalPath = join(workspaceDir, '.privos', item.destRoot, item.canonicalPath);
			if (!existsSync(finalPath)) continue; // was recorded but is gone — nothing to conflict with
			const onDisk = createHash('sha256').update(readFileSync(finalPath)).digest('hex');
			if (onDisk !== previousDigest) conflicts.push(stateKey);
		}
		if (conflicts.length > 0) throw new SkillsLocallyModifiedError(conflicts);
	}

	const privosDir = join(workspaceDir, '.privos');
	mkdirSync(privosDir, { recursive: true });
	const stagingDir = mkdtempSync(join(privosDir, '.skills-install-'));
	try {
		const skillDirsStaged = new Set<string>();
		for (const item of materialized) {
			const stagedPath = join(stagingDir, item.destRoot, item.canonicalPath);
			mkdirSync(dirname(stagedPath), { recursive: true });
			writeFileSync(stagedPath, item.data);
			chmodSync(stagedPath, modeFor(stagedPath));
			if (item.destRoot === 'skills') skillDirsStaged.add(item.canonicalPath.split('/')[0]!);
		}

		// Atomic per-directory swap: remove the old copy (if any) then rename
		// the freshly-verified staged copy into place. `skill-sdk` is a single
		// small directory swapped the same way.
		for (const name of skillDirsStaged) {
			const finalPath = join(privosDir, 'skills', name);
			const stagedPath = join(stagingDir, 'skills', name);
			rmSync(finalPath, { recursive: true, force: true });
			mkdirSync(dirname(finalPath), { recursive: true });
			renameSync(stagedPath, finalPath);
		}
		if (existsSync(join(stagingDir, 'skill-sdk'))) {
			const finalPath = join(privosDir, 'skill-sdk');
			rmSync(finalPath, { recursive: true, force: true });
			renameSync(join(stagingDir, 'skill-sdk'), finalPath);
		}
	} finally {
		rmSync(stagingDir, { recursive: true, force: true });
	}

	const files: Record<string, string> = {};
	for (const entry of entries) {
		if (entry.archivePath === 'MANIFEST.json') continue;
		const dest = destinationFor(entry.archivePath);
		if (!dest) continue;
		files[`${dest.destRoot}/${dest.canonicalPath}`] = createHash('sha256').update(entry.data).digest('hex');
	}
	writeState(workspaceDir, { sandboxVersion: manifest.sandboxVersion, files });
	ensureClaudeSkillsAlias(workspaceDir);
	writeWorkspaceInstructions(workspaceDir);

	return { installed: true, sandboxVersion: manifest.sandboxVersion, skillNames: manifest.skills.map((s) => s.name) };
}

/** Reads the last-installed manifest snapshot, for `skills list`. Returns `undefined` when nothing is installed. */
export function listInstalledSkills(workspaceDir: string): { sandboxVersion: string; skillNames: string[] } | undefined {
	const state = readState(workspaceDir);
	if (!state) return undefined;
	const skillNames = new Set<string>();
	for (const key of Object.keys(state.files)) {
		if (!key.startsWith('skills/')) continue;
		const name = key.slice('skills/'.length).split('/')[0];
		if (name) skillNames.add(name);
	}
	return { sandboxVersion: state.sandboxVersion, skillNames: [...skillNames].sort() };
}

/**
 * `.claude/skills` -> `.privos/skills` alias, mirroring the sandbox's own
 * convention (`minio-pull-queue.ts` / `ensurePrivosDirAliases`). A symlink on
 * POSIX; a one-time recursive copy on Windows, refreshed on every install so
 * it never drifts far behind (ponytail: not a live mirror — re-run `skills
 * update` after a manual change to `.privos/skills` on Windows). Skips
 * silently when `.claude/skills` already exists as a real (non-symlink)
 * directory or file — never clobbers something a user put there.
 */
export function ensureClaudeSkillsAlias(workspaceDir: string): void {
	const claudeSkillsPath = join(workspaceDir, '.claude', 'skills');
	const privosSkillsPath = join(workspaceDir, '.privos', 'skills');
	mkdirSync(join(workspaceDir, '.claude'), { recursive: true });

	const existingStat = lstatSync(claudeSkillsPath, { throwIfNoEntry: false });
	if (existingStat) {
		if (!existingStat.isSymbolicLink()) return; // a real dir/file the user created — leave it alone
		unlinkSync(claudeSkillsPath);
	}

	if (process.platform === 'win32') {
		cpSync(privosSkillsPath, claudeSkillsPath, { recursive: true, force: true });
		return;
	}
	symlinkSync(relative(join(workspaceDir, '.claude'), privosSkillsPath), claudeSkillsPath, 'dir');
}

function workspaceInstructionsTemplate(): string {
	const templatePath = fileURLToPath(new URL('../templates/workspace-instructions.md', import.meta.url));
	return readFileSync(templatePath, 'utf-8');
}

/** Renders `CLAUDE.md` + `AGENTS.md` (identical content) at the workspace root. Always overwrites — these are bridge-managed. */
export function writeWorkspaceInstructions(workspaceDir: string): void {
	const content = workspaceInstructionsTemplate();
	writeFileSync(join(workspaceDir, 'CLAUDE.md'), content);
	writeFileSync(join(workspaceDir, 'AGENTS.md'), content);
}

// ---------------------------------------------------------------------------
// Phase 8: workspace root + per-room materialization
// ---------------------------------------------------------------------------

const ROOM_PRUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ROOM_PRUNE_MAX_COUNT = 200;

/**
 * Ensures the workspace-root shape every room links back into:
 * `.privos/` (skills, installed separately), `rooms/`, and an agent-global
 * `IDENTITY.md` placeholder (never overwritten here — `writeIdentityFile`
 * owns updates once the hub actually sends identity content).
 */
export function materializeWorkspaceRoot(workspaceDir: string): void {
	mkdirSync(join(workspaceDir, '.privos'), { recursive: true });
	mkdirSync(join(workspaceDir, 'rooms'), { recursive: true });
	const identityPath = join(workspaceDir, 'IDENTITY.md');
	if (!existsSync(identityPath)) writeFileSync(identityPath, '# Agent Identity\n\n(not yet set by the hub)\n');
}

/**
 * Refreshes `<workspaceDir>/IDENTITY.md` — agent-global, one file, read-only
 * from every room (D1) — only when the content actually changed, so a
 * no-op turn never touches its mtime.
 */
export function writeIdentityFile(workspaceDir: string, content: string): void {
	const path = join(workspaceDir, 'IDENTITY.md');
	const existing = existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
	if (existing === content) return;
	writeFileSync(path, content);
}

/**
 * `<roomDir>/.privos/{skills,skill-sdk}` -> symlinks (junctions on Windows,
 * never copies — L1) into the shared, workspace-root install. Refreshed on
 * every call so a moved workspace never leaves a stale link; a no-op until
 * the shared bundle is actually installed. Mirrors `ensureClaudeSkillsAlias`'s
 * "leave real user content alone" rule.
 */
function ensureRoomSharedLink(roomDir: string, workspaceDir: string, name: 'skills' | 'skill-sdk'): void {
	const linkPath = join(roomDir, '.privos', name);
	const targetPath = join(workspaceDir, '.privos', name);
	if (!existsSync(targetPath)) return;
	mkdirSync(dirname(linkPath), { recursive: true });

	const existingStat = lstatSync(linkPath, { throwIfNoEntry: false });
	if (existingStat) {
		if (process.platform === 'win32') {
			// Junctions report as regular directories on Windows (no
			// `isSymbolicLink()` signal) — always safe to recreate since this
			// function is the only writer of `<roomDir>/.privos/<name>`.
			rmSync(linkPath, { recursive: true, force: true });
		} else if (existingStat.isSymbolicLink()) {
			unlinkSync(linkPath);
		} else {
			return; // a real dir/file the user created — leave it alone
		}
	}
	if (process.platform === 'win32') {
		symlinkSync(targetPath, linkPath, 'junction'); // junctions require an absolute target
	} else {
		symlinkSync(relative(dirname(linkPath), targetPath), linkPath, 'dir');
	}
}

function roomInstructionsContent(roomId: string): string {
	return `${workspaceInstructionsTemplate()}\n## Room boundary\n\nThis directory is room \`${roomId}\`; you cannot read or write other rooms.\n`;
}

/**
 * Materializes (or refreshes) `rooms/<roomId>/`: shared skills links, the
 * `.claude/skills` alias, and room `CLAUDE.md`/`AGENTS.md`. Returns the room
 * directory. Adapter-specific state (`.home/`, native-sandbox config) is
 * seeded separately by `adapter-state.ts` / `ADAPTER_TABLE[...].writeNativeSandboxConfig`
 * — this function only owns the generic, adapter-agnostic room shape.
 */
export function materializeRoomDir(workspaceDir: string, roomId: string): string {
	const roomDir = join(workspaceDir, 'rooms', roomId);
	mkdirSync(roomDir, { recursive: true });
	ensureRoomSharedLink(roomDir, workspaceDir, 'skills');
	ensureRoomSharedLink(roomDir, workspaceDir, 'skill-sdk');
	ensureClaudeSkillsAlias(roomDir);
	const content = roomInstructionsContent(roomId);
	writeFileSync(join(roomDir, 'CLAUDE.md'), content);
	writeFileSync(join(roomDir, 'AGENTS.md'), content);
	return roomDir;
}

/**
 * Prunes `rooms/<roomId>/` directories like sessions (newest 200 / 30 days —
 * mirrors `session-store.ts`'s cutoff), skipping any room with a live
 * process. Recency is the directory's own mtime, which `writeHarnessEnvFile`
 * bumps on every spawn. Removing a room directory also removes its `.home/`
 * (adapter state and transcripts), since it lives underneath it.
 */
export function pruneRoomDirs(workspaceDir: string, liveRoomIds: ReadonlySet<string>): void {
	const roomsRoot = join(workspaceDir, 'rooms');
	if (!existsSync(roomsRoot)) return;
	const now = Date.now();
	const entries = readdirSync(roomsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const full = join(roomsRoot, entry.name);
			let mtimeMs = 0;
			try {
				mtimeMs = statSync(full).mtimeMs;
			} catch {
				/* entry removed concurrently — treat as oldest, pruned below */
			}
			return { roomId: entry.name, full, mtimeMs };
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	entries.forEach((entry, index) => {
		if (liveRoomIds.has(entry.roomId)) return;
		const withinCount = index < ROOM_PRUNE_MAX_COUNT;
		const withinAge = now - entry.mtimeMs < ROOM_PRUNE_MAX_AGE_MS;
		if (withinCount && withinAge) return;
		rmSync(entry.full, { recursive: true, force: true });
	});
}

// ---------------------------------------------------------------------------
// .env writer
// ---------------------------------------------------------------------------

export interface HarnessEnvValues {
	PRIVOS_URL: string;
	PRIVOS_BOT_KEY: string;
	PRIVOS_BOT_ID: string;
	PRIVOS_ROOM_ID: string;
	PRIVOS_PROJECT_ID: string;
	PRIVOS_CONNECT_URL?: string;
}

/**
 * Writes `.env` (0600) at `targetDir` — informational for humans and any
 * script that sources it; the skills themselves read process env, set
 * directly on the adapter subprocess (`cli.ts` `runStart`). Rewrites every
 * `PRIVOS_*` key on each call so a rotated credential never lingers, while
 * preserving blank lines, comments, and any non-`PRIVOS_*` line a user added
 * by hand. `targetDir` is the workspace root today; Phase 8 calls this once
 * per `rooms/<roomId>/` directory instead — nothing here assumes a single
 * fixed location.
 */
export function writeHarnessEnvFile(targetDir: string, values: HarnessEnvValues): void {
	const envPath = join(targetDir, '.env');
	const existingLines = existsSync(envPath) ? readFileSync(envPath, 'utf-8').split('\n') : [];
	const preserved = existingLines.filter((line) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) return true;
		const key = trimmed.split('=')[0]?.trim();
		return !key?.startsWith('PRIVOS_');
	});
	const canonicalLines = Object.entries(values)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([key, value]) => `${key}=${value}`);
	mkdirSync(targetDir, { recursive: true });
	writeFileSync(join(targetDir, '.env'), `${[...canonicalLines, ...preserved].join('\n')}\n`, { mode: 0o600 });
	chmodSync(envPath, 0o600);
}

// ---------------------------------------------------------------------------
// Dev override: build a bundle-shaped buffer from a local sandbox checkout
// ---------------------------------------------------------------------------

function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	if (!existsSync(dir)) return out;
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) out.push(full);
		}
	};
	walk(dir);
	return out;
}

/**
 * Builds a bundle buffer (same shape the hub serves) directly from a local
 * `privos-sandbox` checkout, for `--skills-dir <dir>` — the developer
 * override the plan calls for so a skill author can iterate without a live
 * hub/sandbox round trip. Never used in production: the hub-served bundle
 * (with the tenant's real `sandboxVersion`) is always preferred.
 */
export async function buildBundleFromLocalCheckout(sandboxCheckoutDir: string): Promise<Buffer> {
	const templateRoot = join(sandboxCheckoutDir, 'src', 'hooks', 'template');
	const skillsRoot = join(templateRoot, 'skills');
	const agentRoomSkillsRoot = join(templateRoot, 'agent-room', 'skills');
	const skillSdkSrc = join(sandboxCheckoutDir, 'packages', 'skill-sdk', 'lib', 'privos_skill.py');

	const stagingDir = mkdtempSync(join(tmpdir(), 'privos-skills-dev-bundle-'));
	try {
		const allFiles: TemplateSkillsManifestFile[] = [];
		const skills: TemplateSkillsManifest['skills'] = [];

		const stageTree = (root: string, archivePrefix: string) => {
			if (!existsSync(root)) return;
			for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
				if (!entry.isDirectory()) continue;
				const skillDir = join(root, entry.name);
				const files: TemplateSkillsManifestFile[] = [];
				for (const filePath of listFilesRecursive(skillDir)) {
					const archivePath = [archivePrefix, entry.name, relative(skillDir, filePath).split('\\').join('/')].join('/');
					const destPath = join(stagingDir, archivePath);
					mkdirSync(dirname(destPath), { recursive: true });
					const data = readFileSync(filePath);
					writeFileSync(destPath, data);
					chmodSync(destPath, modeFor(destPath));
					const file = { path: `skills/${entry.name}/${relative(skillDir, filePath).split('\\').join('/')}`, sha256: createHash('sha256').update(data).digest('hex') };
					files.push(file);
					allFiles.push(file);
				}
				skills.push({ name: entry.name, files: files.map((f) => f.path), sha256: createHash('sha256').update(files.map((f) => `${f.path}:${f.sha256}`).sort().join('\n')).digest('hex') });
			}
		};
		stageTree(skillsRoot, 'skills');
		stageTree(agentRoomSkillsRoot, 'agent-room/skills');

		if (existsSync(skillSdkSrc)) {
			const destPath = join(stagingDir, 'skill-sdk', 'privos_skill.py');
			mkdirSync(dirname(destPath), { recursive: true });
			const data = readFileSync(skillSdkSrc);
			writeFileSync(destPath, data);
			chmodSync(destPath, 0o755);
			allFiles.push({ path: 'skill-sdk/privos_skill.py', sha256: createHash('sha256').update(data).digest('hex') });
		}

		const manifest: TemplateSkillsManifest = { sandboxVersion: 'local-dev', builtAt: new Date().toISOString(), skills, allFiles };
		writeFileSync(join(stagingDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));

		const tarEntries = ['MANIFEST.json'];
		if (existsSync(join(stagingDir, 'skills'))) tarEntries.push('skills');
		if (existsSync(join(stagingDir, 'agent-room'))) tarEntries.push('agent-room');
		if (existsSync(join(stagingDir, 'skill-sdk'))) tarEntries.push('skill-sdk');

		return await new Promise<Buffer>((resolve, reject) => {
			const chunks: Buffer[] = [];
			const stream = tar.c({ gzip: true, cwd: stagingDir, portable: true }, tarEntries);
			stream.on('data', (chunk: Buffer) => chunks.push(chunk));
			stream.on('end', () => resolve(Buffer.concat(chunks)));
			stream.on('error', (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
		});
	} finally {
		rmSync(stagingDir, { recursive: true, force: true });
	}
}
