import type { JsonRpcErrorObject, JsonRpcId, McpErrorResponse, McpResultResponse } from './types.js';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const SERVER_BUSY = -32000;

const SAFE_PROTOCOL_CODES = new Set([
	PARSE_ERROR,
	INVALID_REQUEST,
	METHOD_NOT_FOUND,
	INVALID_PARAMS,
	INTERNAL_ERROR,
	SERVER_BUSY,
]);

export function jsonRpcError(
	code: number,
	message: string,
	data?: unknown,
): JsonRpcErrorObject {
	return data === undefined ? { code, message } : { code, message, data };
}

export function resultResponse(id: JsonRpcId, result: unknown): McpResultResponse {
	return { jsonrpc: '2.0', id, result };
}

export function errorResponse(id: JsonRpcId, error: JsonRpcErrorObject): McpErrorResponse {
	return { jsonrpc: '2.0', id, error };
}

/**
 * Map thrown values to a client-safe JSON-RPC error.
 * Unmapped Error.message values are never returned to clients (leak prevention).
 */
export function normalizeThrownError(
	err: unknown,
	mapAppError?: (error: unknown) => JsonRpcErrorObject | undefined,
): JsonRpcErrorObject {
	const mapped = mapAppError?.(err);
	if (mapped) {
		return jsonRpcError(mapped.code, mapped.message, mapped.data);
	}

	if (err && typeof err === 'object') {
		const anyErr = err as { code?: unknown; message?: unknown; data?: unknown };
		const dataCode =
			anyErr.data && typeof anyErr.data === 'object' && anyErr.data !== null
				? (anyErr.data as { code?: unknown }).code
				: undefined;

		if (dataCode === 'REQUEST_TIMEOUT') {
			return jsonRpcError(INTERNAL_ERROR, 'Request timed out', { code: 'REQUEST_TIMEOUT' });
		}
		if (dataCode === 'RESPONSE_TOO_LARGE') {
			return jsonRpcError(INTERNAL_ERROR, 'Response too large', { code: 'RESPONSE_TOO_LARGE' });
		}
		if (dataCode === 'DUPLICATE_IN_FLIGHT_ID') {
			return jsonRpcError(INVALID_REQUEST, 'Duplicate in-flight JSON-RPC id', {
				code: 'DUPLICATE_IN_FLIGHT_ID',
			});
		}

		if (typeof anyErr.code === 'number' && SAFE_PROTOCOL_CODES.has(anyErr.code)) {
			const message =
				typeof anyErr.message === 'string' && anyErr.message && anyErr.code !== INTERNAL_ERROR
					? anyErr.message
					: anyErr.code === METHOD_NOT_FOUND
						? 'Method not found'
						: anyErr.code === INVALID_PARAMS
							? 'Invalid params'
							: anyErr.code === INVALID_REQUEST
								? 'Invalid Request'
								: anyErr.code === PARSE_ERROR
									? 'Parse error'
									: anyErr.code === SERVER_BUSY
										? 'Server busy'
										: 'Internal error';
			return jsonRpcError(
				anyErr.code,
				anyErr.code === INTERNAL_ERROR ? 'Internal error' : message,
				sanitizeErrorData(anyErr.data),
			);
		}
	}

	return jsonRpcError(INTERNAL_ERROR, 'Internal error');
}

function sanitizeErrorData(data: unknown): unknown {
	if (data === undefined) return undefined;
	if (data === null) return null;
	if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
		return data;
	}
	if (typeof data === 'object' && !Array.isArray(data)) {
		const code = (data as { code?: unknown }).code;
		if (typeof code === 'string' || typeof code === 'number') {
			return { code };
		}
	}
	return undefined;
}
