const HEADER_SIZE = 512;
/**
 * This writer's plain-USTAR header has no `prefix` field, so an entry name is
 * capped at the 100-byte `name` field alone. `bundle-ui.ts` checks this ahead
 * of time and raises a named `UiBundleError` (`UI_BUNDLE_ENTRY_NAME_TOO_LONG`)
 * — the throw below is a defensive backstop for any other caller, not the
 * primary signal.
 */
export const USTAR_MAX_NAME_BYTES = 100;
const NAME_MAX_LENGTH = USTAR_MAX_NAME_BYTES;
const REGULAR_FILE_MODE = 0o644;

export interface DeterministicTarEntry {
	/** Tar entry name (POSIX-style, forward slashes) — must be ≤ 100 bytes for this writer's plain USTAR header. */
	name: string;
	data: Buffer;
}

/** Right-pads an octal numeric field to `length` bytes: digits, NUL terminator, zero-padded. */
function octalField(value: number, length: number): Buffer {
	const digits = value.toString(8).padStart(length - 1, '0');
	const field = Buffer.alloc(length);
	field.write(digits, 0, 'ascii');
	field[length - 1] = 0;
	return field;
}

function asciiField(value: string, length: number): Buffer {
	const field = Buffer.alloc(length);
	field.write(value, 0, 'ascii');
	return field;
}

/** Builds one 512-byte USTAR header for a regular file, with a deterministic (zeroed) mtime/uid/gid/owner. */
function buildHeader(name: string, size: number): Buffer {
	if (Buffer.byteLength(name, 'utf8') > NAME_MAX_LENGTH) {
		throw new Error(`deterministic tar: entry name exceeds ${NAME_MAX_LENGTH} bytes: ${name}`);
	}
	const header = Buffer.alloc(HEADER_SIZE);
	asciiField(name, NAME_MAX_LENGTH).copy(header, 0);
	octalField(REGULAR_FILE_MODE, 8).copy(header, 100);
	octalField(0, 8).copy(header, 108); // uid
	octalField(0, 8).copy(header, 116); // gid
	octalField(size, 12).copy(header, 124);
	octalField(0, 12).copy(header, 136); // mtime — always zero for reproducibility
	header.fill(0x20, 148, 156); // chksum placeholder: 8 spaces while computing
	header[156] = 0x30; // typeflag '0' — regular file
	asciiField('ustar\0', 6).copy(header, 257); // magic
	asciiField('00', 2).copy(header, 263); // version

	let checksum = 0;
	for (let i = 0; i < HEADER_SIZE; i += 1) checksum += header[i]!;
	const checksumField = Buffer.alloc(8);
	checksumField.write(checksum.toString(8).padStart(6, '0'), 0, 'ascii');
	checksumField[6] = 0;
	checksumField[7] = 0x20;
	checksumField.copy(header, 148);

	return header;
}

/**
 * Packs `entries` (in the exact order given — callers sort) into a
 * deterministic USTAR tar: zero mtime/uid/gid/owner on every header, so two
 * builds of byte-identical input produce a byte-identical archive. Used by
 * `bundle-ui` to produce the artifact the build node ships and the Hub
 * ingests — a non-deterministic tar would make two builds of the same
 * source disagree on a digest with nothing to blame it on.
 */
export function buildDeterministicTar(entries: readonly DeterministicTarEntry[]): Buffer {
	const parts: Buffer[] = [];
	for (const entry of entries) {
		parts.push(buildHeader(entry.name, entry.data.length));
		parts.push(entry.data);
		const padding = (HEADER_SIZE - (entry.data.length % HEADER_SIZE)) % HEADER_SIZE;
		if (padding > 0) parts.push(Buffer.alloc(padding));
	}
	parts.push(Buffer.alloc(HEADER_SIZE * 2)); // two zero blocks mark end-of-archive
	return Buffer.concat(parts);
}
