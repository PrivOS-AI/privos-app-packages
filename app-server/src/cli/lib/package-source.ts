import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Policy-violation codes surfaced by {@link packageSource}. Every code maps to
 * CLI exit code 2 ("blocked by policy") except `NOT_GIT_REPOSITORY` and
 * `GIT_ARCHIVE_FAILED`, which the caller treats as environment/usage problems.
 */
export type PackagePolicyCode =
	| 'NOT_GIT_REPOSITORY'
	| 'DIRTY_TREE'
	| 'CREDENTIAL_FILE_FOUND'
	| 'GIT_ARCHIVE_FAILED'
	| 'INVALID_ZIP'
	| 'MISSING_REQUIRED_ENTRY'
	| 'DENIED_PATH_IN_ARCHIVE'
	| 'ENTRY_LIMIT_EXCEEDED'
	| 'FILE_SIZE_EXCEEDED'
	| 'TOTAL_SIZE_EXCEEDED';

export class PackagePolicyError extends Error {
	constructor(message: string, public readonly code: PackagePolicyCode, public readonly details: readonly string[] = []) {
		super(message);
		this.name = 'PackagePolicyError';
	}
}

export type PackageSourceOptions = Readonly<{
	/** Directory the CLI was invoked from; resolved up to the git worktree root. */
	cwd: string;
	/** Package identity used to name the archive: `<outputDir>/<safeName>-<version>.zip`. */
	name: string;
	version: string;
	/** Refuse a dirty tree unless true (mirrors `scripts/package-source.sh`). */
	allowDirty: boolean;
	/** Relative to the git worktree root. Defaults to `dist-source`. */
	outputDir?: string;
}>;

export type ZipEntry = Readonly<{ name: string; uncompressedSize: number; isDirectory: boolean }>;

export type PackageSourceResult = Readonly<{
	archivePath: string;
	sha256: string;
	bytes: number;
	/** All central-directory entries, including directory entries (`unzip -Z1` parity). */
	entries: readonly string[];
	/** File entries only (directories filtered out) — the `paths` sent to the Portal upload session. */
	filePaths: readonly string[];
	/** `git rev-parse HEAD` of the worktree the archive was produced from. */
	gitRevision: string;
	repoRoot: string;
}>;

export const ENTRY_LIMIT = 20_000;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const REQUIRED_ROOT_ENTRIES = ['privos-app.json', 'Dockerfile'] as const;

// Mirrors the awk rules in `scripts/package-source.sh`'s `bad_entries` check.
const DENIED_DIR_PATTERN = /(^|\/)(node_modules|dist|dist-source|\.recyclebin|\.git)(\/|$)|(^|\/)\.privos\/skills(\/|$)/;
const DENIED_ENV_PATTERN = /(^|\/)\.env(\.|$)/;
const PARENT_TRAVERSAL_PATTERN = /\.\./;
const CREDENTIAL_ENTRY_PATTERN = /(^|\/)id_rsa|\.pem$|\.key$/;

export function isDeniedArchiveEntry(entryName: string): boolean {
	return (
		DENIED_DIR_PATTERN.test(entryName)
		|| DENIED_ENV_PATTERN.test(entryName)
		|| PARENT_TRAVERSAL_PATTERN.test(entryName)
		|| CREDENTIAL_ENTRY_PATTERN.test(entryName)
		|| entryName.toLowerCase().includes('credentials')
	);
}

/**
 * Reads entry names + uncompressed sizes from a ZIP's central directory —
 * the same source `unzip -Z1` reads from, never from `git ls-tree` (a git
 * tree cannot reflect `.gitattributes export-ignore` or `--allow-dirty`
 * untracked additions the way the produced archive does).
 */
