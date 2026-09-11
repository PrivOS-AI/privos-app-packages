# @privos_ai/skill-sdk

Skill-facing SDK for [PrivOS](https://privos.io). Auto-detects whether your code
runs inside a PrivOS sandbox or standalone, and routes network egress through the
sandbox proxy or directly accordingly — so the same skill code works in both.

## Install

```bash
npm install @privos_ai/skill-sdk
```

## Usage

```ts
import { hub, external, env } from '@privos_ai/skill-sdk';

// Call the PrivOS hub API (auth + base URL resolved automatically)
const me = await hub.get('/api/me');

// Fetch an allowlisted external URL (goes through the egress proxy in sandbox mode)
const res = await external.fetch('https://api.example.com/data');

// Read a whitelisted environment value
const region = env.get('PRIVOS_REGION');
```

## API

- `hub` — high-level client for the PrivOS hub API (`get`, `post`, SSE via `SseMessage`).
- `external` — allowlisted external fetch (`ExternalFetchOptions`).
- `env` — typed access to the environment whitelist.
- `egressFetch` — low-level egress primitive (`EgressOptions`) for advanced use.
- Errors: `EgressDeniedError`, `ProxyUnreachableError`, `UpstreamError`.
- Mode helpers: `isSandboxMode`, `proxyUrl`, `hubHost`, `privosUrl`.

Full type declarations ship in the package (`dist/index.d.ts`).

## Non-JS runtimes

Skills written in Python or Bash use the bundled helpers instead:

- Python: `import privos_skill`
- Bash: `source privos-skill.sh`

## License

MIT
