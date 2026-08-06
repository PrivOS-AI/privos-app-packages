import { randomUUID } from 'node:crypto';

import {
	buildInitializeResult,
	MCP_UI_MIME,
	type AppDescriptor,
} from './app-descriptor.js';
import {
	type AuthOptions,
	type CallerCredential,
	verifyUserToken,
} from './auth/user-token.js';
import type { ToolCallContext } from './context/tool-call-context.js';
import {
	INTERNAL_ERROR,
	INVALID_REQUEST,
	METHOD_NOT_FOUND,
	SERVER_BUSY,
	errorResponse,
	jsonRpcError,
	normalizeThrownError,
	resultResponse,
} from './protocol/errors.js';
import {
	isMcpNotificationMethod,
	isResultBearingMethod,
	parseJsonRpcMessage,
	parseJsonText,
} from './protocol/dispatch.js';
import { estimateJsonBytes, summarizeForLog } from './protocol/logging.js';
import type {
	ApplicationMcpRequest,
	JsonRpcErrorObject,
	JsonRpcId,
	McpResponse,
	ParsedInbound,
} from './protocol/types.js';
import type { VerifiedRuntimeAuthorizationV3 } from './workload/dispatch-assertion.js';

export type AppMcpHandler = (
	request: ApplicationMcpRequest,
	context: ToolCallContext,
) => Promise<unknown>;

export type CallerCredentialExtractor<TIngress> = (
	ingress: TIngress,
) => CallerCredential | undefined | Promise<CallerCredential | undefined>;

export type AppErrorMapper = (
	error: unknown,
	context: ToolCallContext,
) => JsonRpcErrorObject | undefined;

export interface UiResourceProvider {
	uri: string;
	mimeType?: typeof MCP_UI_MIME | string;
	renderHtml(input: {
		params: unknown;
		context: ToolCallContext;
	}): string | Promise<string>;
}

export interface RuntimeLimits {
	maxMessageBytes?: number;
	requestTimeoutMs?: number;
	maxInFlightRequests?: number;
	maxResponseBytes?: number;
	/** Max outbound WebSocket bufferedAmount before dropping a send (relay). */
	maxBufferedBytes?: number;
}

export interface AppServerRuntimeOptions {
	descriptor: AppDescriptor | (() => AppDescriptor | Promise<AppDescriptor>);
	handler: AppMcpHandler;
	ui?: UiResourceProvider;
	auth?: AuthOptions;
	mapAppError?: AppErrorMapper;
	limits?: RuntimeLimits;
	logger?: (event: string, fields: Record<string, unknown>) => void;
}

/** How caller credentials were resolved before JWT verify. */
export type CallerCredentialResolution =
	| { kind: 'absent' }
	| { kind: 'present'; credential: CallerCredential }
	| { kind: 'error'; message: string };

export type DispatchOutcome =
	| { type: 'response'; response: McpResponse }
	| { type: 'no_response'; reason: 'notification' | 'missing_request_id' | 'ignored_response' }
	| { type: 'protocol_warning'; warning: string; response?: McpResponse };

type ContextFinalizer = (context: ToolCallContext) => void;

const DEFAULT_MAX_IN_FLIGHT = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** Distinguish number `1` from string `"1"` without separator collisions. */
export function encodeInFlightId(id: JsonRpcId): string {
	return JSON.stringify([typeof id, id] as const);
}

export class AppServerRuntime {
	/**
	 * Nested map: sessionScope → set of encodeInFlightId(id).
	 * Avoids String(id) collisions and colon-join ambiguities.
	 */
	private readonly inFlight = new Map<string, Set<string>>();
	private readonly opts: AppServerRuntimeOptions;

	constructor(opts: AppServerRuntimeOptions) {
		this.opts = opts;
	}

	getLimits(): Required<
		Pick<
			RuntimeLimits,
			| 'maxMessageBytes'
			| 'requestTimeoutMs'
			| 'maxInFlightRequests'
			| 'maxResponseBytes'
			| 'maxBufferedBytes'
		>
	> {
		return {
			maxMessageBytes: this.opts.limits?.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
			requestTimeoutMs: this.opts.limits?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			maxInFlightRequests: this.opts.limits?.maxInFlightRequests ?? DEFAULT_MAX_IN_FLIGHT,
			maxResponseBytes: this.opts.limits?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
			maxBufferedBytes: this.opts.limits?.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
		};
	}

	private inFlightCount(): number {
		let n = 0;
		for (const set of this.inFlight.values()) n += set.size;
		return n;
	}

