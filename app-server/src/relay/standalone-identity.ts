/**
 * Standalone production identity: the file a self-hosted app persists after
 * pairing over the Relay WebSocket. It is the sole source of relay
 * credentials and Hub dispatch trust for `standalone-production` runtime
 * mode — apps must load it through {@link loadStandaloneIdentity} and never
 * hand-assemble `RuntimeDispatchTrustV3` from raw environment input.
 *
 * File discipline mirrors the Hub's own self-generated identity file: mode
 * `0600`, created with `wx` so an existing file is never silently
 * overwritten, and rotations rewrite it atomically (temp file + rename).
 */
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
	assertRuntimeDispatchTrustConfigurationV3,
	type RuntimeDispatchTrustV3,
} from '../workload/dispatch-assertion.js';

export const DEFAULT_STANDALONE_IDENTITY_FILE = './privos-standalone-identity.json';

const IDENTITY_REQUIRED_KEYS = [
	'pairingVersion',
	'relayUrl',
	'clientId',
	'clientSecret',
	'trust',
	'fingerprint',
	'pairedAt',
] as const;
const IDENTITY_OPTIONAL_KEYS = ['mcpAppId', 'rotatedAt', 'agentBotCredential'] as const;

export type StandaloneIdentityV2 = Readonly<{
	pairingVersion: 2;
	/** Origin the OAuth token + Relay WebSocket are reached at (http/https, no trailing slash). */
	relayUrl: string;
	clientId: string;
	clientSecret: string;
	/** Hub dispatch trust delivered at pairing; the sole input to `RuntimeDispatchTrustV3`. */
	trust: RuntimeDispatchTrustV3;
	/** `SHA256:<hubKid>` — operator-verifiable, SSH-host-key style. */
	fingerprint: string;
	mcpAppId?: string;
	/** Unix ms when this file was first written by pairing. */
	pairedAt: number;
	/** Unix ms of the most recent secret or trust rotation, if any. */
	rotatedAt?: number;
	/**
	 * The app's installation-bot credential, delivered over the standalone
	 * control channel and persisted here so it survives a restart. Opaque pair —
	 * never logged. Absent until Hub delivers it.
	 */
	agentBotCredential?: Readonly<{ botUserId: string; token: string }>;
}>;

export type LoadedStandaloneIdentity = Readonly<{
	filePath: string;
	identity: StandaloneIdentityV2;
	relay: Readonly<{ privosUrl: string; clientId: string; clientSecret: string }>;
	trust: RuntimeDispatchTrustV3;
	fingerprint: string;
}>;

export type StandaloneIdentityErrorCode =
	| 'IDENTITY_FILE_MISSING'
	| 'IDENTITY_FILE_MODE_INVALID'
	| 'IDENTITY_FILE_UNPARSEABLE'
	| 'IDENTITY_FILE_INVALID'
	| 'IDENTITY_FILE_ALREADY_EXISTS';

