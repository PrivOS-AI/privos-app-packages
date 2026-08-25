/**
 * `serveApp` — the single entrypoint that hides transport + trust bootstrap
 * across all three runtime modes. A developer writes ONE app, declares its
 * descriptor/ui/handler, and calls `serveApp(...)`; the SDK resolves the mode
 * (`resolveRuntimeMode`) and wires the right transport, the workload/agent-bot
 * hub client, and the readiness/health surface internally. App code never
 * imports `connectRelay`, `loadStandaloneIdentity`, the identity controller,
 * readiness checks, or the workload broker directly.
 *
 * What stays VISIBLE by design (hide plumbing, not trust): serveApp NEVER
 * creates or rotates an identity file and NEVER invokes pairing on a missing
 * one — it surfaces `StandaloneIdentityError` / `RuntimeModeError` verbatim.
 * The pairing fingerprint/TOFU ceremony lives in `pairOverWebSocket` and the
 * app's own pair scripts, and stays there.
 *
 * Mode matrix:
 *  - managed: the `getWorkloadIdentityClient()` SINGLETON + agent-bot hub from
 *    the workload broker + a Direct HTTP `createDirectRouter` with
 *    `workloadSecurity: 'required'` HARD-CODED (never 'auto': 'auto' accepts
 *    unsigned traffic whenever the socket is absent, including a managed
 *    container whose socket vanishes mid-life).
 *  - development: no workload client; the Direct HTTP router accepts unsigned
 *    traffic, so it binds loopback (127.0.0.1) by default — exposing it on
 *    0.0.0.0 requires an explicit `host`. `transportOverride: 'relay'` steps
 *    aside for an app-owned dev relay loop (the interactive pairing prompt is
 *    app-local by design), serving only health/ready/ui/configure over HTTP.
 *  - standalone-production: `loadStandaloneIdentity` (fatal if missing/invalid)
 *    + the standalone identity controller + agent-bot hub from the paired Hub
 *    origin + `connectRelay` (MCP rides the Relay WebSocket, not HTTP) + the
 *    SDK readiness check. Any persisted agent-bot credential is adopted at boot.
 *
 * `/health` and `/ready` exist in ALL modes (marketplace Docker HEALTHCHECK and
 * the cluster monitor probe them). Ambiguous identity or production-without-
 * identity fails closed via `RuntimeModeError`, unchanged.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';

import express, { type Express } from 'express';

import type { AppDescriptor } from './app-descriptor.js';
import { createDirectRouter } from './direct/express-router.js';
import { resolveHttpIngressListen, type ReadinessCheckResult } from './direct/http-ingress.js';
import { setAdoptedAgentBotCredential } from './relay/agent-bot-credential.js';
import {
	createAgentBotHubClient,
	createAgentBotHubClientFromHubOrigin,
	createAgentBotHubClientFromWorkloadIdentity,
	type RoomBoundHubClient,
} from './relay/hub-rest-as-bot-client.js';
import { connectRelay, type RelayHandle } from './relay/relay-client.js';
import {
	createStandaloneRelayIdentityController,
	type StandaloneRelayIdentityController,
} from './relay/standalone-control.js';
import {
	loadStandaloneIdentity,
	type LoadedStandaloneIdentity,
} from './relay/standalone-identity.js';
import { createStandaloneReadinessCheck } from './relay/standalone-readiness.js';
import { resolveRuntimeMode, RuntimeModeError, type RuntimeMode } from './runtime-mode.js';
import type { AppMcpHandler, UiResourceProvider } from './runtime.js';
import {
	getWorkloadIdentityClient,
	type WorkloadIdentityClient,
} from './workload/workload-identity.js';

/** Fallback listen port when no explicit `port`, `HTTP_PORT`, or `PORT` is set. */
export const DEFAULT_SERVE_APP_PORT = 8080;

/** Dev-only transport selector — the API form of the demo's `PRIVOS_TRANSPORT`. */
export type ServeAppTransportOverride = 'http' | 'relay';

/**
 * Everything an app's handler factory needs, resolved for the active mode. The
 * app builds its `McpHandler` from this and never touches transport internals.
 */
export interface ServeAppHandlerContext {
	mode: RuntimeMode;
	/**
	 * Hub REST transport authenticating as this app's own installation bot,
	 * wired to the correct Hub-origin source for the mode. Same
	 * `RoomBoundHubClient` shape in every mode.
	 */
	agentBotHub: RoomBoundHubClient;
	/**
	 * The managed workload identity SINGLETON — present only in `managed` mode.
	 * Managed-ingress room authority is WeakMap-keyed by this exact instance, so
	 * the handler MUST use this one (never construct a fresh `WorkloadIdentityClient`).
	 */
	workloadIdentityClient?: WorkloadIdentityClient;
	/** Resolve the Hub's own origin (managed: broker; standalone: paired file; dev: `PRIVOS_URL`). */
	resolveHubOrigin(): Promise<string | undefined>;
}