	private hasInFlight(sessionScope: string, id: JsonRpcId): boolean {
		return this.inFlight.get(sessionScope)?.has(encodeInFlightId(id)) ?? false;
	}

	private addInFlight(sessionScope: string, id: JsonRpcId): void {
		let set = this.inFlight.get(sessionScope);
		if (!set) {
			set = new Set();
			this.inFlight.set(sessionScope, set);
		}
		set.add(encodeInFlightId(id));
	}

	private deleteInFlight(sessionScope: string, id: JsonRpcId): void {
		const set = this.inFlight.get(sessionScope);
		if (!set) return;
		set.delete(encodeInFlightId(id));
		if (set.size === 0) this.inFlight.delete(sessionScope);
	}

	async resolveDescriptor(): Promise<AppDescriptor> {
		const d = this.opts.descriptor;
		return typeof d === 'function' ? await d() : d;
	}

	async buildContext(input: {
		transport: 'direct' | 'relay';
		requestId?: JsonRpcId;
		/** Required for duplicate-id scope. */
		sessionScope: string;
		credentialResolution?: CallerCredentialResolution;
		traceId?: string;
		signal?: AbortSignal;
		runtimeAuthorization?: VerifiedRuntimeAuthorizationV3;
		/** Per-request verifier pinned by the authenticated workload broker. */
		auth?: AuthOptions;
	}): Promise<ToolCallContext> {
		const descriptor = await this.resolveDescriptor();
		const base: ToolCallContext = {
			transport: input.transport,
			requestId: input.requestId,
			appId: descriptor.id,
			traceId: input.traceId,
			sessionScope: input.sessionScope,
			identityState: 'missing',
			...(input.runtimeAuthorization ? { runtimeAuthorization: input.runtimeAuthorization } : {}),
			...(input.runtimeAuthorization?.authorizationContext === 'room'
				? { roomId: input.runtimeAuthorization.roomId }
				: {}),
			...(input.signal ? { signal: input.signal } : {}),
		};

		const resolution = input.credentialResolution ?? { kind: 'absent' };

		if (resolution.kind === 'absent') {
			return base;
		}

		if (resolution.kind === 'error') {
			// Do not log extractor Error.message — may contain secrets/URLs.
			this.log('mcp.caller_extractor_error', {
				transport: input.transport,
				reason: 'extractor_failed',
				traceId: input.traceId,
			});
			return { ...base, identityState: 'invalid' };
		}

		if (!resolution.credential.token) {
			return { ...base, identityState: 'invalid' };
		}

		const auth = input.auth ?? this.opts.auth;
		if (!auth) {
			return { ...base, identityState: 'invalid' };
		}

		const verified = await verifyUserToken(
			resolution.credential.token,
			auth,
			resolution.credential.assertedUserId,
		);

		if (!verified.ok) {
			return {
				...base,
				identityState: verified.reason === 'missing' ? 'missing' : 'invalid',
			};
		}

		if (
			input.runtimeAuthorization &&
			(input.runtimeAuthorization.authorizationContext === 'room'
				? verified.actor.roomId !== input.runtimeAuthorization.roomId
				: verified.actor.roomId !== undefined)
		) {
			throw new Error('dispatch_assertion_binding_mismatch');
		}

		return {
			...base,
			identityState: 'verified',
			actor: verified.actor,
			roomId: input.runtimeAuthorization?.authorizationContext === 'room'
				? input.runtimeAuthorization.roomId
				: verified.actor.roomId,
		};
	}

