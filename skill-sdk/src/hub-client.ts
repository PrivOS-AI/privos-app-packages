/**
 * hub-client.ts — High-level PrivOS hub HTTP client.
 *
 * In sandbox mode:  builds full URL from hubHost() and routes via egressFetch (proxy).
 * In non-sandbox:   builds full URL from privosUrl() and sends direct with Bearer token.
 *
 * SSE streaming via hub.stream() returns an AsyncIterable<MessageEvent-like> object.
 * File uploads via hub.uploadFile() send raw binary through /egress or direct.
 */
import { isSandboxMode, hubHost, privosUrl, privosBotKey } from './mode.js';
import { egressFetch, type EgressOptions } from './proxy-client.js';

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildHubUrl(path: string): string {
  if (isSandboxMode()) {
    const host = hubHost();
    if (!host) throw new Error('PRIVOS_HUB_HOST is required in sandbox mode');
    return `https://${host}${path}`;
  }
  const base = privosUrl();
  if (!base) throw new Error('PRIVOS_URL is required in non-sandbox mode');
  return `${base.replace(/\/$/, '')}${path}`;
}

function authHeaders(): Record<string, string> {
  if (isSandboxMode()) {
    // Auth is handled by x-proxy-token at the proxy layer — no extra header needed.
    return {};
  }
  const key = privosBotKey();
  if (!key) throw new Error('PRIVOS_BOT_KEY is required in non-sandbox mode');
  return { Authorization: `Bearer ${key}` };
}

async function hubRequest(
  path: string,
  opts: EgressOptions & { extraHeaders?: Record<string, string> } = {},
): Promise<Response> {
  const url = buildHubUrl(path);
  const headers: Record<string, string> = {
    ...authHeaders(),
    ...(opts.extraHeaders ?? {}),
    ...(opts.headers ?? {}),
  };
  return egressFetch(url, { ...opts, headers });
}

// ── Parsed SSE event (mirrors browser MessageEvent fields used by skills) ─────

export interface SseMessage {
  /** SSE event type (defaults to "message" when not set by server). */
  event: string;
  /** Raw data string from the SSE line. */
  data: string;
  /** Optional event id. */
  id?: string;
}

// ── Public hub client object ──────────────────────────────────────────────────

export const hub = {
  /** GET a hub path. Returns raw Response. */
  async get(path: string, headers?: Record<string, string>): Promise<Response> {
    return hubRequest(path, { method: 'GET', extraHeaders: headers });
  },

  /** POST to a hub path with optional JSON or raw body. */
  async post(
    path: string,
    opts: { json?: unknown; body?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const isJson = opts.json !== undefined;
    const body = isJson ? JSON.stringify(opts.json) : opts.body;
    const extraHeaders: Record<string, string> = {};
    if (isJson) extraHeaders['content-type'] = 'application/json';
    if (opts.headers) Object.assign(extraHeaders, opts.headers);
    return hubRequest(path, { method: 'POST', body, extraHeaders });
  },

  /** PUT to a hub path with optional JSON or raw body. */
  async put(
    path: string,
    opts: { json?: unknown; body?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const isJson = opts.json !== undefined;
    const body = isJson ? JSON.stringify(opts.json) : opts.body;
    const extraHeaders: Record<string, string> = {};
    if (isJson) extraHeaders['content-type'] = 'application/json';
    if (opts.headers) Object.assign(extraHeaders, opts.headers);
    return hubRequest(path, { method: 'PUT', body, extraHeaders });
  },

  /** DELETE a hub path. Returns raw Response. */
  async delete(path: string, headers?: Record<string, string>): Promise<Response> {
    return hubRequest(path, { method: 'DELETE', extraHeaders: headers });
  },

  /**
   * Upload binary data to a hub files endpoint.
   * data is a Buffer (Node.js) — converted to base64 string for /egress body field.
   * In non-sandbox mode sends a direct PUT with raw binary.
   */
  async uploadFile(
    path: string,
    data: Buffer,
    contentType = 'application/octet-stream',
  ): Promise<Response> {
    const url = buildHubUrl(path);
    if (isSandboxMode()) {
      // /egress body is a string — base64-encode binary data
      return egressFetch(url, {
        method: 'PUT',
        headers: {
          'content-type': contentType,
          'x-content-encoding': 'base64',
        },
        body: data.toString('base64'),
      });
    }
    // Non-sandbox: direct fetch with raw binary
    const key = privosBotKey();
    if (!key) throw new Error('PRIVOS_BOT_KEY is required in non-sandbox mode');
    return fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${key}`,
        'content-type': contentType,
      },
      // `data` is a Node Buffer; fetch accepts ArrayBuffer for binary bodies.
      // .buffer gives the underlying ArrayBuffer without copying (sliced view
      // is accounted for via byteOffset/byteLength in Node's implementation).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (data as any).buffer as ArrayBuffer,
    });
  },

  /**
   * Server-Sent Events stream from a hub path.
   * Returns an AsyncIterable that yields parsed SSE messages.
   * Caller is responsible for consuming the iterator promptly.
   *
   * Usage:
   *   for await (const msg of hub.stream('/api/events')) {
   *     console.log(msg.event, msg.data);
   *   }
   */
  stream(path: string): AsyncIterable<SseMessage> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<SseMessage> {
        // Lazy: defer the fetch until the iterator is first consumed.
        let readerRef: ReadableStreamDefaultReader<Uint8Array> | null = null;
        let buffer = '';
        let done = false;

        const decoder = new TextDecoder();

        // Accumulate raw SSE buffer and emit complete events
        function* parseBuffer(): Generator<SseMessage> {
          const events = buffer.split(/\n\n/);
          // Last element is incomplete — keep it in buffer
          buffer = events.pop() ?? '';
          for (const block of events) {
            if (!block.trim()) continue;
            const msg: SseMessage = { event: 'message', data: '' };
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) {
                msg.event = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                msg.data = (msg.data ? msg.data + '\n' : '') + line.slice(5).trim();
              } else if (line.startsWith('id:')) {
                msg.id = line.slice(3).trim();
              }
            }
            yield msg;
          }
        }

        async function init() {
          const url = buildHubUrl(path);
          const response = await egressFetch(url, {
            method: 'GET',
            headers: {
              Accept: 'text/event-stream',
              ...authHeaders(),
            },
          });
          if (!response.body) throw new Error('No response body for SSE stream');
          readerRef = response.body.getReader();
        }

        const pending: SseMessage[] = [];
        let initPromise: Promise<void> | null = null;

        return {
          async next(): Promise<IteratorResult<SseMessage>> {
            if (done) return { done: true, value: undefined as unknown as SseMessage };

            // Drain pending parsed messages first
            if (pending.length > 0) {
              return { done: false, value: pending.shift()! };
            }

            // Lazy init on first call
            if (!initPromise) {
              initPromise = init();
            }
            await initPromise;

            const reader = readerRef!;

            while (true) {
              // Return any queued events from previous chunk
              if (pending.length > 0) {
                return { done: false, value: pending.shift()! };
              }

              const { done: streamDone, value } = await reader.read();
              if (streamDone) {
                done = true;
                return { done: true, value: undefined as unknown as SseMessage };
              }

              buffer += decoder.decode(value, { stream: true });
              for (const msg of parseBuffer()) {
                pending.push(msg);
              }
            }
          },

          async return(): Promise<IteratorResult<SseMessage>> {
            done = true;
            await readerRef?.cancel();
            return { done: true, value: undefined as unknown as SseMessage };
          },
        };
      },
    };
  },
};