export interface ServeAppOptions {
	descriptor: AppDescriptor | (() => AppDescriptor | Promise<AppDescriptor>);
	ui?: UiResourceProvider;
	/** Build the app's MCP handler from the resolved runtime context. */
	createHandler: (context: ServeAppHandlerContext) => AppMcpHandler | Promise<AppMcpHandler>;
	/** Explicit listen port. Precedence: explicit > `HTTP_PORT` > `PORT` > {@link DEFAULT_SERVE_APP_PORT}. */
	port?: number;
	/** Explicit bind host. Default `0.0.0.0`, except `development` which defaults to loopback `127.0.0.1`. */
	host?: string;
	/** DEVELOPMENT-ONLY. Any value under managed or standalone-production is a boot error. */
	transportOverride?: ServeAppTransportOverride;
	/** Standalone `/ready` manifest input. Default: parse `${cwd}/privos-app.json` fresh each check. */
	resolveManifest?: () => unknown | Promise<unknown>;
	/**
	 * Express escape hatch — mount app-owned routes (/public, /ui, diagnostics)
	 * BEFORE the MCP router, so the router's CORS middleware (ACAO:* + OPTIONS
	 * short-circuit) never stamps or swallows them.
	 */
	configure?: (app: Express) => void | Promise<void>;
	/** Own SIGTERM/SIGINT (stop relay + close server). Default true. */
	installSignalHandlers?: boolean;
	logger?: (event: string, fields: Record<string, unknown>) => void;
	/** Test-only seams; never set in production. */
	__test?: ServeAppTestSeams;
}

/** Internal seams so unit tests can inject mode, workload posture, and relay without real sockets. */
export interface ServeAppTestSeams {
	env?: NodeJS.ProcessEnv;
	resolveRuntimeMode?: typeof resolveRuntimeMode;
	getWorkloadIdentityClient?: typeof getWorkloadIdentityClient;
	loadStandaloneIdentity?: typeof loadStandaloneIdentity;
	createStandaloneRelayIdentityController?: typeof createStandaloneRelayIdentityController;
	connectRelay?: typeof connectRelay;
}

export interface ServeAppHandle {
	mode: RuntimeMode;
	server: Server;
	/** Present only in standalone-production (MCP rides Relay). */
	relayHandle?: RelayHandle;
	/** The active `/ready` check for the resolved mode. */
	readiness(): Promise<ReadinessCheckResult>;
	close(): Promise<void>;
}

function defaultLogger(event: string, fields: Record<string, unknown>): void {
	if (event.includes('error') || event.includes('fail') || event.includes('rejected')) {
		console.error(`[serveApp] ✗ ${event}`, fields);
	} else {
		console.log(`[serveApp] · ${event}`);
	}
}

/** Dev-only Hub origin: the legacy relay `PRIVOS_URL`, the only Hub address available outside a paired/managed runtime. */
function developmentHubOrigin(env: NodeJS.ProcessEnv): string | undefined {
	const url = env.PRIVOS_URL;
	return url && /^https?:\/\//.test(url) ? url.replace(/\/+$/, '') : undefined;
}

function defaultManifestResolver(): unknown {
	return JSON.parse(readFileSync(path.resolve(process.cwd(), 'privos-app.json'), 'utf8'));
}