	async dispatchParsed(
		parsed: ParsedInbound,
		context: ToolCallContext,
		finalizeContext?: ContextFinalizer,
	): Promise<DispatchOutcome> {
		if (parsed.kind === 'response') {
			return { type: 'no_response', reason: 'ignored_response' };
		}

		// JSON-RPC: Parse/Invalid Request without a recoverable id → respond with id: null.
		if (parsed.kind === 'invalid') {
			const id = parsed.id !== undefined ? parsed.id : null;
			return { type: 'response', response: errorResponse(id, parsed.error) };
		}

		if (parsed.kind === 'notification') {
			const method = parsed.message.method;
			if (isMcpNotificationMethod(method)) {
				this.log('mcp.notification', {
					method,
					transport: context.transport,
					traceId: context.traceId,
				});
				return { type: 'no_response', reason: 'notification' };
			}

			// Valid method shape but missing id on a result-bearing call —
			// Hub Streamable HTTP quirk: do not emit a JSON-RPC body (Direct → 202).
			if (isResultBearingMethod(method)) {
				this.log('mcp.missing_request_id', {
					method,
					transport: context.transport,
					warning: 'missing_request_id',
					traceId: context.traceId,
				});
				return { type: 'no_response', reason: 'missing_request_id' };
			}

			return { type: 'no_response', reason: 'notification' };
		}

		const { message } = parsed;
		const method = message.method;

		if (isMcpNotificationMethod(method)) {
			this.log('mcp.notification_with_id', {
				method,
				id: message.id,
				transport: context.transport,
				warning: 'notification_with_id',
				traceId: context.traceId,
			});
			return { type: 'protocol_warning', warning: 'notification_with_id' };
		}

		if (this.hasInFlight(context.sessionScope, message.id)) {
			return {
				type: 'response',
				response: errorResponse(
					message.id,
					jsonRpcError(INVALID_REQUEST, 'Duplicate in-flight JSON-RPC id', {
						code: 'DUPLICATE_IN_FLIGHT_ID',
					}),
				),
			};
		}

		const limits = this.getLimits();
		if (this.inFlightCount() >= limits.maxInFlightRequests) {
			return {
				type: 'response',
				response: errorResponse(
					message.id,
					jsonRpcError(SERVER_BUSY, 'Too many in-flight requests'),
				),
			};
		}

		this.addInFlight(context.sessionScope, message.id);
		const started = Date.now();
		const abort = new AbortController();
		const onParentAbort = () => abort.abort();
		if (context.signal) {
			if (context.signal.aborted) abort.abort();
			else context.signal.addEventListener('abort', onParentAbort, { once: true });
		}

		const requestContext: ToolCallContext = {
			...context,
			signal: abort.signal,
		};
		finalizeContext?.(requestContext);

		// Keep in-flight until the underlying handler settles (even after timeout response).
		const work = this.handleRequest(
			message.method,
			message.id,
			message.params,
			requestContext,
		).finally(() => {
			this.deleteInFlight(context.sessionScope, message.id);
			context.signal?.removeEventListener('abort', onParentAbort);
		});

		try {
			const result = await raceWithTimeout(work, abort, limits.requestTimeoutMs);

			const response = resultResponse(message.id, result);
			const bytes = estimateJsonBytes(response);
			if (bytes < 0 || bytes > limits.maxResponseBytes) {
				return {
					type: 'response',
					response: errorResponse(
						message.id,
						jsonRpcError(INTERNAL_ERROR, 'Response too large', {
							code: 'RESPONSE_TOO_LARGE',
						}),
					),
				};
			}

			this.log('mcp.request.ok', summarizeForLog({
				method,
				toolName: method === 'tools/call' ? toolNameFromParams(message.params) : undefined,
				id: message.id,
				durationMs: Date.now() - started,
				resultBytes: bytes,
				identityState: context.identityState,
				transport: context.transport,
				traceId: context.traceId,
			}));

			return { type: 'response', response };
		} catch (err) {
			// Swallow late handler rejection after we already timed out / responded.
			void work.catch(() => undefined);

			const error = normalizeThrownError(err, (e) =>
				this.opts.mapAppError?.(e, requestContext),
			);
			this.log('mcp.request.error', summarizeForLog({
				method,
				toolName: method === 'tools/call' ? toolNameFromParams(message.params) : undefined,
				id: message.id,
				durationMs: Date.now() - started,
				errorCode: error.code,
				identityState: context.identityState,
				transport: context.transport,
				traceId: context.traceId,
			}));
			return { type: 'response', response: errorResponse(message.id, error) };
		}
	}

	async dispatchObject(
		raw: unknown,
		context: ToolCallContext,
		finalizeContext?: ContextFinalizer,
	): Promise<DispatchOutcome> {
		return this.dispatchParsed(parseJsonRpcMessage(raw), context, finalizeContext);
	}

	async dispatchText(
		text: string,
		context: ToolCallContext,
		finalizeContext?: ContextFinalizer,
	): Promise<DispatchOutcome> {
		return this.dispatchParsed(parseJsonText(text), context, finalizeContext);
	}

