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
 * Verify identity with `@privos/app-server/auth` — do not copy a second JWKS
 * verifier into this app.
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
	createDirectRouter,
	verifyPrivosUser,
	type AppDescriptor,
	type ApplicationMcpRequest,
	type AuthOptions,
	type ToolCallContext,
	type VerifiedActor,
} from '@privos/app-server';

const PRIVOS_HUB_URL = process.env.PRIVOS_HUB_URL || 'https://your-hub.example.com';
const APP_ID = '{{APP_ID}}'; // set by scaffolder; used to validate `aud` claim

const authOptions: AuthOptions = {
	jwksUrl: `${PRIVOS_HUB_URL}/.well-known/mcp-apps/jwks.json`,
	audience: APP_ID,
	...(process.env.PRIVOS_HUB_ISSUER ? { issuer: process.env.PRIVOS_HUB_ISSUER } : {}),
};

/** @deprecated Prefer importing `verifyPrivosUser` from `@privos/app-server/auth`. */
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
	name: '{{APP_NAME}}',
	version: '1.0.0',
	title: '{{APP_NAME}}',
	description: 'A Privos MCP app',
};

async function mcpHandler(request: ApplicationMcpRequest, _ctx: ToolCallContext) {
	if (request.method === 'tools/list') {
		return {
			tools: [
				{
					name: '{{APP_NAME}}_dashboard',
					title: '{{APP_NAME}} Dashboard',
					description: 'Main dashboard view',
					inputSchema: { type: 'object', properties: { roomId: { type: 'string' } } },
					_meta: { ui: { resourceUri: 'ui://{{APP_NAME}}/dashboard.html' } },
				},
			],
		};
	}

	throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
}

const app = express();
app.use(express.json());

app.use(
	createDirectRouter({
		descriptor,
		handler: mcpHandler,
		auth: authOptions,
		ui: {
			uri: 'ui://{{APP_NAME}}/dashboard.html',
			renderHtml: async () => `<!DOCTYPE html>
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
	console.log(`MCP app listening on http://localhost:${PORT}`);
});
