/** JSON-RPC 2.0 id. Explicit `null` is distinct from a missing id property. */
export type JsonRpcId = string | number | null;

export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export interface McpRequest {
	jsonrpc: '2.0';
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface McpNotification {
	jsonrpc: '2.0';
	method: string;
	params?: unknown;
}

export interface McpResultResponse {
	jsonrpc: '2.0';
	id: JsonRpcId;
	result: unknown;
}

export interface McpErrorResponse {
	jsonrpc: '2.0';
	id: JsonRpcId;
	error: JsonRpcErrorObject;
}

export type McpResponse = McpResultResponse | McpErrorResponse;

/** Application-facing request — runtime already handled initialize / notifications. */
export type ApplicationMcpMethod = 'tools/list' | 'tools/call' | 'resources/read' | (string & {});

export interface ApplicationMcpRequest {
	jsonrpc: '2.0';
	id: JsonRpcId;
	method: ApplicationMcpMethod;
	params?: unknown;
}

export type ParsedInbound =
	| { kind: 'request'; message: McpRequest }
	| { kind: 'notification'; message: McpNotification }
	| { kind: 'response'; message: Record<string, unknown> }
	| { kind: 'invalid'; error: JsonRpcErrorObject; id: JsonRpcId | undefined };

export function hasOwnId(value: object): boolean {
	return Object.prototype.hasOwnProperty.call(value, 'id');
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
	return value === null || typeof value === 'string' || typeof value === 'number';
}
