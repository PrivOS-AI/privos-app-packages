import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';

import { loadManifest, loadPackageJson, assertIdentityAgreement, structuralLint, ManifestLoadError } from '../lib/manifest.js';
import { packageSource, PackagePolicyError } from '../lib/package-source.js';
import { PortalClient, PortalError } from '../lib/portal-client.js';
import { createAuthorization, waitForApproval, type PublishGrant } from '../lib/authorize.js';
import {
	createUploadSession,
	uploadPartsSequentially,
	completeUpload,
	createVersion,
	submitVersion,
	waitForPreflight,
	DEFAULT_PART_SIZE_BYTES,
} from '../lib/upload.js';
import { Reporter, maskSecret } from '../lib/output.js';

const DEFAULT_PORTAL_ORIGIN = 'https://portal.privos.io';

export type PublishRuntimeOptions = Readonly<{
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	fetchImpl?: typeof fetch;
	sleepImpl?: (ms: number) => Promise<void>;
	openBrowser?: (url: string) => void;
	readTokenFromStdin?: () => Promise<string>;
	confirm?: (question: string) => Promise<boolean>;
	isTTY?: boolean;
	cliVersion?: string;
}>;

/** Internal control-flow error carrying the CLI exit code to return. */
class CliExitError extends Error {
	constructor(message: string, public readonly exitCode: number, public readonly code?: string) {
		super(message);
		this.name = 'CliExitError';
	}
}

/**
 * `privos-app publish` — package → lint (structure only) → authorize
 * (browser device flow or `PRIVOS_PUBLISHER_TOKEN`) → upload → version →
 * submit. See phase-04 requirements for the exact sequencing and exit codes
 * (0 submitted, 2 blocked by policy, 3 authorization denied/expired, 4
 * network/portal error, 5 usage).
 */
