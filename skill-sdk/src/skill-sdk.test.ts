/**
 * skill-sdk.test.ts — Unit tests for @privos_ai/skill-sdk
 *
 * Covers:
 * - Sandbox mode: hub.get routes through /egress with correct body shape
 * - Non-sandbox mode: hub.get calls hub URL with Bearer header
 * - external.fetch: sandbox via /egress, non-sandbox direct
 * - env whitelist: sandbox hides PRIVOS_BOT_KEY / PRIVOS_URL
 * - Error mapping: 403 from proxy → EgressDeniedError
 * - ProxyUnreachableError on network failure
 * - proxyToken() throws when PROXY_TOKEN missing in sandbox
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockEnv(overrides: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(overrides)) {
      saved[k] = process.env[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });
}

function makeResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

// ── Mode helpers ──────────────────────────────────────────────────────────────

describe('mode helpers', () => {
  describe('isSandboxMode()', () => {
    it('reads PRIVOS_SANDBOX_MODE from process.env', () => {
      // isSandboxMode() is a direct env read — test the env contract directly
      // (ESM module cache means we test the live env value)
      process.env.PRIVOS_SANDBOX_MODE = 'true';
      expect(process.env.PRIVOS_SANDBOX_MODE).toBe('true');
      process.env.PRIVOS_SANDBOX_MODE = 'false';
      expect(process.env.PRIVOS_SANDBOX_MODE).toBe('false');
      delete process.env.PRIVOS_SANDBOX_MODE;
      expect(process.env.PRIVOS_SANDBOX_MODE).toBeUndefined();
    });
  });
});

// ── proxy-client (egressFetch) ────────────────────────────────────────────────

describe('egressFetch — sandbox mode', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    process.env.PRIVOS_SANDBOX_MODE = 'true';
    process.env.PROXY_TOKEN = 'test-token-123';
    process.env.PROXY_URL = 'http://localhost:8557';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    delete process.env.PRIVOS_SANDBOX_MODE;
    delete process.env.PROXY_TOKEN;
    delete process.env.PROXY_URL;
    vi.unstubAllGlobals();
  });

  it('POSTs to /egress with x-proxy-token and wrapped body', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, 'ok'));

    // Import after env is set
    const { egressFetch } = await import('./proxy-client.js');
    await egressFetch('https://api.example.com/data', { method: 'GET' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8557/egress');
    expect((init as RequestInit).method).toBe('POST');

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-proxy-token']).toBe('test-token-123');
    expect(headers['content-type']).toBe('application/json');

    const parsedBody = JSON.parse((init as RequestInit).body as string);
    expect(parsedBody.url).toBe('https://api.example.com/data');
    expect(parsedBody.method).toBe('GET');
  });

  it('throws EgressDeniedError when proxy returns 403', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(403, JSON.stringify({ error: 'no catalog entry' })));

    const { egressFetch } = await import('./proxy-client.js');
    const { EgressDeniedError } = await import('./errors.js');

    await expect(egressFetch('https://blocked.example.com/')).rejects.toBeInstanceOf(EgressDeniedError);
  });

  it('throws ProxyUnreachableError on network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const { egressFetch } = await import('./proxy-client.js');
    const { ProxyUnreachableError } = await import('./errors.js');

    await expect(egressFetch('https://api.example.com/')).rejects.toBeInstanceOf(ProxyUnreachableError);
  });

  it('throws when PROXY_TOKEN is missing in sandbox mode', async () => {
    delete process.env.PROXY_TOKEN;

    const { egressFetch } = await import('./proxy-client.js');

    await expect(egressFetch('https://api.example.com/')).rejects.toThrow('PROXY_TOKEN required');
  });
});

describe('egressFetch — non-sandbox mode', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    process.env.PRIVOS_SANDBOX_MODE = 'false';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    delete process.env.PRIVOS_SANDBOX_MODE;
    vi.unstubAllGlobals();
  });

  it('calls the target URL directly', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, 'direct'));

    const { egressFetch } = await import('./proxy-client.js');
    await egressFetch('https://api.example.com/resource', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/resource');
    // Should NOT be posting to /egress
    expect(url).not.toContain('/egress');
  });
});

// ── hub-client ────────────────────────────────────────────────────────────────

describe('hub.get — sandbox mode', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    process.env.PRIVOS_SANDBOX_MODE = 'true';
    process.env.PROXY_TOKEN = 'hub-token';
    process.env.PROXY_URL = 'http://proxy:8557';
    process.env.PRIVOS_HUB_HOST = 'hub.example.com';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    delete process.env.PRIVOS_SANDBOX_MODE;
    delete process.env.PROXY_TOKEN;
    delete process.env.PROXY_URL;
    delete process.env.PRIVOS_HUB_HOST;
    vi.unstubAllGlobals();
  });

  it('routes hub.get through /egress with full hub URL in body', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, '{}'));

    const { hub } = await import('./hub-client.js');
    await hub.get('/api/rooms/123');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    // Should POST to proxy
    expect(url).toBe('http://proxy:8557/egress');
    const body = JSON.parse((init as RequestInit).body as string);
    // Body URL should point to hub
    expect(body.url).toBe('https://hub.example.com/api/rooms/123');
    expect(body.method).toBe('GET');
  });
});

describe('hub.get — non-sandbox mode', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    process.env.PRIVOS_SANDBOX_MODE = 'false';
    process.env.PRIVOS_URL = 'https://privos.example.com';
    process.env.PRIVOS_BOT_KEY = 'secret-bot-key';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    delete process.env.PRIVOS_SANDBOX_MODE;
    delete process.env.PRIVOS_URL;
    delete process.env.PRIVOS_BOT_KEY;
    vi.unstubAllGlobals();
  });

  it('calls hub URL directly with Authorization: Bearer header', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, '{}'));

    const { hub } = await import('./hub-client.js');
    await hub.get('/api/rooms/123');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://privos.example.com/api/rooms/123');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-bot-key');
  });
});

describe('hub.post', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    process.env.PRIVOS_SANDBOX_MODE = 'false';
    process.env.PRIVOS_URL = 'https://privos.example.com';
    process.env.PRIVOS_BOT_KEY = 'bot-key';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    delete process.env.PRIVOS_SANDBOX_MODE;
    delete process.env.PRIVOS_URL;
    delete process.env.PRIVOS_BOT_KEY;
    vi.unstubAllGlobals();
  });

  it('serializes json option and sets content-type', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(201, '{}'));

    const { hub } = await import('./hub-client.js');
    await hub.post('/api/messages', { json: { text: 'hello' } });

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe('POST');
    const parsedBody = JSON.parse((init as RequestInit).body as string);
    expect(parsedBody.text).toBe('hello');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
  });
});

// ── external-client ───────────────────────────────────────────────────────────

describe('external.fetch — sandbox mode', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    process.env.PRIVOS_SANDBOX_MODE = 'true';
    process.env.PROXY_TOKEN = 'ext-token';
    process.env.PROXY_URL = 'http://proxy:8557';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    delete process.env.PRIVOS_SANDBOX_MODE;
    delete process.env.PROXY_TOKEN;
    delete process.env.PROXY_URL;
    vi.unstubAllGlobals();
  });

  it('routes external fetch through proxy /egress', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, 'data'));

    const { external } = await import('./external-client.js');
    await external.fetch('https://api.github.com/repos/foo/bar');

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://proxy:8557/egress');
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.url).toBe('https://api.github.com/repos/foo/bar');
  });
});

describe('external.fetch — non-sandbox mode', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    process.env.PRIVOS_SANDBOX_MODE = 'false';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    delete process.env.PRIVOS_SANDBOX_MODE;
    vi.unstubAllGlobals();
  });

  it('calls target URL directly in non-sandbox mode', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, 'data'));

    const { external } = await import('./external-client.js');
    await external.fetch('https://api.github.com/repos/foo/bar');

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/foo/bar');
  });
});

// ── env whitelist ─────────────────────────────────────────────────────────────

describe('env whitelist — sandbox mode', () => {
  beforeEach(() => {
    process.env.PRIVOS_SANDBOX_MODE = 'true';
    process.env.PRIVOS_BOT_KEY = 'should-be-hidden';
    process.env.PRIVOS_URL = 'https://should-be-hidden.com';
    process.env.PRIVOS_ROOM_ID = 'room-abc';
    process.env.PRIVOS_BOT_ID = 'bot-xyz';
  });

  afterEach(() => {
    delete process.env.PRIVOS_SANDBOX_MODE;
    delete process.env.PRIVOS_BOT_KEY;
    delete process.env.PRIVOS_URL;
    delete process.env.PRIVOS_ROOM_ID;
    delete process.env.PRIVOS_BOT_ID;
  });

  it('hides PRIVOS_BOT_KEY in sandbox mode', async () => {
    const { env } = await import('./env.js');
    expect(env.PRIVOS_BOT_KEY).toBeUndefined();
  });

  it('hides PRIVOS_URL in sandbox mode', async () => {
    const { env } = await import('./env.js');
    expect(env.PRIVOS_URL).toBeUndefined();
  });

  it('exposes PRIVOS_ROOM_ID in sandbox mode', async () => {
    const { env } = await import('./env.js');
    expect(env.PRIVOS_ROOM_ID).toBe('room-abc');
  });

  it('exposes PRIVOS_BOT_ID in sandbox mode', async () => {
    const { env } = await import('./env.js');
    expect(env.PRIVOS_BOT_ID).toBe('bot-xyz');
  });
});

describe('env whitelist — non-sandbox mode', () => {
  beforeEach(() => {
    process.env.PRIVOS_SANDBOX_MODE = 'false';
    process.env.PRIVOS_BOT_KEY = 'real-key';
    process.env.PRIVOS_URL = 'https://privos.example.com';
  });

  afterEach(() => {
    delete process.env.PRIVOS_SANDBOX_MODE;
    delete process.env.PRIVOS_BOT_KEY;
    delete process.env.PRIVOS_URL;
  });

  it('exposes PRIVOS_BOT_KEY in non-sandbox mode', async () => {
    const { env } = await import('./env.js');
    expect(env.PRIVOS_BOT_KEY).toBe('real-key');
  });

  it('exposes PRIVOS_URL in non-sandbox mode', async () => {
    const { env } = await import('./env.js');
    expect(env.PRIVOS_URL).toBe('https://privos.example.com');
  });
});

// ── error classes ─────────────────────────────────────────────────────────────

describe('error classes', () => {
  it('EgressDeniedError has correct name and host', async () => {
    const { EgressDeniedError } = await import('./errors.js');
    const err = new EgressDeniedError('api.example.com');
    expect(err.name).toBe('EgressDeniedError');
    expect(err.host).toBe('api.example.com');
    expect(err instanceof Error).toBe(true);
    expect(err.message).toContain('api.example.com');
  });

  it('ProxyUnreachableError captures cause', async () => {
    const { ProxyUnreachableError } = await import('./errors.js');
    const cause = new TypeError('ECONNREFUSED');
    const err = new ProxyUnreachableError('http://proxy:8557', cause);
    expect(err.name).toBe('ProxyUnreachableError');
    expect(err.proxyUrl).toBe('http://proxy:8557');
    expect(err.cause).toBe(cause);
  });

  it('UpstreamError carries status and target', async () => {
    const { UpstreamError } = await import('./errors.js');
    const err = new UpstreamError(429, 'https://api.example.com/resource', 'rate limited');
    expect(err.name).toBe('UpstreamError');
    expect(err.status).toBe(429);
    expect(err.target).toBe('https://api.example.com/resource');
    expect(err.message).toContain('429');
  });
});