export function readZipCentralDirectoryEntries(buffer: Buffer): ZipEntry[] {
	const EOCD_SIGNATURE = 0x06054b50;
	const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
	const EOCD_MIN_SIZE = 22;
	const MAX_COMMENT_SIZE = 65_535;

	let eocdOffset = -1;
	const searchFloor = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
	for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= searchFloor; offset -= 1) {
		if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
			eocdOffset = offset;
			break;
		}
	}
	if (eocdOffset < 0) throw new PackagePolicyError('Archive is not a valid ZIP file (no end-of-central-directory record found).', 'INVALID_ZIP');

	const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
	const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

	const entries: ZipEntry[] = [];
	let offset = centralDirectoryOffset;
	for (let index = 0; index < totalEntries; index += 1) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
			throw new PackagePolicyError('Archive central directory is corrupt or truncated.', 'INVALID_ZIP');
		}
		const uncompressedSize = buffer.readUInt32LE(offset + 24);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const nameStart = offset + 46;
		const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
		entries.push({ name, uncompressedSize, isDirectory: name.endsWith('/') });
		offset = nameStart + nameLength + extraLength + commentLength;
	}
	return entries;
}

/** Pure policy evaluation over an already-read entry list — kept separate from I/O for fast unit tests. */
export function evaluateArchiveEntries(entries: readonly ZipEntry[]): void {
	const names = entries.map((entry) => entry.name);
	for (const required of REQUIRED_ROOT_ENTRIES) {
		if (!names.includes(required)) {
			throw new PackagePolicyError(`Archive is missing required root entry: ${required}`, 'MISSING_REQUIRED_ENTRY', [required]);
		}
	}
	const denied = names.filter(isDeniedArchiveEntry);
	if (denied.length > 0) {
		throw new PackagePolicyError('Unsafe or denied paths found in source archive.', 'DENIED_PATH_IN_ARCHIVE', denied);
	}
	if (entries.length > ENTRY_LIMIT) {
		throw new PackagePolicyError(`Archive holds ${entries.length} entries; marketplace limit is ${ENTRY_LIMIT}.`, 'ENTRY_LIMIT_EXCEEDED');
	}
	const oversizedFiles = entries.filter((entry) => !entry.isDirectory && entry.uncompressedSize > MAX_FILE_BYTES).map((entry) => entry.name);
	if (oversizedFiles.length > 0) {
		throw new PackagePolicyError(`Archive contains file(s) exceeding the ${MAX_FILE_BYTES} byte per-file limit.`, 'FILE_SIZE_EXCEEDED', oversizedFiles);
	}
}

