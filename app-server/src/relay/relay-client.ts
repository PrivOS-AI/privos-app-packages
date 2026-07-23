import WebSocket, { type RawData } from 'ws';

import {
	buildPairingMetadata,
	type AppDescriptor,
} from '../app-descriptor.js';
import type { AuthOptions } from '../auth/user-token.js';
import {
	PARSE_ERROR,
	errorResponse,
	jsonRpcError,
} from '../protocol/errors.js';
import {
	AppServerRuntime,
	DEFAULT_MAX_MESSAGE_BYTES,
	relayCallerAuthSurface,
	resolveCallerCredential,
	type AppErrorMapper,
	type AppMcpHandler,
	type AppServerRuntimeOptions,
	type CallerCredentialExtractor,
	type RelayCallerAuthSurface,
	type RuntimeLimits,
	type UiResourceProvider,
} from '../runtime.js';
import { MessageTooLargeError, rawDataToText } from './message-adapter.js';

export interface PairAppMeta {
	name: string;
	description?: string;
	version?: string;
	icon?: string;
	scopes?: string[];
}

export interface PairingResult {
	privosUrl: string;
	clientId: string;
	clientSecret: string;
	mcpAppId?: string;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const DEFAULT_PAIRING_TIMEOUT_MS = 30_000;
const DEFAULT_OAUTH_TIMEOUT_MS = 15_000;
const DEFAULT_OPEN_HANDSHAKE_TIMEOUT_MS = 15_000;

export interface RelayClientOptions {
	privosUrl: string;
	clientId: string;
	clientSecret: string;
	descriptor: AppDescriptor | (() => AppDescriptor | Promise<AppDescriptor>);
	handler: AppMcpHandler;
	ui?: UiResourceProvider;
	auth?: AuthOptions;
	mapAppError?: AppErrorMapper;
	limits?: RuntimeLimits;
	logger?: AppServerRuntimeOptions['logger'];
	/**
	 * Extract credentials from reserved Relay auth surface only (`_meta` / `meta`).
	 * Never receives `params` / `arguments`.
	 */
	extractCallerCredential?: CallerCredentialExtractor<RelayCallerAuthSurface>;
	oauthTimeoutMs?: number;
	/** Timeout waiting for WebSocket `open` after create (default 15s). */
	openHandshakeTimeoutMs?: number;
	/** Injected for tests. */
	fetchImpl?: typeof fetch;
	WebSocketImpl?: typeof WebSocket;
	runtime?: AppServerRuntime;
}

export interface RelayHandle {
	/** Stop reconnecting and close the active socket. */
	stop(): Promise<void>;
	/** Resolves when the first successful connection opens (or rejects if stopped first). */
	whenConnected(): Promise<void>;
}

/**
 * Pair with Privos using a one-time pairing URL.
 * Does not persist credentials — caller is responsible for saving them.
 */
export function pairOverWebSocket(
	pairUrl: string,
	appMeta: PairAppMeta,
	WebSocketImpl: typeof WebSocket = WebSocket,
	options?: { timeoutMs?: number },
): Promise<PairingResult> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS;

