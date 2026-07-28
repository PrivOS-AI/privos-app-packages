/**
 * Convenience HTTP server around `createDirectRouter` for apps that want a
 * single listen (e.g. Relay process also exposing Direct MCP, or a minimal
 * Direct-only binary) without hand-rolling Express health/ready/listen.
 *
 * Does not own `/ui`, register, or app-specific webhooks — mount those on the
 * returned `app` before `startHttpIngress`, or use `createHttpIngressApp` and
 * call `listen` yourself.
 */
import express, { type Express, type Request } from 'express';
import type { Server } from 'node:http';

import { createDirectRouter, type DirectRouterOptions } from './express-router.js';

export type ReadinessCheckResult = {
	ok: boolean;
	/** HTTP status when not ok; default 503. */
	status?: number;
	/** JSON body (merged with `{ ok, status: 'ready'|'not_ready' }` if those keys absent). */
	body?: Record<string, unknown>;
};

export interface HttpIngressAppOptions extends DirectRouterOptions {
	/**
	 * Liveness probe. Default `{ path: '/health' }`.
	 * Set `false` to omit (app mounts its own).
	 */
	health?:
		| false
		| {
				path?: string;
				/** Extra fields merged into `{ ok: true, status: 'alive' }`. */
				body?: Record<string, unknown>;
		  };
	/**
	 * Readiness probe. Omit to skip `/ready`.
	 * `check` is app-owned (DB, pool, secrets) — runtime stays business-agnostic.
	 */
	ready?: {
		path?: string;
		check: (req: Request) => ReadinessCheckResult | Promise<ReadinessCheckResult>;
	};
}

export interface HttpIngressListenOptions extends HttpIngressAppOptions {
	port: number;
	host?: string;
	/** Used in startup logs; default `http://localhost:${port}`. */
	publicUrl?: string;
	/** Prefix for default console logging when `logger` is unset. */
	logPrefix?: string;
	/**
	 * Mount app-owned routes (/ui, /public, register stubs, webhooks) after the
	 * ingress app is built and before listen. May be async (e.g. Vite middleware).
	 */
	configure?: (app: Express) => void | Promise<void>;
}

export interface HttpIngressHandle {
	app: Express;
	server: Server;
	port: number;
	publicUrl: string;
	close(): Promise<void>;
}

/**
 * Build an Express app with optional /health + /ready and `createDirectRouter`.
 * Does not listen.
 */
export function createHttpIngressApp(options: HttpIngressAppOptions): Express {
	const app = express();

	if (options.health !== false) {
		const path = options.health?.path ?? '/health';
		const extra = options.health?.body ?? {};
		app.get(path, (_req, res) => {
			res.status(200).json({ ok: true, status: 'alive', ...extra });
		});
	}

	if (options.ready) {
		const path = options.ready.path ?? '/ready';
		const check = options.ready.check;
		app.get(path, async (req, res, next) => {
			try {
				const result = await check(req);
				const status = result.ok ? 200 : (result.status ?? 503);
				const body = {
					ok: result.ok,
					status: result.ok ? 'ready' : 'not_ready',
					...(result.body ?? {}),
				};
				res.status(status).json(body);
			} catch (err) {
				next(err);
			}
		});
	}

	const {
		health: _h,
		ready: _r,
		...routerOpts
	} = options;
	app.use(createDirectRouter(routerOpts));

	return app;
}

/**
 * `createHttpIngressApp` + optional `configure` + `listen`. Returns a handle with `close()`.
 */
export async function startHttpIngress(
	options: HttpIngressListenOptions,
): Promise<HttpIngressHandle> {
	const logPrefix = options.logPrefix ?? '[HttpIngress]';
	const { configure, port, host, publicUrl, logPrefix: _lp, ...ingressAppOptions } = options;

	const logger =
		ingressAppOptions.logger ??
		((event: string, fields: Record<string, unknown>) => {
			const method = typeof fields.method === 'string' ? fields.method : undefined;
			const toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined;
			const label =
				method === 'tools/call' && toolName
					? `tools/call ${toolName}`
					: (method ?? event);
			if (event.includes('error') || event.includes('fail') || event.includes('backpressure')) {
				console.error(`${logPrefix} ✗ ${event} ${label}`, JSON.stringify(fields).slice(0, 400));
				return;
			}
			console.log(`${logPrefix} · ${event} ${label}`);
		});

	const app = createHttpIngressApp({ ...ingressAppOptions, logger });
	if (configure) await configure(app);

	return new Promise((resolve, reject) => {
		const server: Server = host
			? app.listen(port, host, onListening)
			: app.listen(port, onListening);

		function onListening() {
			const addr = server.address();
			const boundPort =
				typeof addr === 'object' && addr && typeof addr.port === 'number'
					? addr.port
					: port;
			const boundPublicUrl =
				publicUrl?.replace(/\/$/, '') ||
				`http://localhost:${boundPort}`;
			const mcpPath = options.mcpPath ?? '/mcp';
			const manifestPath = options.manifestPath ?? '/.well-known/mcp/manifest.json';
			console.log(`${logPrefix} Listening on ${boundPublicUrl} (port ${boundPort})`);
			console.log(`${logPrefix}   MCP:      ${boundPublicUrl}${mcpPath}`);
			console.log(`${logPrefix}   Manifest: ${boundPublicUrl}${manifestPath}`);
			if (options.health !== false) {
				const healthPath = options.health?.path ?? '/health';
				console.log(`${logPrefix}   Health:   ${boundPublicUrl}${healthPath}`);
			}
			resolve({
				app,
				server,
				port: boundPort,
				publicUrl: boundPublicUrl,
				close: () =>
					new Promise<void>((res, rej) => {
						server.close((err) => (err ? rej(err) : res()));
					}),
			});
		}

		server.on('error', reject);
	});
}

export type ResolveHttpIngressListenOptions = {
	/** Used when HTTP_PORT / PORT are unset. Default 8080. */
	defaultPort?: number;
	env?: NodeJS.ProcessEnv;
};

/**
 * Resolve listen config from env (shared by Relay+HTTP dual mode and Direct apps).
 * Disabled when `HTTP_INGRESS` is 0/false/off, or resolved port ≤ 0.
 *
 * Env: `HTTP_INGRESS`, `HTTP_PORT` (preferred), `PORT`, `PUBLIC_URL`.
 */
export function resolveHttpIngressListen(
	options: ResolveHttpIngressListenOptions = {},
): { enabled: boolean; port: number; publicUrl: string } {
	const env = options.env ?? process.env;
	const defaultPort = options.defaultPort ?? 8080;

	const flag = env.HTTP_INGRESS?.trim().toLowerCase();
	if (flag === '0' || flag === 'false' || flag === 'off') {
		return { enabled: false, port: 0, publicUrl: '' };
	}

	const rawPort = env.HTTP_PORT?.trim() || env.PORT?.trim() || String(defaultPort);
	const port = Number.parseInt(rawPort, 10);
	if (!Number.isFinite(port) || port <= 0) {
		return { enabled: false, port: 0, publicUrl: '' };
	}

	const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');
	return { enabled: true, port, publicUrl };
}