export async function serveApp(options: ServeAppOptions): Promise<ServeAppHandle> {
	const env = options.__test?.env ?? process.env;
	const logger = options.logger ?? defaultLogger;
	const resolveMode = options.__test?.resolveRuntimeMode ?? resolveRuntimeMode;

	// Fail closed on ambiguous / production-without-identity, exactly as before.
	const resolution = resolveMode({ env });
	const mode = resolution.mode;
	logger('serveApp.mode_resolved', { mode, reason: resolution.reason });

	if (options.transportOverride !== undefined && mode !== 'development') {
		// H1: transportOverride is the API form of PRIVOS_TRANSPORT and is a
		// development affordance only. Accepting it under a production mode would
		// let it override the mode's fixed, trusted transport — a boot error.
		throw new RuntimeModeError(
			'TRANSPORT_OVERRIDE_NOT_ALLOWED',
			`transportOverride is development-only; runtime mode is '${mode}'. Remove transportOverride, ` +
				'or run without the managed workload socket / standalone identity file for local development.',
		);
	}

	// Per-mode wiring, all resolved BEFORE the handler is built so the handler
	// context is complete when createHandler runs.
	let workloadIdentityClient: WorkloadIdentityClient | undefined;
	let agentBotHub: RoomBoundHubClient;
	let resolveHubOrigin: () => Promise<string | undefined>;
	let loaded: LoadedStandaloneIdentity | undefined;
	let identityController: StandaloneRelayIdentityController | undefined;
	let mountDirectRouter = false;

	if (mode === 'managed') {
		const getClient = options.__test?.getWorkloadIdentityClient ?? getWorkloadIdentityClient;
		workloadIdentityClient = getClient();
		resolveHubOrigin = async () => {
			try {
				return (await workloadIdentityClient!.brokerContext()).hubOrigin;
			} catch {
				return undefined;
			}
		};
		agentBotHub = createAgentBotHubClientFromWorkloadIdentity(workloadIdentityClient);
		mountDirectRouter = true;
	} else if (mode === 'standalone-production') {
		const load = options.__test?.loadStandaloneIdentity ?? loadStandaloneIdentity;
		loaded = load();
		// Boot-seed a persisted agent-bot credential so a delivered credential
		// survives restart and is usable before any live control-channel push.
		if (loaded.identity.agentBotCredential) setAdoptedAgentBotCredential(loaded.identity.agentBotCredential);
		const makeController =
			options.__test?.createStandaloneRelayIdentityController ?? createStandaloneRelayIdentityController;
		identityController = makeController(loaded, {
			logger: (event, fields) => logger(event, fields),
		});
		resolveHubOrigin = async () => loaded!.relay.privosUrl;
		agentBotHub = createAgentBotHubClientFromHubOrigin(loaded.relay.privosUrl);
		mountDirectRouter = false; // MCP rides Relay, not HTTP.
	} else {
		resolveHubOrigin = async () => developmentHubOrigin(env);
		agentBotHub = createAgentBotHubClient({ resolveHubOrigin });
		// Default dev transport is Direct HTTP; 'relay' steps aside for an
		// app-owned dev relay loop and serves only the HTTP support surface.
		mountDirectRouter = options.transportOverride !== 'relay';
	}

	const handler = await options.createHandler({
		mode,
		agentBotHub,
		workloadIdentityClient,
		resolveHubOrigin,
	});

	// A ref-cell for the relay handle so the readiness closure can observe a
	// connection that is opened AFTER the HTTP server begins listening (M5).
	const relayRef: { current?: RelayHandle } = {};
	const readiness = buildReadiness({
		mode,
		workloadIdentityClient,
		relayRef,
		resolveManifest: options.resolveManifest ?? defaultManifestResolver,
	});

	// Mount order: health/ready → configure → router. The router's CORS
	// middleware stamps ACAO:* and short-circuits OPTIONS on everything mounted
	// after it, so app-owned configure routes MUST come first.
	const app = express();
	app.get('/health', (_req, res) => {
		res.status(200).json({ ok: true, status: 'alive', mode });
	});
	app.get('/ready', async (_req, res, next) => {
		try {
			const result = await readiness();
			const status = result.ok ? 200 : (result.status ?? 503);
			res.status(status).json({ ok: result.ok, status: result.ok ? 'ready' : 'not_ready', ...(result.body ?? {}) });
		} catch (error) {
			next(error);
		}
	});
	if (options.configure) await options.configure(app);
	if (mountDirectRouter) {
		app.use(
			createDirectRouter({
				descriptor: options.descriptor,
				handler,
				ui: options.ui,
				// H2: managed hard-codes 'required' (never accept unsigned traffic).
				// Development leaves the default 'auto', which with no workload
				// socket accepts unsigned — safe only because dev binds loopback.
				...(mode === 'managed' ? { workloadSecurity: 'required' as const, workloadIdentityClient } : {}),
			}),
		);
	}

	const listen = resolveHttpIngressListen({ env, defaultPort: DEFAULT_SERVE_APP_PORT });
	// serveApp ALWAYS serves the HTTP support surface (/health + /ready in every
	// mode), so HTTP_INGRESS=off is not honored here: never fall through to
	// resolveHttpIngressListen's disabled port 0 (which would bind a random port).
	const port = options.port ?? (listen.enabled ? listen.port : DEFAULT_SERVE_APP_PORT);
	// H2: unsigned dev traffic must not leak off-host; loopback unless opted out.
	const host = options.host ?? (mode === 'development' ? '127.0.0.1' : '0.0.0.0');

	// Listen BEFORE any async identity bootstrap (M5): the cluster's
	// waitForHealthy is a 30s window and must see the port up promptly.
	const server = await new Promise<Server>((resolve, reject) => {
		const created = app.listen(port, host, () => {
			logger('serveApp.listening', { mode, host, port, mountDirectRouter });
			resolve(created);
		});
		created.on('error', reject);
	});

	// Standalone connects the Relay AFTER the HTTP surface is live. connectRelay
	// is non-blocking (returns a handle, connects in the background).
	if (mode === 'standalone-production') {
		const doConnect = options.__test?.connectRelay ?? connectRelay;
		// Standalone echoes the exact published manifest on every `initialize`
		// (`serverInfo.manifest`) so the Hub's admin Refresh can detect a changed
		// permission contract and offer re-approval. Resolved fresh per call, like
		// /ready, so an edited privos-app.json is observed without a restart. A
		// manifest that fails to resolve is simply omitted — never a dispatch error.
		const resolveManifest = options.resolveManifest ?? defaultManifestResolver;
		const descriptorWithManifest = async (): Promise<AppDescriptor> => {
			const base = typeof options.descriptor === 'function' ? await options.descriptor() : options.descriptor;
			try {
				const manifest = await resolveManifest();
				if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
					return { ...base, manifest: manifest as Record<string, unknown> };
				}
			} catch {
				/* keep base descriptor */
			}
			return base;
		};
		// The app's own descriptor is usually a plain object; its `id` is the
		// manifest name the Hub uses as user-token `aud`. Hand it over explicitly
		// because `descriptorWithManifest` below is lazy and connectRelay must
		// pin audiences synchronously.
		const manifestAppId = typeof options.descriptor === 'function' ? undefined : options.descriptor.id;
		relayRef.current = doConnect({
			privosUrl: loaded!.relay.privosUrl,
			standaloneIdentity: identityController,
			...(manifestAppId ? { manifestAppId } : {}),
			descriptor: descriptorWithManifest,
			handler,
			ui: options.ui,
			logger: (event, fields) => logger(event, fields),
		});
	}

	// Managed: warm the workload attestation in the background (the post-listen
	// bootstrap the SDK's startHttpIngress does) and keep it fresh, so /ready
	// reads a converged LAST-KNOWN-GOOD cache instead of forcing a synchronous
	// broker token mint on every probe. dispose() stops the monitor.
	if (mode === 'managed' && workloadIdentityClient) {
		void workloadIdentityClient.getEffectiveCapabilities({ forceRefresh: true }).catch(() => undefined);
		workloadIdentityClient.startCapabilityMonitor(30_000);
	}

	let signalHandlers: { signal: NodeJS.Signals; handler: () => void }[] = [];
	const handle: ServeAppHandle = {
		mode,
		server,
		relayHandle: relayRef.current,
		readiness,
		async close() {
			for (const { signal, handler: fn } of signalHandlers) process.removeListener(signal, fn);
			signalHandlers = [];
			if (relayRef.current) await relayRef.current.stop();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			workloadIdentityClient?.dispose();
		},
	};

	if (options.installSignalHandlers ?? true) {
		for (const signal of ['SIGTERM', 'SIGINT'] as const) {
			const fn = () => {
				logger('serveApp.shutdown', { signal });
				handle.close().catch((error) => {
					logger('serveApp.shutdown_failed', { error: String(error) });
					process.exitCode = 1;
				});
			};
			process.once(signal, fn);
			signalHandlers.push({ signal, handler: fn });
		}
	}

	return handle;
}