	return new Promise((resolve, reject) => {
		const ws = new WebSocketImpl(pairUrl);
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};

		const timer = setTimeout(() => {
			settle(() => {
				try {
					ws.close();
				} catch {
					/* ignore */
				}
				reject(new Error(`Pairing timed out after ${timeoutMs}ms`));
			});
		}, timeoutMs);

		ws.on('open', () => {
			try {
				ws.send(
					JSON.stringify({
						name: appMeta.name,
						description: appMeta.description || '',
						version: appMeta.version || '0.0.0',
						...(appMeta.icon && { icon: appMeta.icon }),
						...(appMeta.scopes?.length && { scopes: appMeta.scopes }),
					}),
				);
			} catch (err) {
				settle(() =>
					reject(err instanceof Error ? err : new Error(String(err))),
				);
			}
		});

		ws.on('message', (raw: RawData) => {
			try {
				const msg = JSON.parse(rawDataToText(raw)) as {
					error?: { message?: string };
					result?: {
						paired?: boolean;
						clientId?: string;
						clientSecret?: string;
						relayUrl?: string;
						mcpAppId?: string;
						appId?: string;
						app?: { _id?: string };
					};
				};
				if (msg.error) {
					settle(() => reject(new Error(msg.error?.message || 'Pairing failed')));
					return;
				}
				if (msg.result?.paired) {
					const { clientId, clientSecret, relayUrl, app, mcpAppId, appId } = msg.result;
					if (!clientId || !clientSecret || !relayUrl) {
						settle(() => reject(new Error('Pairing response missing credentials')));
						return;
					}
					const privosUrl = relayUrl
						.replace(/^ws/, 'http')
						.replace(/\/api\/v1\/mcp-apps\.relay.*/, '');
					const resolvedAppId =
						(typeof mcpAppId === 'string' && mcpAppId) ||
						(typeof appId === 'string' && appId) ||
						(typeof app?._id === 'string' && app._id) ||
						undefined;
					settle(() =>
						resolve({
							privosUrl,
							clientId,
							clientSecret,
							mcpAppId: resolvedAppId,
						}),
					);
					try {
						ws.close();
					} catch {
						/* ignore */
					}
				}
			} catch (err) {
				settle(() =>
					reject(err instanceof Error ? err : new Error(String(err))),
				);
			}
		});

		ws.on('error', (err) => {
			settle(() => reject(new Error(`Pairing failed: ${err.message}`)));
		});

		ws.on('close', (code, reason) => {
			// Any close before a paired result ends the promise (including 1000).
			settle(() => {
				if (code === 1000) {
					reject(new Error('Pairing closed before credentials were received'));
				} else {
					reject(new Error(`Pairing closed: ${code} ${reason}`));
				}
			});
		});
	});
}

export async function pairFromDescriptor(
	pairUrl: string,
	descriptor: AppDescriptor,
	WebSocketImpl?: typeof WebSocket,
	options?: { timeoutMs?: number },
): Promise<PairingResult> {
	return pairOverWebSocket(
		pairUrl,
		buildPairingMetadata(descriptor),
		WebSocketImpl,
		options,
	);
}

/**
 * Connect to PrivOS relay WebSocket with exponential backoff, token refresh,
 * single reconnect timer, and explicit stop().
 */