/** Recursively scans the worktree for credential-like files, mirroring the `find` guard in `scripts/package-source.sh`. */
export function findCredentialLikeFiles(root: string): string[] {
	const skipDirectories = new Set(['.git', 'node_modules', 'dist-source']);
	const matches: string[] = [];

	const walk = (dir: string): void => {
		let dirEntries: fs.Dirent[];
		try {
			dirEntries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of dirEntries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (skipDirectories.has(entry.name)) continue;
				walk(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			const name = entry.name;
			const lowerName = name.toLowerCase();
			const isDottedEnv = name.startsWith('.env.') && name !== '.env.example';
			const isPem = name.endsWith('.pem');
			const isKeyFile = name.endsWith('.key');
			const isIdRsa = name.startsWith('id_rsa');
			const isCredentialsFile = lowerName.includes('credentials');
			if (isDottedEnv || isPem || isKeyFile || isIdRsa || isCredentialsFile) {
				matches.push(path.relative(root, fullPath));
			}
		}
	};

	walk(root);
	return matches;
}

function runGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync('git', args, { cwd, env: env ?? process.env, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
	return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/**
 * Packages the git worktree at `options.cwd` into a zip archive, applying the
 * same safety policy as `scripts/package-source.sh` (dirty-tree refusal,
 * credential-file scan, denied-path/entry-count/size limits, required root
 * entries), and reads the produced archive's entries from its ZIP central
 * directory. Throws {@link PackagePolicyError} on any violation.
 */
export function packageSource(options: PackageSourceOptions): PackageSourceResult {
	const toplevel = runGit(['rev-parse', '--show-toplevel'], options.cwd);
	if (toplevel.status !== 0) {
		throw new PackagePolicyError(`Not inside a git repository: ${options.cwd}`, 'NOT_GIT_REPOSITORY');
	}
	const repoRoot = toplevel.stdout.trim();

	const headRevision = runGit(['rev-parse', 'HEAD'], repoRoot);
	if (headRevision.status !== 0) {
		throw new PackagePolicyError('Unable to resolve HEAD (repository has no commits).', 'NOT_GIT_REPOSITORY');
	}
	const gitRevision = headRevision.stdout.trim();

	if (!options.allowDirty) {
		const status = runGit(['status', '--porcelain', '--untracked-files=all'], repoRoot);
		if (status.stdout.trim().length > 0) {
			throw new PackagePolicyError(
				'Refusing to package a dirty tree. Commit intended source files, or inspect them and use --allow-dirty.',
				'DIRTY_TREE',
			);
		}
	}

	const credentialFiles = findCredentialLikeFiles(repoRoot);
	if (credentialFiles.length > 0) {
		throw new PackagePolicyError(
			'Unsafe credential-like files are present in the working tree. Move or remove them before packaging.',
			'CREDENTIAL_FILE_FOUND',
			credentialFiles,
		);
	}

	const outputDir = options.outputDir ?? 'dist-source';
	const outputDirAbsolute = path.join(repoRoot, outputDir);
	fs.mkdirSync(outputDirAbsolute, { recursive: true });
	const safeName = options.name.replaceAll('/', '-');
	const archivePath = path.join(outputDirAbsolute, `${safeName}-${options.version}.zip`);

	let treeish = 'HEAD';
	let tempIndexDir: string | undefined;
	try {
		if (options.allowDirty) {
			tempIndexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privos-app-package-source-'));
			const indexPath = path.join(tempIndexDir, 'index');
			const gitEnv = { ...process.env, GIT_INDEX_FILE: indexPath };
			const readTree = runGit(['read-tree', 'HEAD'], repoRoot, gitEnv);
			if (readTree.status !== 0) throw new PackagePolicyError(`git read-tree failed: ${readTree.stderr.trim()}`, 'GIT_ARCHIVE_FAILED');
			const addAll = runGit(['add', '--all'], repoRoot, gitEnv);
			if (addAll.status !== 0) throw new PackagePolicyError(`git add --all failed: ${addAll.stderr.trim()}`, 'GIT_ARCHIVE_FAILED');
			const writeTree = runGit(['write-tree'], repoRoot, gitEnv);
			if (writeTree.status !== 0) throw new PackagePolicyError(`git write-tree failed: ${writeTree.stderr.trim()}`, 'GIT_ARCHIVE_FAILED');
			treeish = writeTree.stdout.trim();
		}

		fs.rmSync(archivePath, { force: true });
		const archiveResult = runGit(['archive', '--format=zip', `--output=${archivePath}`, treeish], repoRoot);
		if (archiveResult.status !== 0) {
			throw new PackagePolicyError(`git archive failed: ${archiveResult.stderr.trim()}`, 'GIT_ARCHIVE_FAILED');
		}
	} finally {
		if (tempIndexDir) fs.rmSync(tempIndexDir, { recursive: true, force: true });
	}

	const archiveBuffer = fs.readFileSync(archivePath);
	try {
		const zipEntries = readZipCentralDirectoryEntries(archiveBuffer);
		evaluateArchiveEntries(zipEntries);
		if (archiveBuffer.length > MAX_TOTAL_BYTES) {
			throw new PackagePolicyError(`Archive is ${archiveBuffer.length} bytes; marketplace limit is ${MAX_TOTAL_BYTES} bytes.`, 'TOTAL_SIZE_EXCEEDED');
		}

		const sha256 = crypto.createHash('sha256').update(archiveBuffer).digest('hex');
		return {
			archivePath,
			sha256,
			bytes: archiveBuffer.length,
			entries: zipEntries.map((entry) => entry.name),
			filePaths: zipEntries.filter((entry) => !entry.isDirectory).map((entry) => entry.name),
			gitRevision,
			repoRoot,
		};
	} catch (error) {
		fs.rmSync(archivePath, { force: true });
		throw error;
	}
}