export class StandaloneIdentityError extends Error {
	constructor(
		public readonly code: StandaloneIdentityErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'StandaloneIdentityError';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
	const present = Object.keys(value);
	const allowed = new Set([...required, ...optional]);
	if (present.some((key) => !allowed.has(key))) return false;
	return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/** Renders an SSH-host-key-style fingerprint for out-of-band operator verification. */
export function standaloneHubFingerprint(hubKid: string): string {
	return `SHA256:${hubKid}`;
}

export function resolveIdentityFilePath(explicit?: string): string {
	return path.resolve(explicit ?? process.env.PRIVOS_STANDALONE_IDENTITY_FILE ?? DEFAULT_STANDALONE_IDENTITY_FILE);
}

/** Throws {@link StandaloneIdentityError} `IDENTITY_FILE_INVALID` describing exactly what failed. */
export function assertStandaloneIdentityShape(value: unknown): asserts value is StandaloneIdentityV2 {
	if (!isRecord(value) || !exactKeys(value, IDENTITY_REQUIRED_KEYS, IDENTITY_OPTIONAL_KEYS)) {
		throw new StandaloneIdentityError('IDENTITY_FILE_INVALID', 'Standalone identity file has an unexpected shape.');
	}
	if (
		value.pairingVersion !== 2 ||
		typeof value.relayUrl !== 'string' ||
		!value.relayUrl ||
		typeof value.clientId !== 'string' ||
		!value.clientId ||
		typeof value.clientSecret !== 'string' ||
		!value.clientSecret ||
		typeof value.fingerprint !== 'string' ||
		!value.fingerprint ||
		!Number.isFinite(value.pairedAt) ||
		(value.mcpAppId !== undefined && typeof value.mcpAppId !== 'string') ||
		(value.rotatedAt !== undefined && !Number.isFinite(value.rotatedAt))
	) {
		throw new StandaloneIdentityError('IDENTITY_FILE_INVALID', 'Standalone identity file has an invalid field.');
	}
	if (value.agentBotCredential !== undefined) {
		const credential = value.agentBotCredential;
		if (
			!isRecord(credential) ||
			Object.keys(credential).sort().join(',') !== 'botUserId,token' ||
			typeof credential.botUserId !== 'string' ||
			!credential.botUserId ||
			typeof credential.token !== 'string' ||
			!credential.token
		) {
			throw new StandaloneIdentityError('IDENTITY_FILE_INVALID', 'Standalone identity agentBotCredential is invalid.');
		}
	}
	try {
		new URL(value.relayUrl);
	} catch {
		throw new StandaloneIdentityError('IDENTITY_FILE_INVALID', 'Standalone identity relayUrl is not a valid URL.');
	}
	try {
		assertRuntimeDispatchTrustConfigurationV3(value.trust);
	} catch (error) {
		throw new StandaloneIdentityError(
			'IDENTITY_FILE_INVALID',
			`Standalone identity trust is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const trust = value.trust as RuntimeDispatchTrustV3;
	if (value.fingerprint !== standaloneHubFingerprint(trust.hubKid)) {
		throw new StandaloneIdentityError('IDENTITY_FILE_INVALID', 'Standalone identity fingerprint does not match the pinned hub key.');
	}
}

function assertSafeFileStat(stat: fsSync.Stats, filePath: string): void {
	const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
	const gid = typeof process.getgid === 'function' ? process.getgid() : stat.gid;
	if (!stat.isFile() || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o777) !== 0o600) {
		throw new StandaloneIdentityError(
			'IDENTITY_FILE_MODE_INVALID',
			`Standalone identity file ${filePath} must be an owner-only file at mode 0600 ` +
				`(found mode ${(stat.mode & 0o777).toString(8)}, uid ${stat.uid}, gid ${stat.gid}). ` +
				'Refusing to load a credential file that could be read or replaced by another user.',
		);
	}
}

/**
 * Loads, validates, and returns the standalone identity file. Refuses to load
 * (with a specific reason) a missing file, a file with unsafe permissions, or
 * unparseable/invalid content — never falls back to a relaxed mode.
 */
export function loadStandaloneIdentity(options?: { filePath?: string }): LoadedStandaloneIdentity {
	const filePath = resolveIdentityFilePath(options?.filePath);
	let stat: fsSync.Stats;
	try {
		stat = fsSync.lstatSync(filePath);
	} catch {
		throw new StandaloneIdentityError(
			'IDENTITY_FILE_MISSING',
			`No standalone identity file at ${filePath}. Pair with pairOverWebSocket first, or set PRIVOS_STANDALONE_IDENTITY_FILE.`,
		);
	}
	assertSafeFileStat(stat, filePath);
	let raw: string;
	try {
		raw = fsSync.readFileSync(filePath, 'utf8');
	} catch (error) {
		throw new StandaloneIdentityError('IDENTITY_FILE_UNPARSEABLE', `Failed to read standalone identity file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new StandaloneIdentityError('IDENTITY_FILE_UNPARSEABLE', `Standalone identity file ${filePath} is not valid JSON.`);
	}
	assertStandaloneIdentityShape(parsed);
	return Object.freeze({
		filePath,
		identity: parsed,
		relay: Object.freeze({ privosUrl: parsed.relayUrl, clientId: parsed.clientId, clientSecret: parsed.clientSecret }),
		trust: parsed.trust,
		fingerprint: parsed.fingerprint,
	});
}

/** True when a standalone identity file exists at the resolved path, without loading/validating it. */
export function standaloneIdentityFileExists(options?: { filePath?: string }): boolean {
	return fsSync.existsSync(resolveIdentityFilePath(options?.filePath));
}

async function assertSafeParentDirectory(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
}

/**
 * Persists a freshly-paired identity. Creates the file with `wx` (fails if it
 * already exists) at mode `0600` — the same discipline as the Hub's own
 * self-generated identity file. Re-pairing over an existing file requires the
 * operator to remove it first; rotation uses {@link rotateStandaloneIdentity}.
 */
export async function saveStandaloneIdentity(
	identity: StandaloneIdentityV2,
	options?: { filePath?: string },
): Promise<string> {
	assertStandaloneIdentityShape(identity);
	const filePath = resolveIdentityFilePath(options?.filePath);
	await assertSafeParentDirectory(path.dirname(filePath));
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(filePath, 'wx', 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			throw new StandaloneIdentityError(
				'IDENTITY_FILE_ALREADY_EXISTS',
				`Standalone identity file ${filePath} already exists. Remove it before re-pairing, or use rotation for an in-place credential change.`,
			);
		}
		throw error;
	}
	try {
		await handle.writeFile(`${JSON.stringify(identity, null, 2)}\n`, 'utf8');
		await handle.sync();
	} finally {
		await handle.close();
	}
	return filePath;
}

/**
 * Atomically rewrites the identity file (temp file + rename) — the durable
 * half of secret/trust rotation. `mutate` receives the currently persisted,
 * validated identity and must return the complete next identity; the result
 * is re-validated before it is written.
 */
export async function rotateStandaloneIdentity(
	mutate: (current: StandaloneIdentityV2) => StandaloneIdentityV2,
	options?: { filePath?: string },
): Promise<LoadedStandaloneIdentity> {
	const filePath = resolveIdentityFilePath(options?.filePath);
	const current = loadStandaloneIdentity({ filePath });
	const next = mutate(current.identity);
	assertStandaloneIdentityShape(next);
	const directory = path.dirname(filePath);
	await assertSafeParentDirectory(directory);
	const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	const handle = await fs.open(temporary, 'wx', 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await fs.rename(temporary, filePath);
		await fs.chmod(filePath, 0o600);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
	return loadStandaloneIdentity({ filePath });
}
