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
	type CallerCredentialResolution,
	type AppErrorMapper,
	type AppMcpHandler,
	type AppServerRuntimeOptions,
	type CallerCredentialExtractor,
	type RuntimeLimits,
	type UiResourceProvider,
} from '../runtime.js';
import { getWorkloadIdentityClient, type WorkloadIdentityClient } from '../workload/workload-identity.js';
import {
	isUnsignedRuntimeReadinessRpcV3,
	verifyClusterDispatchAssertionV3,
	verifyDispatchAssertion,
	verifyRuntimeDispatchAssertionV3,
	type RuntimeDispatchSecurityV3,
	type VerifiedRuntimeAuthorizationV3,
} from '../workload/dispatch-assertion.js';
import type { WorkloadBrokerContext } from '../workload/workload-identity.js';

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
	/** Require Hub dispatch assertions when the Cluster identity socket is mounted. */
	workloadSecurity?: 'auto' | 'required' | 'disabled';
	/** Optional app-owned client; useful when readiness and ingress share one broker session. */
	workloadIdentityClient?: WorkloadIdentityClient;
	/** Explicit required final-boundary authorization for local or publisher protocol-v3 runtimes. */
	runtimeDispatchV3?: RuntimeDispatchSecurityV3;
}

const REQUIRED_CORS_HEADERS = [
	'Content-Type',
	'Authorization',
	'X-MCP-User-Id',
	'Mcp-Session-Id',
	'MCP-Protocol-Version',
	'X-PrivOS-Dispatch-Assertion',
	'X-PrivOS-MCP-Dispatch-Assertion',
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
	if (options.runtimeDispatchV3 && mcpPath !== '/mcp') {
		throw new Error('Protocol-v3 runtime dispatch requires the canonical /mcp path.');
	}
	if (options.runtimeDispatchV3 && options.workloadSecurity === 'required') {
		throw new Error('Legacy managed workload security and runtime-v3 security cannot both be required.');
	}
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
	const body = req.body;
	const candidateRequestId =
		body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'id')
			? (body as { id: unknown }).id
			: undefined;
	const requestId = candidateRequestId === null ||
		typeof candidateRequestId === 'string' ||
		typeof candidateRequestId === 'number'
		? candidateRequestId
		: undefined;

	let runtimeAuthorization: VerifiedRuntimeAuthorizationV3 | undefined;
	let managedBrokerContext: WorkloadBrokerContext | undefined;
	let callerAuth = options.auth;
	const managedAssertionHeaders = rawHeaderValues(req, 'x-privos-dispatch-assertion');
	const runtimeAssertionHeaders = rawHeaderValues(req, 'x-privos-mcp-dispatch-assertion');
	const unsupportedRuntimeAffinityHeaders = [
		...rawHeaderValues(req, 'x-privos-mcp-runtime-installation-id'),
		...rawHeaderValues(req, 'x-privos-mcp-authorization-binding-id'),
	];
	if (unsupportedRuntimeAffinityHeaders.length > 0) {
		denyDispatch(res, requestId);
		return;
	}
	if (
		managedAssertionHeaders.length > 1 ||
		runtimeAssertionHeaders.length > 1 ||
		(managedAssertionHeaders.length > 0 && runtimeAssertionHeaders.length > 0)
	) {
		denyDispatch(res, requestId);
		return;
	}
	if (options.runtimeDispatchV3) {
		try {
			if (managedAssertionHeaders.length > 0) {
				throw new Error('dispatch_assertion_ambiguous');
			}
			if (runtimeAssertionHeaders.length === 0) {
				if (!isUnsignedRuntimeReadinessRpcV3(body, options.runtimeDispatchV3)) {
					throw new Error('dispatch_assertion_missing');
				}
			} else {
				runtimeAuthorization = await verifyRuntimeDispatchAssertionV3({
					compact: runtimeAssertionHeaders[0]!,
					body,
					security: options.runtimeDispatchV3,
				});
			}
		} catch {
			denyDispatch(res, requestId);
			return;
		}
	} else {
		if (runtimeAssertionHeaders.length > 0) {
			denyDispatch(res, requestId);
			return;
		}
		const workloadClient = options.workloadIdentityClient ?? getWorkloadIdentityClient();
		const workloadSecurity = options.workloadSecurity ?? 'auto';
		const requireDispatchAssertion = workloadSecurity === 'required' || (workloadSecurity === 'auto' && workloadClient.isAvailable());
		if (requireDispatchAssertion) {
			try {
				const assertion = managedAssertionHeaders[0];
				if (!assertion) throw new Error('dispatch_assertion_missing');
				const brokerContext = await workloadClient.brokerContext();
				if (brokerContext.binding.generation) {
					runtimeAuthorization = verifyClusterDispatchAssertionV3({ compact: assertion, body, context: brokerContext });
					managedBrokerContext = brokerContext;
					const descriptor = await runtime.resolveDescriptor();
					callerAuth = managedHubUserAuth(brokerContext, descriptor.id, options.auth);
				} else {
					verifyDispatchAssertion({ compact: assertion, body, context: brokerContext });
				}
			} catch {
				denyDispatch(res, requestId);
				return;
			}
		} else if (managedAssertionHeaders.length > 0) {
			denyDispatch(res, requestId);
			return;
		}
	}
	const credentialResolution = managedBrokerContext
		? strictDirectCallerCredential(req)
		: await resolveCallerCredential(
				options.extractCallerCredential ??
					((ingress: { headers: Request['headers'] }) =>
						extractDirectCallerCredential(
							ingress.headers as Record<string, string | string[] | undefined>,
						)),
				{ headers: req.headers },
			);
	if (managedBrokerContext && credentialResolution.kind === 'error') {
		denyDispatch(res, requestId);
		return;
	}

	const sessionHeader = headerValue(req.headers['mcp-session-id']);
	const sessionScope = sessionHeader?.trim()
		? `mcp-session:${sessionHeader.trim()}`
		: ephemeralSessionScope('direct');

	let context;
	try {
		context = await runtime.buildContext({
			transport: 'direct',
			requestId,
			sessionScope,
			credentialResolution,
			...(callerAuth ? { auth: callerAuth } : {}),
			...(runtimeAuthorization ? { runtimeAuthorization } : {}),
		});
	} catch (error) {
		if (runtimeAuthorization && error instanceof Error && error.message === 'dispatch_assertion_binding_mismatch') {
			denyDispatch(res, requestId);
			return;
		}
		throw error;
	}
	if (
		runtimeAuthorization?.authorizationContext === 'room' &&
		(context.identityState !== 'verified' || !context.actor)
	) {
		denyDispatch(res, requestId);
		return;
	}

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

