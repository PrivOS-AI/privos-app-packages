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
 * The backend MUST verify the JWT before trusting any user identity. Without
 * verification a malicious iframe could forge any userId. The `verifyPrivosUser`
 * helper below does the correct asymmetric verification using the hub's public
 * JWKS — no shared secret needed, works in any Node / edge environment.
 *
 * Token properties:
 *   - Signed RS256 with the hub's private key; verify-only via public JWKS.
 *   - `sub`     = userId (opaque string, stable per user)
 *   - `preferred_username` = human-readable username
 *   - `aud`     = this app's appId (token is unusable for other apps)
 *   - `rid`     = roomId (optional, present when the iframe is in a room tab)
 *   - `exp`     = ~5 minutes from issue time; short to limit replay window
 *
 * DO NOT accept a userId from the request body / query string as a substitute
 * for the verified `sub` claim — that value is client-controlled and forgeable.
 */
import express from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// User identity — JWT verification via hub JWKS
// ---------------------------------------------------------------------------

const PRIVOS_HUB_URL = process.env.PRIVOS_HUB_URL || 'https://your-hub.example.com';
const APP_ID = '{{APP_ID}}'; // set by scaffolder; used to validate `aud` claim

/**
 * Hub public key set — fetched once and cached per jose's built-in TTL.
 * Uses `/.well-known/mcp-apps/jwks.json` so key rotation is automatic.
 */
const hubJwks = createRemoteJWKSet(
  new URL(`${PRIVOS_HUB_URL}/.well-known/mcp-apps/jwks.json`),
);

/** Verified user identity extracted from the hub-signed JWT. */
export interface PrivosUser {
  /** Stable opaque user identifier (JWT `sub` claim). Use this as your user key. */
  userId: string;
  /** Human-readable username (`preferred_username` claim). Display only — not a unique key. */
  username: string;
  /** Room the app is currently open in (`rid` claim), if present. */
  roomId?: string;
}

/**
 * Verify a Privos user-identity JWT forwarded from the iframe.
 *
 * Throws if the token is missing, expired, tampered with, or issued for a
 * different app (`aud` mismatch). The asymmetric RS256 check means the hub's
 * private key never leaves the hub — this function only uses the public JWKS.
 *
 * Usage in a route handler:
 *
 *   const user = await verifyPrivosUser(req.headers.authorization);
 *   // user.userId is now cryptographically verified
 *
 * Usage as Express middleware (see `requirePrivosUser` below):
 *
 *   app.get('/api/data', requirePrivosUser, (req, res) => {
 *     res.json({ forUser: req.privosUser!.userId });
 *   });
 */
export async function verifyPrivosUser(authHeader: string | undefined): Promise<PrivosUser> {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing Authorization: Bearer header');
  }
  const token = authHeader.slice(7);

  // jwtVerify validates: signature (RS256 via JWKS), `exp`, and `aud`.
  // `aud` enforcement binds the token to this specific app — tokens minted for
  // other apps are rejected, preventing cross-app replay.
  const { payload } = await jwtVerify(token, hubJwks, {
    audience: APP_ID,
    algorithms: ['RS256'],
    // Small tolerance absorbs clock drift between hub and app host so valid
    // tokens near their edges don't spuriously fail.
    clockTolerance: '30s',
    // Optional defense-in-depth: pin the issuer when you know your hub's URL
    // (set PRIVOS_HUB_ISSUER to the hub ROOT_URL). Rejects tokens from other hubs
    // that might share a JWKS host.
    ...(process.env.PRIVOS_HUB_ISSUER ? { issuer: process.env.PRIVOS_HUB_ISSUER } : {}),
  });

  if (!payload.sub) throw new Error('JWT missing sub claim');

  return {
    userId: payload.sub,
    username: (payload as any).preferred_username ?? '',
    roomId: (payload as any).rid,
  };
}

/**
 * Express middleware that runs `verifyPrivosUser` and attaches the result to
 * `req.privosUser`. Returns 401 if verification fails.
 *
 * Apply to any route that must know who the real user is:
 *   app.get('/api/protected', requirePrivosUser, handler);
 */
export async function requirePrivosUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    (req as any).privosUser = await verifyPrivosUser(req.headers.authorization);
    next();
  } catch (err: any) {
    res.status(401).json({ error: 'Unauthorized', detail: err.message });
  }
}

// Augment Express Request so TypeScript knows about privosUser on req
declare global {
  namespace Express {
    interface Request {
      privosUser?: PrivosUser;
    }
  }
}

// ---------------------------------------------------------------------------
// MCP manifest
// ---------------------------------------------------------------------------

app.get('/.well-known/mcp/manifest.json', (_req, res) => {
  res.json({
    name: '{{APP_ID}}',
    version: '1.0.0',
    title: '{{APP_NAME}}',
    description: 'A Privos MCP app',
    author: 'Developer',
  });
});

// ---------------------------------------------------------------------------
// MCP JSON-RPC endpoint
// ---------------------------------------------------------------------------

app.post('/mcp', (req, res) => {
  const { method, id, params } = req.body;

  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: {
          tools: {},
          extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
        },
        serverInfo: { name: '{{APP_NAME}}', version: '1.0.0' },
      },
    });
  }

  if (method === 'notifications/initialized') {
    return res.status(202).end();
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        tools: [{
          name: '{{APP_NAME}}_dashboard',
          title: '{{APP_NAME}} Dashboard',
          description: 'Main dashboard view',
          inputSchema: { type: 'object', properties: { roomId: { type: 'string' } } },
          _meta: { ui: { resourceUri: 'ui://{{APP_NAME}}/dashboard.html' } },
        }],
      },
    });
  }

  if (method === 'resources/read') {
    const html = `<!DOCTYPE html>
<html><head><title>{{APP_NAME}}</title><style>html,body{margin:0}</style></head>
<body><div id="root"></div>
<script type="module" src="http://localhost:5173/src/ui/main.tsx"></script>
</body></html>`;
    return res.json({
      jsonrpc: '2.0', id,
      result: { contents: [{ uri: params?.uri, mimeType: 'text/html;profile=mcp-app', text: html }] },
    });
  }

  res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});

// ---------------------------------------------------------------------------
// Example protected route — demonstrates the identity pattern
// ---------------------------------------------------------------------------

/**
 * Example: a route that returns data scoped to the verified user.
 * The iframe calls this with `Authorization: Bearer <userToken>`.
 * Without `requirePrivosUser`, any client could forge the userId.
 */
app.get('/api/me', requirePrivosUser, (req, res) => {
  res.json({ user: req.privosUser });
});

// ---------------------------------------------------------------------------
// Server start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`MCP server running on http://localhost:${PORT}`));
