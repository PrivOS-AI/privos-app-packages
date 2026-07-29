/**
 * MCP app server — serves manifest, handles MCP JSON-RPC calls, and serves UI.
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
	createDirectRouter,
	verifyPrivosUser,
	type AppDescriptor,
	type ApplicationMcpRequest,
	type AuthOptions,
	type ToolCallContext,
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
};
const APP_ID = publisherManifest.name;

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

const app = express();
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
		ui: {
			uri: 'ui://{{APP_NAME}}/dashboard.html',
			renderHtml: async () => process.env.NODE_ENV === 'production'
				? readFileSync(path.resolve(process.cwd(), 'dist/index.html'), 'utf8')
				: `<!DOCTYPE html>
<html><head><title>{{APP_NAME}}</title><style>html,body{margin:0}</style></head>
<body><div id="root"></div>
<script type="module" src="http://localhost:5173/src/ui/main.tsx"></script>
</body></html>`,
		},
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
	server.close((error) => {
		if (error) {
			console.error('Failed to close MCP app server', error);
			process.exitCode = 1;
		}
	});
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