function buildReadiness(input: {
	mode: RuntimeMode;
	workloadIdentityClient?: WorkloadIdentityClient;
	relayRef: { current?: RelayHandle };
	resolveManifest: () => unknown | Promise<unknown>;
}): () => Promise<ReadinessCheckResult> {
	if (input.mode === 'managed') {
		const client = input.workloadIdentityClient!;
		// Read the LAST-KNOWN-GOOD attestation (no broker round-trip). The Docker
		// HEALTHCHECK probes /ready every 30s with a 3s timeout, so it must not
		// force a synchronous token mint that a transient broker latency spike
		// could push past the timeout and flap the container. Freshness comes from
		// the background capability monitor `serveApp` starts after listen.
		return async () => {
			const caps = client.peekEffectiveCapabilities();
			const ok = caps.status === 'paired' || caps.status === 'active';
			return {
				ok,
				status: ok ? 200 : 503,
				body: {
					mode: 'managed',
					workload: caps.status,
					scopes: caps.scopes.length,
					...(caps.reason ? { reason: caps.reason } : {}),
				},
			};
		};
	}
	if (input.mode === 'standalone-production') {
		const check = createStandaloneReadinessCheck({
			isRelayAuthenticated: () => input.relayRef.current?.isConnected() ?? false,
			resolveManifest: input.resolveManifest,
		});
		return async () => {
			const result = await check();
			return { ok: result.ok, status: result.status, body: result.body };
		};
	}
	// development: trivial 200 — no trust to attest, unsigned local surface.
	return async () => ({ ok: true, status: 200, body: { mode: 'development' } });
}
