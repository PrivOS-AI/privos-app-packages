/**
 * MCP app server — serves manifest, handles MCP JSON-RPC calls, and serves UI.
 *
 * RUNTIME MODE
 * ------------
 * `resolveRuntimeMode()` picks exactly one of three ways this app talks to
 * its Hub, in this precedence: `managed` (workload identity socket present —
 * cluster-routed), `standalone-production` (a paired standalone identity file
 * is present — Relay transport, mandatory signed dispatch), `development`
 * (neither present; only allowed when `NODE_ENV` is not `production`). Both
 * signals present at once is a startup error, never a silent pick. Pair this
 * app first with `pairOverWebSocket` to produce the standalone identity file.
 *
 * `standalone-production` bypasses the Direct HTTP block below entirely and
 * talks to the Hub only over the already-authenticated Relay WebSocket; see
 * `startStandaloneProductionRelay()`.
 *
 * USER IDENTITY
 * -------------
 * The hub delivers a signed RS256 JWT (`userToken`) to the app iframe on every
 * HOST_CONTEXT_CHANGED event. The iframe SDK makes it available via
 * `usePrivosUserToken()`. When the iframe calls THIS backend it should forward
 * the token as `Authorization: Bearer <userToken>`.
 *
 * Verify identity with `@privos_ai/app-server/auth` — do not copy a second JWKS
 * verifier into this app.
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { readFileSync } from 'fs';
import path from 'path';
import {
	BoundedRuntimeDispatchReplayConsumerV3,
	connectRelay,
	createPinnedPortalJwksResolverV3,
	createPublisherRuntimeTrustProvisioningRouterV3,
	createDirectRouter,
	createStandaloneReadinessCheck,
	createStandaloneRelayIdentityController,
	loadStandaloneIdentity,
	parseRuntimeDispatchTrustV3Json,
	resolveRuntimeMode,
	RuntimeModeError,
	SingleProcessFilePublisherRuntimeTrustStoreV3,
	standaloneIdentityFileExists,
	verifyPrivosUser,
	type AppDescriptor,
	type ApplicationMcpRequest,
	type AuthOptions,
	type DirectRouterOptions,
	type RuntimeModeResolution,
	type ToolCallContext,
	type UiResourceProvider,
	type VerifiedActor,
} from '@privos_ai/app-server';

const PRIVOS_HUB_URL = process.env.PRIVOS_HUB_URL || 'https://your-hub.example.com';
const publisherManifest = JSON.parse(
	readFileSync(path.resolve(process.cwd(), 'privos-app.json'), 'utf8'),
) as {
	name: string;
	version: string;
	title: string;
	description: string;
	author: { name: string; email?: string; website?: string };
	scopes: string[];
	tools: Array<Record<string, unknown> & { ui?: Record<string, unknown> }>;
	port: number;
	runtimeTrustProvisioningUrl?: string;
};
const APP_ID = publisherManifest.name;

function publisherTrustBootstrap() {
	const filePath = process.env.PRIVOS_PUBLISHER_RUNTIME_TRUST_STORE_PATH;
	const jwksUrl = process.env.PRIVOS_PORTAL_JWKS_URL;
	const issuer = process.env.PRIVOS_PORTAL_ISSUER;
	const singleProcess = process.env.PRIVOS_PUBLISHER_SINGLE_PROCESS;
	const anyConfigured = Boolean(filePath || jwksUrl || issuer || singleProcess);
	if (!anyConfigured) return undefined;
	if (
		!filePath ||
		!jwksUrl ||
		!issuer ||
		singleProcess !== 'true' ||
		!publisherManifest.runtimeTrustProvisioningUrl
	) {
		throw new Error(
			'Publisher runtime trust requires the reviewed runtimeTrustProvisioningUrl plus '
			+ 'PRIVOS_PUBLISHER_RUNTIME_TRUST_STORE_PATH, PRIVOS_PORTAL_JWKS_URL, '
			+ 'PRIVOS_PORTAL_ISSUER, and PRIVOS_PUBLISHER_SINGLE_PROCESS=true.',
		);
	}
	const store = new SingleProcessFilePublisherRuntimeTrustStoreV3({
		filePath,
		deploymentMode: 'single-process',
	});
	return {
		store,
		portalJwksResolver: createPinnedPortalJwksResolverV3({ issuer, jwksUrl }),
		provisioningUrl: publisherManifest.runtimeTrustProvisioningUrl,
	};
}

const publisherTrust = publisherTrustBootstrap();

/**
 * Direct-HTTP-only security selection (`managed-v2` via the workload broker,
 * or `runtime-v3` publisher-hosted dispatch). Independent of
 * `resolveRuntimeMode()` — a publicly reachable publisher-hosted app may run
 * `runtime-v3` over Direct HTTP with no workload socket and no paired
 * standalone identity file at all. When a standalone identity file IS present
 * (this app was paired), its trust supersedes the raw
 * `PRIVOS_RUNTIME_DISPATCH_TRUST_V3` env var for `runtime-v3`; the env var
 * still works when there is no paired file.
 */