export async function runPublish(argv: readonly string[], runtime: PublishRuntimeOptions = {}): Promise<number> {
	const env = runtime.env ?? process.env;
	let values: Record<string, unknown>;
	try {
		({ values } = parseArgs({
			args: argv as string[],
			options: {
				listing: { type: 'string' },
				changelog: { type: 'string' },
				'changelog-file': { type: 'string' },
				'allow-dirty': { type: 'boolean', default: false },
				'dry-run': { type: 'boolean', default: false },
				yes: { type: 'boolean', default: false },
				portal: { type: 'string' },
				'machine-label': { type: 'string' },
				open: { type: 'boolean', default: false },
				json: { type: 'boolean', default: false },
				cwd: { type: 'string' },
				'token-stdin': { type: 'boolean', default: false },
				help: { type: 'boolean', default: false, short: 'h' },
			},
			allowPositionals: false,
		}));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 5;
	}

	if (values.help) {
		printPublishUsage();
		return 0;
	}

	const jsonMode = Boolean(values.json);
	const reporter = new Reporter(jsonMode);
	const cwd = path.resolve(runtime.cwd ?? (typeof values.cwd === 'string' ? values.cwd : process.cwd()));

	try {
		// Step 1: locate + validate manifest identity (structure only — never send this hash to the Portal).
		const { manifestPath, manifest } = loadManifest(cwd);
		const { pkg } = loadPackageJson(cwd);
		const lintResult = structuralLint(manifest);
		if (!lintResult.valid) {
			reporter.emit({ event: 'lint', ok: false, manifestPath });
			throw new CliExitError(`Manifest is invalid:\n- ${lintResult.errors.join('\n- ')}`, 2, 'MANIFEST_INVALID');
		}
		const identityErrors = assertIdentityAgreement(manifest, pkg);
		if (identityErrors.length > 0) {
			reporter.emit({ event: 'lint', ok: false, manifestPath });
			throw new CliExitError(identityErrors.join('\n'), 2, 'MANIFEST_IDENTITY_MISMATCH');
		}
		reporter.emit({ event: 'lint', ok: true, manifestPath });

		const name = String(manifest.name);
		const version = String(manifest.version);

		// Step 2: package (refuse dirty tree unless --allow-dirty; entry policy enforced inside).
		const packaged = packageOrThrow(cwd, name, version, Boolean(values['allow-dirty']));
		reporter.emit({
			event: 'package',
			archivePath: packaged.archivePath,
			bytes: packaged.bytes,
			sha256: packaged.sha256,
			entryCount: packaged.entries.length,
		});

		if (values['dry-run']) {
			reporter.emit({ event: 'status', state: 'DRY_RUN', message: `git ${packaged.gitRevision} · sha256:${packaged.sha256}` });
			return 0;
		}

		// Step 3: resolve config + credentials.
		const changelog = resolveChangelog(values, cwd);
		const portalOrigin = typeof values.portal === 'string' ? values.portal : env.PRIVOS_PORTAL_ORIGIN || DEFAULT_PORTAL_ORIGIN;
		const cliVersion = runtime.cliVersion ?? getOwnPackageVersion();
		const token = values['token-stdin']
			? (await (runtime.readTokenFromStdin ?? readTokenFromStdin)()).trim()
			: env.PRIVOS_PUBLISHER_TOKEN || undefined;
		if (token) reporter.emit({ event: 'authorization_token', maskedToken: maskSecret(token) });

		if (!values.yes && !jsonMode && (runtime.isTTY ?? Boolean(process.stdin.isTTY))) {
			const confirm = runtime.confirm ?? defaultConfirm;
			const proceed = await confirm(`Publish ${name}@${version} (sha256:${packaged.sha256.slice(0, 12)}…)? [y/N] `);
			if (!proceed) throw new CliExitError('Publish cancelled.', 5, 'CANCELLED');
		}

		const client = new PortalClient({ origin: portalOrigin, fetchImpl: runtime.fetchImpl, sleepImpl: runtime.sleepImpl });

		// Step 4: authorize — browser device flow (default) or publisher-token auto-approve (CI).
		const { grant, listing } = await authorize(client, runtime, reporter, token, {
			manifestName: name,
			semver: version,
			archiveSha256: packaged.sha256,
			archiveBytes: packaged.bytes,
			cliVersion,
			listingSlug: typeof values.listing === 'string' ? values.listing : undefined,
			machineLabel: typeof values['machine-label'] === 'string' ? values['machine-label'] : undefined,
			open: Boolean(values.open),
		});
		reporter.emit({ event: 'authorization_approved', listingId: listing.id, listingSlug: listing.slug });

		// Step 5: upload sequentially under the grant.
		const archiveBuffer = fs.readFileSync(packaged.archivePath);
		let uploadId: string;
		try {
			({ uploadId } = await createUploadSession(client, grant.value, listing.id, {
				fileName: path.basename(packaged.archivePath),
				totalBytes: archiveBuffer.length,
				paths: packaged.filePaths,
			}));
			await uploadPartsSequentially(client, grant.value, uploadId, archiveBuffer, DEFAULT_PART_SIZE_BYTES, (part, totalParts) =>
				reporter.emit({ event: 'upload_progress', part, totalParts }),
			);
		} catch (error) {
			throw mapGrantPortalError(error);
		}

		// Step 6: complete — verify + print the Portal's canonical digest.
		let manifestDigest: string;
		try {
			const completed = await completeUpload(client, grant.value, uploadId);
			manifestDigest = completed.manifestDigest;
			reporter.emit({ event: 'upload_complete', sha256: completed.sha256, manifestDigest });
		} catch (error) {
			throw mapGrantPortalError(error);
		}

		// Step 7: version.
		let createdVersion;
		try {
			createdVersion = await createVersion(client, grant.value, listing.id, { semver: version, uploadId, changelog });
		} catch (error) {
			throw mapGrantPortalError(error);
		}
		reporter.emit({ event: 'version_created', versionId: createdVersion.id, semver: createdVersion.semver });

		// Step 8: submit, then wait ≤60s for preflight to leave PENDING.
		try {
			await submitVersion(client, grant.value, listing.id, createdVersion.id);
		} catch (error) {
			throw mapGrantPortalError(error);
		}
		reporter.emit({ event: 'submitted', versionId: createdVersion.id });

		const finalVersion = await waitForPreflight(client, grant.value, listing.id, createdVersion.id, { sleepImpl: runtime.sleepImpl });
		const finalState = finalVersion?.state ?? 'PREFLIGHT_PENDING';

		if (finalState === 'PREFLIGHT_FAILED') {
			const findings = JSON.stringify((finalVersion as Record<string, unknown>).preflightFindings ?? finalVersion);
			throw new CliExitError(`Preflight failed:\n${findings}`, 2, 'PREFLIGHT_FAILED');
		}
		if (finalState === 'PREFLIGHT_BLOCKED_INFRA') {
			reporter.emit({
				event: 'status',
				state: finalState,
				message: 'blocked on Portal build infrastructure — this is admin-side, not a problem with your submission',
			});
			return 0;
		}
		reporter.emit({ event: 'status', state: finalState, message: 'follow up in Creator Studio' });
		return 0;
	} catch (error) {
		if (error instanceof CliExitError) {
			reporter.emit({ event: 'error', code: error.code, message: error.message });
			return error.exitCode;
		}
		if (error instanceof ManifestLoadError) {
			reporter.emit({ event: 'error', message: error.message });
			return 5;
		}
		if (error instanceof PortalError) {
			reporter.emit({ event: 'error', code: error.code, message: error.message });
			return 4;
		}
		reporter.emit({ event: 'error', message: error instanceof Error ? error.message : String(error) });
		return 4;
	}
}