function rawHeaderValues(req: Request, name: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < req.rawHeaders.length; index += 2) {
		if (req.rawHeaders[index]?.toLowerCase() === name) values.push(req.rawHeaders[index + 1] ?? '');
	}
	return values;
}

function strictDirectCallerCredential(req: Request): CallerCredentialResolution {
	const authorization = rawHeaderValues(req, 'authorization');
	const assertedUserIds = rawHeaderValues(req, 'x-mcp-user-id');
	if (authorization.length === 0 && assertedUserIds.length === 0) return { kind: 'absent' };
	if (authorization.length !== 1 || assertedUserIds.length !== 1) {
		return { kind: 'error', message: 'Caller credential headers are incomplete or ambiguous' };
	}
	const auth = authorization[0]!;
	const assertedUserId = assertedUserIds[0]!;
	if (
		!auth.startsWith('Bearer ') ||
		auth.slice('Bearer '.length).trim() !== auth.slice('Bearer '.length) ||
		!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(auth.slice('Bearer '.length)) ||
		Buffer.byteLength(auth.slice('Bearer '.length), 'utf8') > 32_768 ||
		!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(assertedUserId)
	) {
		return { kind: 'error', message: 'Caller credential headers are malformed' };
	}
	return {
		kind: 'present',
		credential: {
			token: auth.slice('Bearer '.length),
			assertedUserId,
			source: 'direct-header',
		},
	};
}

function managedHubUserAuth(
	context: WorkloadBrokerContext,
	audience: string,
	base?: AuthOptions,
): AuthOptions {
	return {
		jwksUrl: new URL('/.well-known/mcp-apps/jwks.json', context.hubOrigin),
		audience,
		issuer: context.hubOrigin,
		...(base?.clockToleranceSeconds !== undefined ? { clockToleranceSeconds: base.clockToleranceSeconds } : {}),
		...(base?.jwksCacheTtlMs !== undefined ? { jwksCacheTtlMs: base.jwksCacheTtlMs } : {}),
		...(base?.fetchTimeoutMs !== undefined ? { fetchTimeoutMs: base.fetchTimeoutMs } : {}),
	};
}

function denyDispatch(res: Response, requestId: string | number | null | undefined): void {
	res.status(403).json(
		errorResponse(requestId ?? null, jsonRpcError(INVALID_REQUEST, 'Authenticated private dispatch required', {
			code: 'DISPATCH_ASSERTION_INVALID',
		})),
	);
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
