# @privos_ai/app-server

Business-agnostic PrivOS MCP App server runtime for **Direct HTTP** and **Relay WebSocket**.

> **0.8.3.** Relay user-token verification accepts the publisher manifest
> `name` (the Hub's `app.appId`, which the Hub uses as the token `aud`) as an
> audience alongside dispatch trust's `mcpAppId` (the Hub record `_id`). Before
> this, every Hub-minted user token failed audience verification on
> standalone-production apps and `context.actor` stayed `undefined` (fail-closed).
> `serveApp` wires this automatically; a direct `connectRelay` caller with a
> lazy `descriptor` passes `manifestAppId` explicitly.

> **0.8.0 breaking change.** `PairingResult` is now a discriminated union
> (`legacy-complete` / `pending-approval` / `complete`) with a required `state`
> field, and `resumeStandalonePairing()` is added for durable app-announced
> manifest pairing. Callers that read `pairing.trust`/`pairing.pairingVersion`
> directly must branch on `pairing.state` first. Apps that only use `serveApp`
> are unaffected. See [Standalone production mode](#standalone-production-mode-relay-pairing).

## Install

```bash
npm install @privos_ai/app-server
# peer: express
```

## Quick start (Direct router only)

```ts
import express from 'express';
import { createDirectRouter } from '@privos_ai/app-server';

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(
  createDirectRouter({
    descriptor: { id: 'com.example.app', name: 'Example', version: '1.0.0' },
    handler: async (request) => {
      if (request.method === 'tools/list') return { tools: [] };
      throw Object.assign(new Error('Method not found'), { code: -32601 });
    },
  }),
);
```

## Quick start (HTTP ingress helper)

For Relay+HTTP dual mode or a minimal Direct binary — health/ready/listen included:

```ts
import {
  startHttpIngress,
  resolveHttpIngressListen,
  connectRelay,
} from '@privos_ai/app-server';

const listen = resolveHttpIngressListen({ defaultPort: 8080 });
const shared = {
  descriptor: { id: 'com.example.app', name: 'Example', version: '1.0.0' },
  handler: async (request) => {
    if (request.method === 'tools/list') return { tools: [] };
    throw Object.assign(new Error('Method not found'), { code: -32601 });
  },
};

if (listen.enabled) {
  await startHttpIngress({
    ...shared,
    port: listen.port,
    publicUrl: listen.publicUrl,
    ready: {
      check: async () => ({ ok: true, body: { /* app checks */ } }),
    },
    // Optional: mount /ui, static assets, webhooks before listen
    configure: async (app) => {
      // app.use('/ui', …)
    },
  });
}

connectRelay({ ...shared, privosUrl, clientId, clientSecret });
```

Env: `HTTP_INGRESS`, `HTTP_PORT` / `PORT`, `PUBLIC_URL`.

Runtime owns `initialize`, `notifications/*`, and the configured primary UI resource.  
Your handler owns `tools/list`, `tools/call`, and custom resources.

## Auth

```ts
import { verifyPrivosUser } from '@privos_ai/app-server/auth';
```

## Secretless workload identity

Production Cluster installs mount a per-installation Unix socket. The runtime creates an
ephemeral P-256 DPoP key in memory, attests through that socket, and refreshes a short-lived,
sender-constrained token without writing credentials to disk or environment variables.

```ts
import { getWorkloadIdentityClient } from '@privos_ai/app-server/workload';

const identity = getWorkloadIdentityClient();
const capabilities = await identity.getEffectiveCapabilities();
const stop = identity.onCapabilitiesChanged((next) => {
  // Disable optional features when next.scopes no longer contains their scope.
});

identity.requireCapability('basic:information');
const response = await identity.authorizedRequest('/api/v1/mcp-apps.context', {
  requiredScope: 'basic:information',
});
```

`authorizedFetch` only sends authorization to the Hub origin supplied by the broker. It retries
one 401 automatically only for safe/idempotent methods; POST/PATCH require an explicit
`retryMode: 'idempotent'`. `authorizedRequest` maps 403 to `WorkloadPermissionDeniedError` so
optional-feature degradation is stable. Do not convert a workload token into a user identity;
user-delegated operations stay in the iframe host bridge.

Managed Cluster ingress uses the legacy workload boundary and should set
`workloadSecurity: 'required'`. Protocol-v3 `SELF_HOSTED_LOCAL` and
`PUBLISHER_HOSTED` runtimes must instead configure `runtimeDispatchV3`; the two
security modes are deliberately mutually exclusive.

## Protocol-v3 runtime dispatch

The v3 receiver verifies the final Hub-to-app boundary independently of the
managed workload broker. Direct HTTP accepts the assertion only in
`X-PrivOS-MCP-Dispatch-Assertion`. Relay accepts it only at
`params._meta.privosAuthorization`, reconstructs the exact signed logical RPC,
removes `privosAuthorization` and `privosUser`, and passes only the sanitized RPC
to the application handler.

Direct HTTP has no separate runtime-installation or room-binding wrapper
headers; both IDs are protected payload fields. Relay additionally carries
`runtimeInstallationId` and, for room work, `authorizationBindingId` inside the
reserved authorization wrapper, and the receiver cross-checks them before
consuming replay state.

```ts
import {
  BoundedRuntimeDispatchReplayConsumerV3,
  createDirectRouter,
  type RuntimeDispatchSecurityV3,
  type RuntimeDispatchTrustHintV3,
  type RuntimeDispatchTrustV3,
} from '@privos_ai/app-server';

// Load this from an authenticated provisioning/configuration channel. The
// assertion itself and its unverified resolver hint are never trust sources.
async function resolvePinnedTrust(
  hint: RuntimeDispatchTrustHintV3,
): Promise<RuntimeDispatchTrustV3> {
  return trustStore.loadExactActiveGeneration(hint);
}

const runtimeDispatchV3: RuntimeDispatchSecurityV3 = {
  mode: 'required',
  trust: resolvePinnedTrust,
  replayConsumer: new BoundedRuntimeDispatchReplayConsumerV3(),
};

app.use(createDirectRouter({
  descriptor,
  handler,
  runtimeDispatchV3,
}));
```

The pinned trust record must contain the Hub P-256 public JWK and its RFC 7638
thumbprint `kid`, plus the exact workspace, deployment, app, execution mode,
generation, runtime installation, manifest digest, and resource-manifest hash.
Those stable fields exist before a local runtime starts. The signed assertion
always contains the runtime inventory hash, approval receipt hash, and current
authorization epoch; a dynamic publisher resolver may additionally supply any
of those three as exact expectations once its trusted control-plane state has
them. They are optional in static local startup trust because the runtime
inventory is finalized only after readiness evidence exists.

Use `parseRuntimeDispatchTrustV3Json` for strict JSON configuration parsing. It
rejects unknown keys, private or non-P-256 JWK material, a mismatched key
thumbprint, malformed affinity, and invalid optional expectations. A resolver
hint is attacker-controlled until signature verification completes; use it only
to locate a pre-provisioned record, then return that record for exact comparison.

`BoundedRuntimeDispatchReplayConsumerV3` is process-local and suitable only for
a single runtime process. A multi-process or multi-replica publisher must inject
a shared implementation whose `consume` operation atomically reserves both the
JTI and nonce until expiration. A full store fails closed; replay protection is
never silently disabled.

Local supervision or publisher connector provisioning must deliver the pinned
trust record out of band before executable traffic is admitted. The receiver
does not discover keys or affinity from a request and does not fall back to
legacy/unsigned authorization when v3 is configured. Treat a deployment as
blocked if its provisioning path does not supply this record (and, for multiple
replicas, a shared atomic replay consumer).

Publisher-hosted deployments can mount the production provisioning receiver:

```ts
const store = new SingleProcessFilePublisherRuntimeTrustStoreV3({
  filePath: '/var/lib/my-app/privos-runtime-trust.json',
  deploymentMode: 'single-process',
});
const portalJwksResolver = createPinnedPortalJwksResolverV3({
  issuer: 'portal:marketplace-broker',
  jwksUrl: 'https://portal.privos.io/approval-jwks',
});

// Mount before any global JSON parser so canonical raw bytes and duplicate
// keys can be checked before proof verification.
app.use(createPublisherRuntimeTrustProvisioningRouterV3({
  provisioningUrl: manifest.runtimeTrustProvisioningUrl,
  mcpAppId: manifest.name,
  portalJwksResolver,
  store,
}));

const runtimeDispatchV3: RuntimeDispatchSecurityV3 = {
  mode: 'required',
  trust: (hint) => store.resolveDispatchTrust(hint),
  replayConsumer: store,
};
```

The receiver independently verifies canonical Portal Ed25519 approval,
execution-grant, and deployment-descriptor bytes, the exact artifact chain,
the approval-pinned Hub P-256 key, a current single-use Hub possession proof,
and the canonical request body before an atomic state transition. `PREPARE`
exposes stable trust only to the three exact signed readiness RPCs. `ACTIVATE`
pins the final inventory hash, approval hash, and authorization epoch; only then
does the normal dynamic resolver authorize application traffic. An exact
already-PREPARED generation may complete `ACTIVATE` after the Portal envelopes
expire, but a fresh expired `PREPARE` is denied.

`SingleProcessFilePublisherRuntimeTrustStoreV3` uses atomic file replacement and
durable replay state but intentionally supports exactly one Node process. It is
not safe for PM2 cluster mode, Kubernetes replicas, or multiple containers.
Those deployments must provide a transactional shared implementation of
`PublisherRuntimeTrustDurableStoreV3`; do not share the reference file over NFS.

The default scaffolder maps the local production surface to
`PRIVOS_RUNTIME_SECURITY_MODE=runtime-v3`, strict trust JSON in
`PRIVOS_RUNTIME_DISPATCH_TRUST_V3`, and the optional Direct-only local activation
probe switch `PRIVOS_RUNTIME_ALLOW_UNSIGNED_PREACTIVATION_READINESS=true`.
Publisher mode instead uses `PRIVOS_PUBLISHER_RUNTIME_TRUST_STORE_PATH`,
`PRIVOS_PORTAL_JWKS_URL`, `PRIVOS_PORTAL_ISSUER`, and the explicit
`PRIVOS_PUBLISHER_SINGLE_PROCESS=true` guard. Publisher readiness is always
signed and never enables the unsigned exception.

Local Direct pre-activation probing has one explicit, non-authorizing exception:
`unsignedReadiness: 'initialize-and-tools-list'`. It permits only these exact Hub
messages:

1. `initialize`, numeric ID `1`, protocol `2025-03-26`, the exact MCP UI
   capability, and client `privos-hub/1.0.0`;
2. bodyless `notifications/initialized` with no ID or params;
3. `tools/list`, numeric ID `2`, and exactly empty params.

Any extra key, metadata, different ID, or changed nested value is denied.
`tools/call`, `resources/read`, and custom methods always require a valid
assertion. Relay never permits unsigned discovery. After activation, Hub sends
signed discovery requests as well.

Verified runtime authorization is exposed as the frozen
`ToolCallContext.runtimeAuthorization`. Room assertions include both the parent
`runtimeInstallationId` and child `authorizationBindingId`. A canonical signed
`actor` claim is optional immediate attribution: when present it is strictly
parsed, frozen, and surfaced as `ToolCallContext.actor`; when absent the Room
dispatch remains valid. Actor metadata never selects or authorizes a workload.

### Relay actor identity (Hub-signed user token)

The `hub-runtime-dispatch-assertion` (Relay/Direct `SELF_HOSTED_LOCAL` /
`PUBLISHER_HOSTED`) has no `actor` claim — only the managed-Cluster assertion
variant does. Instead the Hub sends caller identity for these apps as a
separate short-lived RS256 JWT at `params._meta.privosUser.userToken`,
verifiable against the Hub's published JWKS
(`/.well-known/mcp-apps/jwks.json`). The plain `userId` / `username` /
`roomId` fields riding alongside that token are not proof of anything; only
the signed token is.

`connectRelay` verifies this token and populates `ToolCallContext.actor`
automatically (`hubUserTokenAuth: 'auto'`, the default) whenever
`standaloneIdentity` is set, or `runtimeDispatchV3.trust` is a static (non-resolver)
trust record, and the app has not already supplied its own `auth` /
`extractCallerCredential`. The verified token's `rid` is cross-bound against the
already-verified dispatch assertion's room: a room-scoped assertion requires the
token's `rid` to match exactly, and a workspace-scoped assertion refuses a
room-bound token outright — `buildContext` throws `dispatch_assertion_binding_mismatch`
on a mismatch, which `connectRelay` turns into a denied dispatch before the handler
runs. Set `hubUserTokenAuth: 'disabled'` to opt out.

```ts
connectRelay({
  privosUrl: loaded.relay.privosUrl,
  standaloneIdentity,
  descriptor,
  handler, // context.actor is populated automatically when a token verifies
});
```

For a non-standalone Relay/Direct setup with a dynamic (resolver) trust —
where this app's own `mcpAppId` is still fixed, just not known synchronously
from a static trust record — wire the same verification manually:

```ts
import {
  buildHubUserTokenAuthOptions,
  extractRelayUserTokenCredential,
} from '@privos_ai/app-server';

connectRelay({
  privosUrl,
  runtimeDispatchV3, // trust: a resolver function
  auth: buildHubUserTokenAuthOptions({ hubOrigin: privosUrl, audience: mcpAppId }),
  extractCallerCredential: extractRelayUserTokenCredential,
  descriptor,
  handler,
});
```

`ToolCallContext.actor.provenance` distinguishes how an actor was established:
`'dispatch-assertion'` for the managed-Cluster embedded `actor` claim (Direct
transport only), `'user-token'` for this separately-verified Hub JWT (Direct
bearer header or Relay `_meta.privosUser.userToken`). Apps that want a
stricter policy for one path than the other can branch on this field.
`buildHubUserTokenAuthOptions` refuses a plaintext-HTTP JWKS origin once
`NODE_ENV=production`, bounds the JWKS fetch with a timeout, and — via the
shared `jose` remote-JWKS client underneath — refetches at most once on an
unknown `kid` before failing closed. A JWKS fetch failure never crashes
dispatch; it degrades to `identityState: 'invalid'` and `actor: undefined`.

Managed App Library generations use this same canonical Direct ingress. The
router learns the generation from the verified workload broker, accepts only
`X-PrivOS-Dispatch-Assertion`, verifies it with
`verifyClusterDispatchAssertionV3`, and obtains any Actor only from that exact
signed, body-bound assertion. A separate caller bearer or asserted-user header
is not accepted on this managed-v3 path. Publisher-hosted and self-hosted-local
v3 runtimes continue to use only `X-PrivOS-MCP-Dispatch-Assertion`. Sending both
assertion headers or duplicating either header is denied before the handler
runs.
Successful managed room ingress also freezes the exact handler context and
registers a client-private, object-identity capability for it. Public context
fields are descriptive only and cannot be reconstructed into room authority.

For backend calls that must retain the verified room child-binding, derive a
request-only client from the tool context:

```ts
const roomHub = workloadIdentityClient.forRoom(context);
const response = await roomHub.authorizedRequest('/api/v1/example.read', {
  method: 'GET',
  requiredScope: 'example:read',
});
```

`forRoom` is synchronous and accepts only the exact managed-ingress context
instance registered to that `WorkloadIdentityClient`; fabricated objects,
clones, substituted fields, and contexts from another client are rejected.
Actor presence or identity is not part of this capability. Its
client accepts only Hub-relative paths and one exact scope, sends the verified
`authorizationBindingId` only to workload-token issuance, and does not expose a
raw token. Exact `roomId` and `authorizationBindingId` keys are reserved in the
parsed query, nested JSON, `URLSearchParams`, and `FormData`; malformed declared
JSON/form bodies and opaque streams are rejected before issuance. Strings,
blobs, and byte buffers with a non-semantic content type remain exact raw
payloads and are not scanned for coincidental text. Token caching and concurrent
issuance are isolated by the complete workspace, generation, and room
receipt/epoch/version identity, with one fixed 64-entry process-local LRU/token
and active-issuance bound. A 401 evicts only the exact key that supplied the
attempted token. POST/PATCH replay requires both `retryMode: 'idempotent'` and
`replayable: true`; safe methods retain one refresh retry.

## Standalone production mode (Relay pairing)

Self-hosted apps with no reachable public URL (typically behind NAT) pair once over
a one-time Relay WebSocket URL and run in production against a paired, persisted
identity — no secret ever lives in a world-readable `.env`.

```ts
import { pairOverWebSocket, resumeStandalonePairing } from '@privos_ai/app-server';

// Prints the Hub fingerprint (SSH-host-key style) and, by default, persists
// ./privos-standalone-identity.json at mode 0600 (override with
// PRIVOS_STANDALONE_IDENTITY_FILE).
const pairing = await pairOverWebSocket(pairingUrl, {
  name: publisherManifest.title,
  version: publisherManifest.version,
  manifest: publisherManifest, // the exact published schema-v3 document
});

if (pairing.state === 'pending-approval') {
  // Run once after the Hub owner approves. This works after process restart:
  // the pending OAuth/app/manifest binding is stored separately at mode 0600.
  const completed = await resumeStandalonePairing();
  if (completed.state !== 'complete') throw new Error('Still awaiting approval');
}
```

If the initial socket closes after the Hub durably registers the app but before
the result reaches this process, call `pairOverWebSocket` again explicitly with
the **same pairing URL and exact published manifest**. A compatible Hub recovers
the already-persisted app, pairing, OAuth client, client secret, manifest,
permission contract, declared ceiling, and Hub-key identity for up to 24 hours;
it never creates or rotates another credential. The SDK deliberately does not
retry or poll on its own. A changed URL, manifest, app identity, creator,
permission contract, OAuth binding, ceiling, or Hub key fails closed.

A Hub that replies with pairing payload v2 (`pairingVersion: 2`) uses a
discriminated `pending-approval` / `complete` contract. Pending state persists
the exact app id, OAuth client, pairing id, manifest digest, permission-contract
hash, declared ceiling, and Hub fingerprint in a separate owner-only file, but
contains no dispatch trust and can never satisfy production readiness. Approval
activates that same OAuth/app identity; `resumeStandalonePairing()` verifies all
affinities, the approved ceiling, and Hub trust before atomically writing the
final identity and consuming the pending file. A v1 Hub returns
`state: 'legacy-complete'` and remains non-persistent. Load the final identity
and run the app with `resolveRuntimeMode()` picking the transport:

```ts
import {
  connectRelay,
  createStandaloneReadinessCheck,
  createStandaloneRelayIdentityController,
  loadStandaloneIdentity,
  resolveRuntimeMode,
} from '@privos_ai/app-server';

const runtimeMode = resolveRuntimeMode(); // 'managed' | 'standalone-production' | 'development'

if (runtimeMode.mode === 'standalone-production') {
  const loaded = loadStandaloneIdentity();
  const standaloneIdentity = createStandaloneRelayIdentityController(loaded);
  const relay = connectRelay({ privosUrl: loaded.relay.privosUrl, standaloneIdentity, descriptor, handler });

  const ready = createStandaloneReadinessCheck({
    isRelayAuthenticated: () => relay.isConnected(),
    resolveManifest: () => publisherManifest,
  });
}
```

`resolveRuntimeMode()` resolves exactly one mode — `managed` (workload identity
socket present) takes precedence over `standalone-production` (identity file
present), which takes precedence over `development` (neither present; only
permitted when `NODE_ENV` is not `production`). Both signals present at once is a
startup error (`RuntimeModeError` code `AMBIGUOUS_RUNTIME_IDENTITY`), never a
silent pick; `NODE_ENV=production` with neither present is `PRODUCTION_WITHOUT_IDENTITY`.

Secret rotation, Hub re-key/generation trust rotation, and a capabilities push are
delivered as ES256-signed control notifications over the same authenticated Relay
connection, verified against the currently pinned Hub key before being applied and
atomically persisted (`src/relay/standalone-control.ts` documents the wire
contract). A cold app that missed a rotation correctly refuses the new key until
it is delivered live or the app is re-paired — this is expected, not a bug.
`createStandaloneReadinessCheck` matches the managed `/health` (alive) + `/ready`
(identity loaded, trust valid, Relay authenticated, manifest lint clean, and no
`MANIFEST_DRIFT` against the digest pinned at pairing) JSON shape, and
`loadStandaloneIdentity` refuses to load a tampered file (wrong mode, foreign
owner, or invalid content) with a specific reason instead of degrading silently.

## Manifest v2 preflight

```bash
npx privos-app-lint ./privos-app.json
# equivalent to:
npx privos-app lint ./privos-app.json
```

The command rejects mixed legacy/v2 permission declarations and prints deterministic
`canonicalManifestHash` and `publisherPermissionDeclarationHash` values. The latter covers the
publisher declaration only; Hub/Portal compute the authoritative permission contract hash with
the versioned server-owned catalog and immutable image digest. `privos-app-lint` is kept as a
compatibility alias for `privos-app lint` — same output, same exit code.

## CLI: `privos-app publish`

Run from inside the app folder (where `privos-app.json` and `package.json` live):

```bash
npx privos-app publish
```

This packages the git worktree into a source archive (`git archive`, with the same
dirty-tree refusal, credential-file scan, and entry-policy checks as
`scripts/package-source.sh`), authorizes with the Portal, uploads the archive, creates
the version, and submits it for review — in one command, no hand-minted session.

Two authorization modes, both ending in a scoped, short-lived Portal grant (never a
browser session):

- **Browser approval (default).** The CLI prints a URL and a user code; approve on
  `client.privos.io` and the CLI proceeds automatically once approved.
- **Publisher token (CI).** Set `PRIVOS_PUBLISHER_TOKEN` (or pass `--token-stdin`) to
  skip the browser step — only works once the listing's first version was approved
  interactively (`409 LISTING_NOT_BOUND` otherwise).

Useful flags: `--listing <slug>`, `--changelog <text>` / `--changelog-file <path>`,
`--allow-dirty`, `--dry-run` (package only, prints the git revision + archive sha256),
`--yes` (skip the confirmation prompt), `--portal <origin>`, `--machine-label <text>`,
`--open` (open the approval URL), `--json` (one NDJSON event per step), `--cwd <path>`.

Exit codes: `0` submitted, `2` blocked by policy (lint/package/semver/preflight
failed/unbound listing), `3` authorization denied/expired, `4` network/portal error,
`5` usage. The CLI's own manifest lint is structure-only — its
`canonicalManifestHash` is **not** the Portal's canonical digest and is never sent;
the Portal returns the authoritative `manifestDigest` after upload. Secrets are never
printed in full: publisher tokens are shown masked to a prefix, and the publish grant
value is never printed.

## Scripts

- `npm run build` — emit `dist/` (JS + `.d.ts`)
- `npm test` — Vitest (in-process mock Hub only)
- `npm run typecheck`
- `npm pack` — runs `prepack` build; package contains `dist/` only
- `npx tsx scripts/probe-relay-contract.ts` — staging Phase 0 probe (requires credentials; exit 2 when blocked)

## License

MIT