	private async handleRequest(
		method: string,
		id: JsonRpcId,
		params: unknown,
		context: ToolCallContext,
	): Promise<unknown> {
		if (method === 'initialize') {
			const descriptor = await this.resolveDescriptor();
			return buildInitializeResult(descriptor, { uiEnabled: Boolean(this.opts.ui) });
		}

		if (method === 'resources/read' && this.opts.ui) {
			const uri = (params as { uri?: string } | null)?.uri;
			if (uri === this.opts.ui.uri) {
				const html = await this.opts.ui.renderHtml({ params, context });
				return {
					contents: [
						{
							uri: this.opts.ui.uri,
							mimeType: this.opts.ui.mimeType ?? MCP_UI_MIME,
							text: html,
						},
					],
				};
			}
		}

		const applicationMethods = new Set(['tools/list', 'tools/call', 'resources/read']);
		if (!applicationMethods.has(method)) {
			throw Object.assign(new Error(`Method not found: ${method}`), {
				code: METHOD_NOT_FOUND,
			});
		}

		const request: ApplicationMcpRequest = {
			jsonrpc: '2.0',
			id,
			method: method as ApplicationMcpRequest['method'],
			...(params !== undefined ? { params } : {}),
		};
		return await this.opts.handler(request, context);
	}

	private log(event: string, fields: Record<string, unknown>): void {
		this.opts.logger?.(event, fields);
	}
}

async function raceWithTimeout<T>(
	work: Promise<T>,
	abort: AbortController,
	ms: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => {
					abort.abort();
					reject(
						Object.assign(new Error('Request timed out'), {
							code: INTERNAL_ERROR,
							data: { code: 'REQUEST_TIMEOUT' },
						}),
					);
				}, ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function toolNameFromParams(params: unknown): string | undefined {
	if (params && typeof params === 'object' && 'name' in params) {
		const name = (params as { name?: unknown }).name;
		return typeof name === 'string' ? name : undefined;
	}
	return undefined;
}

/** Built-in Direct header extractor — never reads body/arguments. */
export function extractDirectCallerCredential(headers: {
	authorization?: string | string[] | undefined;
	'x-mcp-user-id'?: string | string[] | undefined;
	[key: string]: string | string[] | undefined;
}): CallerCredential | undefined {
	const auth = headerValue(headers.authorization);
	if (!auth?.startsWith('Bearer ')) return undefined;
	const token = auth.slice('Bearer '.length).trim();
	if (!token) return undefined;
	const asserted = headerValue(headers['x-mcp-user-id']);
	return {
		token,
		...(asserted ? { assertedUserId: asserted } : {}),
		source: 'direct-header',
	};
}

/**
 * Reserved Relay auth surface only — never includes non-reserved `params` / `arguments`.
 * Extractors receive this shape, not the full JSON-RPC message.
 */
export interface RelayCallerAuthSurface {
	_meta?: unknown;
	meta?: unknown;
}

export function relayCallerAuthSurface(
	message: Record<string, unknown>,
): RelayCallerAuthSurface {
	const surface: RelayCallerAuthSurface = {};
	if (Object.prototype.hasOwnProperty.call(message, '_meta')) {
		surface._meta = message._meta;
	}
	if (Object.prototype.hasOwnProperty.call(message, 'meta')) {
		surface.meta = message.meta;
	}
	const params = message.params;
	if (params && typeof params === 'object' && !Array.isArray(params)) {
		const nestedMeta = (params as Record<string, unknown>)._meta;
		if (
			nestedMeta &&
			typeof nestedMeta === 'object' &&
			!Array.isArray(nestedMeta) &&
			Object.prototype.hasOwnProperty.call(nestedMeta, 'privosUser')
		) {
			const privosUser = (nestedMeta as Record<string, unknown>).privosUser;
			if (surface._meta === undefined) surface._meta = { privosUser };
			else if (surface._meta && typeof surface._meta === 'object' && !Array.isArray(surface._meta)) {
				surface._meta = { ...(surface._meta as Record<string, unknown>), privosUser };
			}
		}
	}
	return surface;
}

export async function resolveCallerCredential<TIngress>(
	extract: CallerCredentialExtractor<TIngress> | undefined,
	ingress: TIngress,
): Promise<CallerCredentialResolution> {
	if (!extract) return { kind: 'absent' };
	try {
		const credential = await extract(ingress);
		if (!credential) return { kind: 'absent' };
		if (typeof credential.token !== 'string' || !credential.token) {
			return { kind: 'error', message: 'Caller credential missing token' };
		}
		return { kind: 'present', credential };
	} catch (err) {
		return {
			kind: 'error',
			message: err instanceof Error ? err.message : 'Caller credential extractor failed',
		};
	}
}

export function ephemeralSessionScope(prefix = 'req'): string {
	return `${prefix}:${randomUUID()}`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value;
}