function runtimeBoundaryOptions(): Pick<
	DirectRouterOptions,
	'workloadSecurity' | 'runtimeDispatchV3'
> {
	const mode = process.env.PRIVOS_RUNTIME_SECURITY_MODE;
	if (publisherTrust && mode !== 'runtime-v3') {
		throw new Error('Publisher runtime trust provisioning requires PRIVOS_RUNTIME_SECURITY_MODE=runtime-v3.');
	}
	if (!mode) {
		if (process.env.NODE_ENV === 'production') {
			throw new Error('PRIVOS_RUNTIME_SECURITY_MODE is required in production.');
		}
		return { workloadSecurity: 'disabled' };
	}
	if (mode === 'managed-v2') return { workloadSecurity: 'required' };
	if (mode !== 'runtime-v3') {
		throw new Error('PRIVOS_RUNTIME_SECURITY_MODE must be managed-v2 or runtime-v3.');
	}
	if (publisherTrust) {
		return {
			runtimeDispatchV3: {
				mode: 'required',
				trust: (hint) => publisherTrust.store.resolveDispatchTrust(hint),
				replayConsumer: publisherTrust.store,
			},
		};
	}
	const readiness = process.env.PRIVOS_RUNTIME_ALLOW_UNSIGNED_PREACTIVATION_READINESS;
	if (readiness !== undefined && readiness !== 'true' && readiness !== 'false') {
		throw new Error('PRIVOS_RUNTIME_ALLOW_UNSIGNED_PREACTIVATION_READINESS must be true or false.');
	}
	const trust = standaloneIdentityFileExists()
		? loadStandaloneIdentity().trust
		: (() => {
				const rawTrust = process.env.PRIVOS_RUNTIME_DISPATCH_TRUST_V3;
				if (!rawTrust) {
					throw new Error(
						'runtime-v3 requires either a paired standalone identity file (pairOverWebSocket) '
						+ 'or PRIVOS_RUNTIME_DISPATCH_TRUST_V3.',
					);
				}
				return parseRuntimeDispatchTrustV3Json(rawTrust);
			})();
	return {
		runtimeDispatchV3: {
			mode: 'required',
			trust,
			// Process-local and bounded. Publisher HA must replace this with a
			// shared atomic JTI+nonce consumer before running multiple replicas.
			replayConsumer: new BoundedRuntimeDispatchReplayConsumerV3(),
			// Exact, Direct-only, non-authorizing Hub activation probe.
			...(readiness === 'true'
				? { unsignedReadiness: 'initialize-and-tools-list' as const }
				: {}),
		},
	};
}

const authOptions: AuthOptions = {
	jwksUrl: `${PRIVOS_HUB_URL}/.well-known/mcp-apps/jwks.json`,
	audience: APP_ID,
	...(process.env.PRIVOS_HUB_ISSUER ? { issuer: process.env.PRIVOS_HUB_ISSUER } : {}),
};

/** @deprecated Prefer importing `verifyPrivosUser` from `@privos_ai/app-server/auth`. */
export async function verifyPrivosUserFromHeader(
	authHeader: string | undefined,
): Promise<VerifiedActor> {
	return verifyPrivosUser(authHeader, authOptions);
}

export async function requirePrivosUser(req: Request, res: Response, next: NextFunction): Promise<void> {
	try {
		(req as Request & { privosUser?: VerifiedActor }).privosUser = await verifyPrivosUser(
			req.headers.authorization,
			authOptions,
		);
		next();
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'Unauthorized';
		res.status(401).json({ error: 'Unauthorized', detail: message });
	}
}

declare global {
	namespace Express {
		interface Request {
			privosUser?: VerifiedActor;
		}
	}
}

const descriptor: AppDescriptor = {
	id: APP_ID,
	name: publisherManifest.title,
	version: publisherManifest.version,
	title: publisherManifest.title,
	description: publisherManifest.description,
	author: publisherManifest.author,
	scopes: publisherManifest.scopes,
};

async function mcpHandler(request: ApplicationMcpRequest, _ctx: ToolCallContext) {
	if (request.method === 'tools/list') {
		return {
			tools: publisherManifest.tools.map((declaredTool) => {
				const { ui, ...tool } = declaredTool;
				return {
					...tool,
					...(ui ? { _meta: { ui } } : {}),
				};
			}),
		};
	}

	throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
}

const dashboardUi: UiResourceProvider = {
	uri: 'ui://{{APP_NAME}}/dashboard.html',
	renderHtml: async () => process.env.NODE_ENV === 'production'
		? readFileSync(path.resolve(process.cwd(), 'dist/index.html'), 'utf8')
		: `<!DOCTYPE html>
<html><head><title>{{APP_NAME}}</title><style>html,body{margin:0}</style></head>
<body><div id="root"></div>
<script type="module" src="http://localhost:5173/src/ui/main.tsx"></script>
</body></html>`,
};

