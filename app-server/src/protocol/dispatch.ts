import {
	INVALID_REQUEST,
	PARSE_ERROR,
	jsonRpcError,
} from './errors.js';
import {
	hasOwnId,
	isJsonRpcId,
	type ParsedInbound,
} from './types.js';

export function parseJsonRpcMessage(raw: unknown): ParsedInbound {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return {
			kind: 'invalid',
			id: undefined,
			error: jsonRpcError(INVALID_REQUEST, 'Invalid Request: expected JSON object'),
		};
	}

	const msg = raw as Record<string, unknown>;

	if (msg.jsonrpc !== '2.0') {
		return {
			kind: 'invalid',
			id: hasOwnId(msg) && isJsonRpcId(msg.id) ? msg.id : undefined,
			error: jsonRpcError(INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"'),
		};
	}

	// Hub/peer response frames — do not dispatch as requests.
	if ('result' in msg || 'error' in msg) {
		return { kind: 'response', message: msg };
	}

	if (typeof msg.method !== 'string' || !msg.method) {
		return {
			kind: 'invalid',
			id: hasOwnId(msg) && isJsonRpcId(msg.id) ? msg.id : undefined,
			error: jsonRpcError(INVALID_REQUEST, 'Invalid Request: method is required'),
		};
	}

	if (!hasOwnId(msg)) {
		return {
			kind: 'notification',
			message: {
				jsonrpc: '2.0',
				method: msg.method,
				...(msg.params !== undefined ? { params: msg.params } : {}),
			},
		};
	}

	if (!isJsonRpcId(msg.id)) {
		return {
			kind: 'invalid',
			id: undefined,
			error: jsonRpcError(INVALID_REQUEST, 'Invalid Request: id must be string, number, or null'),
		};
	}

	return {
		kind: 'request',
		message: {
			jsonrpc: '2.0',
			id: msg.id,
			method: msg.method,
			...(msg.params !== undefined ? { params: msg.params } : {}),
		},
	};
}

export function parseJsonText(text: string): ParsedInbound {
	try {
		return parseJsonRpcMessage(JSON.parse(text) as unknown);
	} catch {
		return {
			kind: 'invalid',
			id: undefined,
			error: jsonRpcError(PARSE_ERROR, 'Parse error'),
		};
	}
}

export function isMcpNotificationMethod(method: string): boolean {
	return method === 'notifications/initialized' || method.startsWith('notifications/');
}

/** Methods that must produce a result — missing id is a Hub contract violation. */
export function isResultBearingMethod(method: string): boolean {
	if (isMcpNotificationMethod(method)) return false;
	return true;
}