export function connectRelay(opts: RelayClientOptions): RelayHandle {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
	const runtime =
		opts.runtime ??
		new AppServerRuntime({
			descriptor: opts.descriptor,
			handler: opts.handler,
			ui: opts.ui,
			auth: opts.auth,
			mapAppError: opts.mapAppError,
			limits: opts.limits,
			logger: opts.logger,
		});

	const maxMessageBytes =
		opts.limits?.maxMessageBytes ??
		runtime.getLimits().maxMessageBytes ??
		DEFAULT_MAX_MESSAGE_BYTES;
	const oauthTimeoutMs = opts.oauthTimeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
	const openHandshakeTimeoutMs =
		opts.openHandshakeTimeoutMs ?? DEFAULT_OPEN_HANDSHAKE_TIMEOUT_MS;
	const maxBufferedBytes = runtime.getLimits().maxBufferedBytes;

	let stopped = false;
	let activeWs: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let openHandshakeTimer: ReturnType<typeof setTimeout> | null = null;
	let backoffIndex = 0;
	let connectGeneration = 0;
	let oauthAbort: AbortController | null = null;

	let connectedResolve: (() => void) | null = null;
	let connectedReject: ((err: Error) => void) | null = null;
	let connectedOnce = false;
	const connectedPromise = new Promise<void>((resolve, reject) => {
		connectedResolve = resolve;
		connectedReject = reject;
	});
	// Prevent unhandledrejection when consumers never call whenConnected().
	// Explicit await whenConnected() still receives the rejection.
	void connectedPromise.catch(() => undefined);

	const log = (event: string, fields: Record<string, unknown> = {}) => {
		opts.logger?.(event, fields);
	};

	const clearReconnectTimer = () => {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	};

	const clearOpenHandshakeTimer = () => {
		if (openHandshakeTimer) {
			clearTimeout(openHandshakeTimer);
			openHandshakeTimer = null;
		}
	};

	const scheduleReconnect = () => {
		if (stopped) return;
		if (reconnectTimer) return;
		const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)] ?? 30_000;
		backoffIndex = Math.min(backoffIndex + 1, BACKOFF_MS.length - 1);
		log('relay.reconnect.scheduled', { delayMs: delay });
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			void openConnection().catch((err) => {
				log('relay.open_unhandled', {
					message: err instanceof Error ? err.message : String(err),
				});
			});
		}, delay);
	};

	async function getAccessToken(signal: AbortSignal): Promise<string> {
		const res = await fetchImpl(`${opts.privosUrl}/oauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: `grant_type=client_credentials&client_id=${encodeURIComponent(opts.clientId)}&client_secret=${encodeURIComponent(opts.clientSecret)}`,
			signal,
		});
		if (!res.ok) throw new Error(`OAuth token failed: ${res.status} ${res.statusText}`);
		const data = (await res.json()) as { access_token?: string };
		if (!data.access_token) throw new Error('No access_token in response');
		return data.access_token;
	}

	async function openConnection(): Promise<void> {
		if (stopped) return;
		const generation = ++connectGeneration;
		oauthAbort?.abort();
		oauthAbort = new AbortController();
		const oauthTimer = setTimeout(() => oauthAbort?.abort(), oauthTimeoutMs);

		try {
			const accessToken = await getAccessToken(oauthAbort.signal);
			if (stopped || generation !== connectGeneration) return;

			const wsUrl = opts.privosUrl.replace(/^http/, 'ws') + '/api/v1/mcp-apps.relay';
			const ws = new WebSocketImpl(wsUrl, {
				headers: { Authorization: `Bearer ${accessToken}` },
			});

			if (activeWs && activeWs !== ws) {
				try {
					activeWs.removeAllListeners();
					activeWs.close();
				} catch {
					/* ignore */
				}
			}
			activeWs = ws;

			clearOpenHandshakeTimer();
			openHandshakeTimer = setTimeout(() => {
				openHandshakeTimer = null;
				if (stopped || generation !== connectGeneration) return;
				if (ws.readyState === WebSocketImpl.OPEN) return;
				log('relay.open_handshake_timeout', {
					generation,
					timeoutMs: openHandshakeTimeoutMs,
				});
				try {
					ws.close();
				} catch {
					/* ignore */
				}
				// close handler schedules reconnect when generation still current
			}, openHandshakeTimeoutMs);

			ws.on('open', () => {
				clearOpenHandshakeTimer();
				if (stopped || generation !== connectGeneration) {
					try {
						ws.close();
					} catch {
						/* ignore */
					}
					return;
				}
				backoffIndex = 0;
				log('relay.connected', { generation });
				if (!connectedOnce) {
					connectedOnce = true;
					connectedResolve?.();
				}
			});

			ws.on('message', (raw: RawData) => {
				void handleMessage(ws, generation, raw).catch((err) => {
					log('relay.message_unhandled', {
						reason: 'handler_failed',
						generation,
						...(err instanceof Error ? { name: err.name } : {}),
					});
				});
			});

			ws.on('ping', () => {
				try {
					ws.pong();
				} catch {
					/* ignore */
				}
			});

			ws.on('close', (code) => {
				clearOpenHandshakeTimer();
				log('relay.disconnected', { code, generation });
				if (activeWs === ws) activeWs = null;
				if (!stopped && generation === connectGeneration) {
					scheduleReconnect();
				}
			});

			ws.on('error', (err) => {
				log('relay.ws_error', { reason: 'ws_error', generation, name: err.name });
			});
		} catch (err) {
			log('relay.connect_failed', {
				message: err instanceof Error ? err.message : String(err),
				generation,
			});
			if (!stopped && generation === connectGeneration) {
				scheduleReconnect();
			}
		} finally {
			clearTimeout(oauthTimer);
		}
	}

	function safeSend(
		ws: WebSocket,
		payload: unknown,
		rpcFields: { generation?: number; method?: string; toolName?: string } = {},
	): void {
		if (ws.readyState !== WebSocketImpl.OPEN) return;
		if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > maxBufferedBytes) {
			log('relay.backpressure', {
				bufferedAmount: ws.bufferedAmount,
				maxBufferedBytes,
			});
			return;
		}
		let text: string;
		try {
			text = JSON.stringify(payload);
		} catch {
			log('relay.serialize_error', { reason: 'json_stringify_failed' });
			return;
		}
		try {
			const payloadObject =
				payload && typeof payload === 'object' && !Array.isArray(payload)
					? (payload as Record<string, unknown>)
					: undefined;
			const responseId =
				payloadObject &&
				Object.prototype.hasOwnProperty.call(payloadObject, 'id') &&
				(typeof payloadObject.id === 'string' ||
					typeof payloadObject.id === 'number' ||
					payloadObject.id === null)
					? (payloadObject.id as string | number | null)
					: undefined;
			log('relay.rpc.outbound', {
				direction: '→',
				...rpcFields,
				...(responseId !== undefined ? { requestId: responseId } : {}),
				responseKind: payloadObject && 'error' in payloadObject ? 'error' : 'result',
			});
			ws.send(text, (err) => {
				if (err) {
					log('relay.send_error', { reason: 'send_callback_error', name: err.name });
				}
			});
		} catch (err) {
			log('relay.send_error', {
				reason: 'send_threw',
				...(err instanceof Error ? { name: err.name } : {}),
			});
		}
	}

	async function handleMessage(
		ws: WebSocket,
		generation: number,
		raw: RawData,
	): Promise<void> {
		if (stopped || generation !== connectGeneration) return;

		let text: string;
		try {
			text = rawDataToText(raw, maxMessageBytes);
		} catch (err) {
			log('relay.message_too_large', {
				message: err instanceof Error ? err.message : String(err),
				...(err instanceof MessageTooLargeError
					? { bytes: err.bytes, maxBytes: err.maxBytes }
					: {}),
			});
			try {
				ws.close(1009, 'Message too large');
			} catch {
				/* ignore */
			}
			return;
		}

		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(text);
		} catch {
			safeSend(ws, errorResponse(null, jsonRpcError(PARSE_ERROR, 'Parse error')), {
				generation,
			});
			return;
		}

		const msgObj =
			parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)
				? (parsedJson as Record<string, unknown>)
				: {};

		const authSurface = relayCallerAuthSurface(msgObj);
		const credentialResolution = await resolveCallerCredential(
			opts.extractCallerCredential,
			authSurface,
		);

		const requestId =
			Object.prototype.hasOwnProperty.call(msgObj, 'id') &&
			(typeof msgObj.id === 'string' || typeof msgObj.id === 'number' || msgObj.id === null)
				? (msgObj.id as string | number | null)
				: undefined;
		const method = typeof msgObj.method === 'string' ? msgObj.method : undefined;
		const params =
			msgObj.params && typeof msgObj.params === 'object' && !Array.isArray(msgObj.params)
				? (msgObj.params as Record<string, unknown>)
				: undefined;
		const toolName =
			method === 'tools/call' && typeof params?.name === 'string' ? params.name : undefined;
		log('relay.rpc.inbound', {
			direction: '←',
			generation,
			...(requestId !== undefined ? { requestId } : { notification: true }),
			...(method ? { method } : {}),
			...(toolName ? { toolName } : {}),
		});

		const context = await runtime.buildContext({
			transport: 'relay',
			requestId,
			sessionScope: `ws:${generation}`,
			credentialResolution,
		});

		const outcome = await runtime.dispatchObject(parsedJson, context);

		if (outcome.type === 'no_response' || outcome.type === 'protocol_warning') {
			return;
		}

		safeSend(ws, outcome.response, { generation, method, toolName });
	}

	void openConnection().catch((err) => {
		log('relay.open_unhandled', {
			message: err instanceof Error ? err.message : String(err),
		});
	});

	return {
		whenConnected: () => connectedPromise,
		async stop() {
			stopped = true;
			clearReconnectTimer();
			clearOpenHandshakeTimer();
			connectGeneration += 1;
			oauthAbort?.abort();
			oauthAbort = null;
			const ws = activeWs;
			activeWs = null;
			if (ws) {
				await new Promise<void>((resolve) => {
					try {
						ws.once('close', () => resolve());
						ws.close();
						setTimeout(resolve, 0);
					} catch {
						resolve();
					}
				});
			}
			if (!connectedOnce) {
				connectedReject?.(new Error('Relay stopped before connecting'));
			}
			log('relay.stopped', {});
		},
	};
}
