import type { RawData } from 'ws';

const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export class MessageTooLargeError extends Error {
	constructor(public readonly bytes: number, public readonly maxBytes: number) {
		super(`WebSocket message exceeds maxMessageBytes (${bytes} > ${maxBytes})`);
		this.name = 'MessageTooLargeError';
	}
}

/** Convert ws RawData to UTF-8 text with a hard size limit. */
export function rawDataToText(
	data: RawData,
	maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
): string {
	let buf: Buffer;
	if (Buffer.isBuffer(data)) {
		buf = data;
	} else if (data instanceof ArrayBuffer) {
		buf = Buffer.from(data);
	} else if (Array.isArray(data)) {
		buf = Buffer.concat(data);
	} else {
		buf = Buffer.from(String(data));
	}

	if (buf.byteLength > maxMessageBytes) {
		throw new MessageTooLargeError(buf.byteLength, maxMessageBytes);
	}
	return buf.toString('utf8');
}