/**
 * `managed` / `development` — Direct HTTP transport, unchanged from prior
 * template versions. `runtime-v3` (see `runtimeBoundaryOptions`) can also run
 * here for a publicly reachable publisher-hosted app.
 */
function startDirectHttp(): void {
	const runtimeBoundary = runtimeBoundaryOptions();
	const app = express();
	if (publisherTrust) {
		app.use(createPublisherRuntimeTrustProvisioningRouterV3({
			provisioningUrl: publisherTrust.provisioningUrl,
			mcpAppId: APP_ID,
			portalJwksResolver: publisherTrust.portalJwksResolver,
			store: publisherTrust.store,
		}));
	}
	app.use(express.json());
	app.use(express.static(path.resolve(process.cwd(), 'dist')));

	// The runtime exposes the exact reviewed Publisher manifest.
	app.get('/.well-known/mcp/manifest.json', (_req, res) => {
		res.json(publisherManifest);
	});

	app.use(
		createDirectRouter({
			descriptor,
			handler: mcpHandler,
			auth: authOptions,
			...runtimeBoundary,
			ui: dashboardUi,
		}),
	);

	app.get('/api/me', requirePrivosUser, (req, res) => {
		res.json({ user: req.privosUser });
	});

	const PORT = Number(process.env.PORT || publisherManifest.port || 3001);
	const server = app.listen(PORT, () => {
		console.log(`MCP app listening on http://localhost:${PORT}`);
	});

	function shutdown(signal: string): void {
		console.log(`Received ${signal}; shutting down`);
		server.close(async (error) => {
			await publisherTrust?.store.close();
			if (error) {
				console.error('Failed to close MCP app server', error);
				process.exitCode = 1;
			}
		});
	}

	process.once('SIGTERM', () => shutdown('SIGTERM'));
	process.once('SIGINT', () => shutdown('SIGINT'));
}

/**
 * `standalone-production` — this app was paired with `pairOverWebSocket`
 * (see `PRIVOS_STANDALONE_IDENTITY_FILE`). MCP dispatch rides the Relay
 * WebSocket only, with mandatory signed-assertion verification and automatic
 * secret/trust rotation and capabilities push — never a Direct HTTP MCP
 * surface. `/health` and `/ready` match the managed workload's JSON shape.
 */
function startStandaloneProductionRelay(): void {
	const loaded = loadStandaloneIdentity();
	const identityController = createStandaloneRelayIdentityController(loaded, {
		logger: (event, fields) => console.log(`[standalone] ${event}`, fields),
	});

	const relayHandle = connectRelay({
		privosUrl: loaded.relay.privosUrl,
		standaloneIdentity: identityController,
		descriptor,
		handler: mcpHandler,
		ui: dashboardUi,
		logger: (event, fields) => {
			if (event.includes('error') || event.includes('fail') || event.includes('rejected')) {
				console.error(`[relay] ✗ ${event}`, fields);
			} else {
				console.log(`[relay] · ${event}`);
			}
		},
	});

	const readinessCheck = createStandaloneReadinessCheck({
		isRelayAuthenticated: () => relayHandle.isConnected(),
		resolveManifest: () => publisherManifest,
	});

	const readinessApp = express();
	readinessApp.get('/health', (_req, res) => {
		res.status(200).json({ ok: true, status: 'alive' });
	});
	readinessApp.get('/ready', async (_req, res) => {
		const result = await readinessCheck();
		res.status(result.status).json(result.body);
	});
	readinessApp.get('/.well-known/mcp/manifest.json', (_req, res) => {
		res.json(publisherManifest);
	});

	const PORT = Number(process.env.PORT || publisherManifest.port || 3001);
	const server = readinessApp.listen(PORT, () => {
		console.log(`Standalone-production MCP app connected over Relay to ${loaded.relay.privosUrl}`);
		console.log(`  Health: http://localhost:${PORT}/health`);
		console.log(`  Ready:  http://localhost:${PORT}/ready`);
	});

	function shutdown(signal: string): void {
		console.log(`Received ${signal}; shutting down`);
		void relayHandle.stop().finally(() => {
			server.close((error) => {
				if (error) {
					console.error('Failed to close MCP app server', error);
					process.exitCode = 1;
				}
			});
		});
	}

	process.once('SIGTERM', () => shutdown('SIGTERM'));
	process.once('SIGINT', () => shutdown('SIGINT'));
}

let runtimeMode: RuntimeModeResolution | undefined;
try {
	runtimeMode = resolveRuntimeMode();
} catch (error) {
	if (error instanceof RuntimeModeError && error.code === 'AMBIGUOUS_RUNTIME_IDENTITY') {
		// Both a workload socket and a paired identity file present — never guess.
		console.error(error.message);
		process.exit(1);
	}
	// PRODUCTION_WITHOUT_IDENTITY: neither pairing-based mode applies. The
	// Direct HTTP path below (managed-v2 / runtime-v3 / dev) has its own,
	// independent production gate in `runtimeBoundaryOptions`.
}

if (runtimeMode?.mode === 'standalone-production') {
	startStandaloneProductionRelay();
} else {
	startDirectHttp();
}
