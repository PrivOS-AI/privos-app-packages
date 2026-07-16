import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';

import {
	buildManifestJson,
	type AppDescriptor,
} from '../app-descriptor.js';
import type { AuthOptions } from '../auth/user-token.js';
import {
	INVALID_REQUEST,
	PARSE_ERROR,
	errorResponse,
	jsonRpcError,
} from '../protocol/errors.js';
import {
	AppServerRuntime,
	DEFAULT_MAX_MESSAGE_BYTES,
	ephemeralSessionScope,
	extractDirectCallerCredential,
	resolveCallerCredential,
	type AppErrorMapper,
	type AppMcpHandler,
	type AppServerRuntimeOptions,
	type CallerCredentialExtractor,
	type RuntimeLimits,
	type UiResourceProvider,
} from '../runtime.js';

export interface DirectRouterOptions {
	descriptor: AppDescriptor | (() => AppDescriptor | Promise<AppDescriptor>);
	handler: AppMcpHandler;
	ui?: UiResourceProvider;
	auth?: AuthOptions;
	mapAppError?: AppErrorMapper;
	limits?: RuntimeLimits;
	logger?: AppServerRuntimeOptions['logger'];
	/** Default `/mcp`. */
	mcpPath?: string;
	/** Default `/.well-known/mcp/manifest.json`. */
	manifestPath?: string;
	/**
	 * Extra CORS allowed headers. Identity/protocol headers are always included
	 * and cannot be removed by omitting them here.
	 */
	corsAllowHeaders?: string[];
	/** Override credential extraction. Must not read body/arguments. */
	extractCallerCredential?: CallerCredentialExtractor<{
		headers: Request['headers'];
	}>;
	runtime?: AppServerRuntime;
}

const REQUIRED_CORS_HEADERS = [
	'Content-Type',
	'Authorization',
	'X-MCP-User-Id',
	'Mcp-Session-Id',
	'MCP-Protocol-Version',
] as const;

/**
 * Composable Express Router for Direct MCP transport.
 * Mount with `app.use(createDirectRouter(opts))` — does not create or listen on an app,
 * and does not own `/ui`, health, ready, or register routes.
 */
export function createDirectRouter(options: DirectRouterOptions): Router {
	const runtime =
		options.runtime ??
		new AppServerRuntime({
			descriptor: options.descriptor,
			handler: options.handler,
			ui: options.ui,
			auth: options.auth,
			mapAppError: options.mapAppError,
			limits: options.limits,
			logger: options.logger,
		});

	const mcpPath = options.mcpPath ?? '/mcp';
	const manifestPath = options.manifestPath ?? '/.well-known/mcp/manifest.json';
	const allowHeaders = mergeCorsHeaders(options.corsAllowHeaders);
	const maxBytes = runtime.getLimits().maxMessageBytes || DEFAULT_MAX_MESSAGE_BYTES;

	const router = Router();

	router.use((req: Request, res: Response, next: NextFunction) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', allowHeaders.join(', '));
		if (req.method === 'OPTIONS') {
			res.status(204).end();
			return;
		}
		next();
	});

	router.get(manifestPath, async (_req, res, next) => {
		try {
			const descriptor = await runtime.resolveDescriptor();
			res.json(buildManifestJson(descriptor));
		} catch (err) {
			next(err);
		}
	});

	router.post(
		mcpPath,
		express.json({
			limit: maxBytes,
			type: 'application/json',
		}),
		async (req, res, next) => {
			try {
				await handleMcpPost(req, res, runtime, options);
			} catch (err) {
				next(err);
			}
		},
	);

	// Body errors on MCP path → stable JSON-RPC (+ HTTP status for oversize).
	router.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
		if (!isMcpPath(req, mcpPath)) {
			next(err);
			return;
		}
		if (isBodyTooLargeError(err)) {
			res.status(413).json(
				errorResponse(
					null,
					jsonRpcError(INVALID_REQUEST, 'Request too large', {
						code: 'REQUEST_TOO_LARGE',
					}),
				),
			);
			return;
		}
		if (isBodyParseError(err)) {
			res.status(200).json(errorResponse(null, jsonRpcError(PARSE_ERROR, 'Parse error')));
			return;
		}
		next(err);
	});

	return router;
}

async function handleMcpPost(
	req: Request,
	res: Response,
	runtime: AppServerRuntime,
	options: DirectRouterOptions,
): Promise<void> {
	const extract =
		options.extractCallerCredential ??
		((ingress: { headers: Request['headers'] }) =>
			extractDirectCallerCredential(
				ingress.headers as Record<string, string | string[] | undefined>,
			));

	const credentialResolution = await resolveCallerCredential(extract, {
		headers: req.headers,
	});

	const body = req.body;
	const requestId =
		body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'id')
			? (body as { id: string | number | null }).id
			: undefined;

	const sessionHeader = headerValue(req.headers['mcp-session-id']);
	const sessionScope = sessionHeader?.trim()
		? `mcp-session:${sessionHeader.trim()}`
		: ephemeralSessionScope('direct');

	const context = await runtime.buildContext({
		transport: 'direct',
		requestId,
		sessionScope,
		credentialResolution,
	});

	const outcome = await runtime.dispatchObject(body, context);

	if (outcome.type === 'no_response' || outcome.type === 'protocol_warning') {
		res.status(202).end();
		return;
	}

	res.status(200).json(outcome.response);
}

function isMcpPath(req: Request, mcpPath: string): boolean {
	const path = req.path || req.url?.split('?')[0] || '';
	return path === mcpPath || path.endsWith(mcpPath);
}

function isBodyParseError(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false;
	const e = err as { type?: string; status?: number; statusCode?: number; name?: string };
	return (
		e.type === 'entity.parse.failed' ||
		e.name === 'SyntaxError' ||
		((e.status === 400 || e.statusCode === 400) && e.type !== 'entity.too.large')
	);
}

function isBodyTooLargeError(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false;
	const e = err as { type?: string; status?: number; statusCode?: number };
	return (
		e.type === 'entity.too.large' ||
		e.status === 413 ||
		e.statusCode === 413
	);
}

function headerValue(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value;
}

function mergeCorsHeaders(extra?: string[]): string[] {
	const set = new Set<string>(REQUIRED_CORS_HEADERS.map((h) => h.toLowerCase()));
	const ordered: string[] = [...REQUIRED_CORS_HEADERS];
	for (const h of extra ?? []) {
		if (!set.has(h.toLowerCase())) {
			set.add(h.toLowerCase());
			ordered.push(h);
		}
	}
	return ordered;
}

export { AppServerRuntime, extractDirectCallerCredential };