function packageOrThrow(cwd: string, name: string, version: string, allowDirty: boolean) {
	try {
		return packageSource({ cwd, name, version, allowDirty });
	} catch (error) {
		if (error instanceof PackagePolicyError) {
			const exitCode = error.code === 'NOT_GIT_REPOSITORY' || error.code === 'GIT_ARCHIVE_FAILED' ? 5 : 2;
			const message = error.details.length > 0 ? `${error.message}\n- ${error.details.join('\n- ')}` : error.message;
			throw new CliExitError(message, exitCode, error.code);
		}
		throw error;
	}
}

type AuthorizeStepRequest = Readonly<{
	manifestName: string;
	semver: string;
	archiveSha256: string;
	archiveBytes: number;
	cliVersion: string;
	listingSlug?: string;
	machineLabel?: string;
	open: boolean;
}>;

async function authorize(
	client: PortalClient,
	runtime: PublishRuntimeOptions,
	reporter: Reporter,
	token: string | undefined,
	request: AuthorizeStepRequest,
): Promise<{ grant: PublishGrant; listing: { id: string; slug: string; name?: string } }> {
	try {
		const outcome = await createAuthorization(client, request, token);
		if (outcome.kind === 'grant') {
			return { grant: outcome.grant, listing: outcome.listing };
		}

		reporter.emit({
			event: 'authorization_device',
			verificationUrl: outcome.verificationUrl,
			userCode: outcome.userCode,
			expiresIn: outcome.expiresIn,
		});
		if (request.open) {
			try {
				(runtime.openBrowser ?? openBrowser)(outcome.verificationUrl);
			} catch {
				// best-effort only — the printed URL remains the source of truth.
			}
		}

		const pollOutcome = await waitForApproval(client, outcome.deviceCode, {
			intervalMs: outcome.interval * 1000,
			expiresInMs: outcome.expiresIn * 1000,
			sleepImpl: runtime.sleepImpl,
			onPending: (elapsedMs) => reporter.emit({ event: 'authorization_waiting', elapsedMs }),
		});
		if (pollOutcome.state === 'DENIED') {
			reporter.emit({ event: 'authorization_denied' });
			throw new CliExitError('Publish authorization was denied.', 3, 'AUTHORIZATION_DENIED');
		}
		if (pollOutcome.state === 'EXPIRED') {
			reporter.emit({ event: 'authorization_expired' });
			throw new CliExitError('Publish authorization expired; re-run to request a new approval.', 3, 'AUTHORIZATION_EXPIRED');
		}
		if (pollOutcome.state === 'CONSUMED') {
			throw new CliExitError('Publish authorization was already consumed; re-run to request a new approval.', 3, 'AUTHORIZATION_CONSUMED');
		}
		return { grant: pollOutcome.grant, listing: { id: pollOutcome.grant.listingId, slug: pollOutcome.grant.listingSlug } };
	} catch (error) {
		if (error instanceof CliExitError) throw error;
		if (error instanceof PortalError) throw mapAuthorizationPortalError(error);
		throw error;
	}
}

