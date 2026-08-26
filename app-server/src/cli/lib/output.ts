/**
 * Human vs `--json` (NDJSON) rendering for `privos-app publish`, plus secret
 * masking. Grants are never rendered by any event — callers must not pass a
 * grant value into a {@link PublishEvent}. Tokens are only ever shown masked.
 */
export type PublishEvent =
	| Readonly<{ event: 'lint'; ok: boolean; manifestPath: string }>
	| Readonly<{ event: 'package'; archivePath: string; bytes: number; sha256: string; entryCount: number }>
	| Readonly<{ event: 'authorization_token'; maskedToken: string }>
	| Readonly<{ event: 'authorization_device'; verificationUrl: string; userCode: string; expiresIn: number }>
	| Readonly<{ event: 'authorization_waiting'; elapsedMs: number }>
	| Readonly<{ event: 'authorization_approved'; listingId: string; listingSlug: string }>
	| Readonly<{ event: 'authorization_denied' }>
	| Readonly<{ event: 'authorization_expired' }>
	| Readonly<{ event: 'upload_progress'; part: number; totalParts: number }>
	| Readonly<{ event: 'upload_complete'; sha256: string; manifestDigest: string }>
	| Readonly<{ event: 'version_created'; versionId: string; semver: string }>
	| Readonly<{ event: 'submitted'; versionId: string }>
	| Readonly<{ event: 'status'; state: string; message?: string }>
	| Readonly<{ event: 'error'; code?: string; message: string }>;

export class Reporter {
	constructor(private readonly jsonMode: boolean) {}

	emit(event: PublishEvent): void {
		if (this.jsonMode) {
			process.stdout.write(`${JSON.stringify(event)}\n`);
			return;
		}
		process.stdout.write(`${formatHumanLine(event)}\n`);
	}
}

function formatHumanLine(event: PublishEvent): string {
	switch (event.event) {
		case 'lint':
			return event.ok ? `✔ manifest ${event.manifestPath} valid` : `✖ manifest ${event.manifestPath} invalid`;
		case 'package':
			return `✔ archive ${event.archivePath} (${event.bytes} bytes, ${event.entryCount} entries, sha256:${event.sha256})`;
		case 'authorization_token':
			return `→ authorizing with publisher token ${event.maskedToken}`;
		case 'authorization_device':
			return [
				'→ Approve this publish in your browser:',
				`    ${event.verificationUrl}`,
				`    user code: ${event.userCode}`,
				`  (waiting… expires in ${Math.round(event.expiresIn / 60)} min)`,
			].join('\n');
		case 'authorization_waiting':
			return '  (waiting for approval…)';
		case 'authorization_approved':
			return `✔ approved → listing ${event.listingSlug}`;
		case 'authorization_denied':
			return '✖ publish authorization was denied';
		case 'authorization_expired':
			return '✖ publish authorization expired';
		case 'upload_progress':
			return `  uploaded ${event.part}/${event.totalParts} parts`;
		case 'upload_complete':
			return `✔ uploaded · manifest digest ${event.manifestDigest}`;
		case 'version_created':
			return `✔ version ${event.semver} created`;
		case 'submitted':
			return '✔ submitted';
		case 'status':
			return event.message ? `→ status: ${event.state}  (${event.message})` : `→ status: ${event.state}`;
		case 'error':
			return `✖ ${event.message}`;
		default: {
			const exhaustive: never = event;
			return JSON.stringify(exhaustive);
		}
	}
}

/** Shows only enough of a secret to identify it in logs; never the full value. */
export function maskSecret(value: string): string {
	if (value.length <= 8) return '***';
	return `${value.slice(0, 8)}…(${value.length} chars)`;
}