function mapAuthorizationPortalError(error: PortalError): CliExitError {
	if (error.code === 'LISTING_NOT_BOUND') {
		return new CliExitError(
			'Listing is not yet bound to this manifest — approve the first version of this listing in your browser: run without the token.',
			2,
			error.code,
		);
	}
	if (error.code === 'LISTING_UNRESOLVED') {
		return new CliExitError('Listing could not be resolved — pass --listing <slug> to select it.', 2, error.code);
	}
	// A revoked/expired/invalid publisher token is an authorization denial, not a
	// transport fault — surface it as exit 3 so CI can tell "rotate the token" apart
	// from "the Portal is unreachable".
	if (
		error.code === 'PUBLISHER_TOKEN_REVOKED' ||
		error.code === 'PUBLISHER_TOKEN_EXPIRED' ||
		error.code === 'PUBLISHER_TOKEN_INVALID'
	) {
		return new CliExitError(`Publisher token rejected (${error.code}); rotate it in Creator Studio.`, 3, error.code);
	}
	return new CliExitError(error.message, 4, error.code);
}

function mapGrantPortalError(error: unknown): Error {
	if (!(error instanceof PortalError)) return error instanceof Error ? error : new Error(String(error));
	if (error.code === 'PUBLISH_GRANT_EXPIRED') {
		return new CliExitError('Publish grant expired mid-upload; re-run to request a new approval.', 3, error.code);
	}
	if (error.code === 'PUBLISH_GRANT_MISMATCH') {
		return new CliExitError(
			'Uploaded archive or manifest does not match the approved authorization; re-run publish from a clean state.',
			2,
			error.code,
		);
	}
	if (error.code === 'VERSION_SEMVER_EXISTS') {
		return new CliExitError('Version already exists — bump `version` in privos-app.json and package.json.', 2, error.code);
	}
	return new CliExitError(error.message, 4, error.code);
}

function resolveChangelog(values: Record<string, unknown>, cwd: string): string {
	if (typeof values.changelog === 'string') return values.changelog;
	if (typeof values['changelog-file'] === 'string') {
		const changelogPath = path.resolve(cwd, values['changelog-file']);
		try {
			return fs.readFileSync(changelogPath, 'utf8').trim();
		} catch {
			throw new CliExitError(`Unable to read changelog file: ${changelogPath}`, 5, 'USAGE');
		}
	}
	return '';
}

function getOwnPackageVersion(): string {
	try {
		const packageJsonUrl = new URL('../../../package.json', import.meta.url);
		const pkg = JSON.parse(fs.readFileSync(packageJsonUrl, 'utf8')) as { version?: string };
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
}

async function readTokenFromStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString('utf8');
}

async function defaultConfirm(question: string): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(question);
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

function openBrowser(url: string): void {
	if (process.platform === 'darwin') {
		spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
	} else if (process.platform === 'win32') {
		spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
	} else {
		spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
	}
}

function printPublishUsage(): void {
	console.log(`Usage: privos-app publish [options]

Packages the app in the current directory (or --cwd), authorizes with the
Portal (browser approval by default, or PRIVOS_PUBLISHER_TOKEN for CI),
uploads the source archive, creates the version, and submits it for review.

Options:
  --listing <slug>          Listing slug when it cannot be resolved from the manifest name
  --changelog <text>        Changelog text for this version
  --changelog-file <path>   Read changelog text from a file
  --allow-dirty             Package an uncommitted working tree (git write-tree snapshot)
  --dry-run                 Package only; print the git revision and archive sha256, then stop
  --yes                     Skip the interactive confirmation prompt
  --portal <origin>         Portal origin (default: $PRIVOS_PORTAL_ORIGIN or https://portal.privos.io)
  --machine-label <text>    Label shown on the approval page (never the hostname by default)
  --open                    Open the approval URL in a browser
  --json                    Emit one NDJSON event per step
  --cwd <path>              Directory containing privos-app.json and package.json
  --token-stdin             Read PRIVOS_PUBLISHER_TOKEN from stdin instead of the environment
  -h, --help                Show this help

Exit codes: 0 submitted, 2 blocked by policy, 3 authorization denied/expired, 4 network/portal error, 5 usage.`);
}
