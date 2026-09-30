/**
 * The manifest a Relay preview pairs with and serves.
 *
 * An INSTANT app has no tools, and `privos-app.json` has to stay that way: the
 * marketplace refuses an INSTANT manifest that declares tools. A workspace that
 * talks to an app over Relay, though, finds the UI of a tab only through a tool
 * that points at it (`tools[].ui.resourceUri`). So the preview adds one UI-only
 * tool per `ui.entryPoints` entry, in memory. `privos-app.json` is never
 * written and never changes.
 *
 * `npm run pair` and `npm run dev` both call `buildRelayManifest`, so the
 * manifest digest pinned at pairing is the one the running app reports. A real
 * edit of `privos-app.json` changes that digest, and `/ready` then reports the
 * drift until the update is approved in the workspace.
 *
 * Development only: nothing in here is part of the UI bundle that gets published.
 */
import { readFileSync } from 'node:fs';

import type { AppDescriptor, ApplicationMcpRequest } from '@privos_ai/app-server';

const APP_NAME = '{{APP_NAME}}';

/** The order the workspace assigns entry points to its slots: room tab, sidebar, standalone. */
const ENTRY_POINT_SLOTS = ['roomTab', 'sidebar', 'standalone'] as const;

export interface EntryPoint {
  title: string;
  resourceUri: string;
}

export interface InstantManifest {
  name: string;
  version: string;
  title: string;
  description: string;
  author: { name: string; email?: string; website?: string };
  permissions: NonNullable<AppDescriptor['permissions']>;
  ui: { entryPoints: Partial<Record<(typeof ENTRY_POINT_SLOTS)[number], EntryPoint>> };
  tools?: unknown;
}

export interface RelayTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, never> };
  ui: { resourceUri: string };
}

export type RelayManifest = Omit<InstantManifest, 'tools'> & { tools: RelayTool[] };

const MANIFEST_URL = new URL('../privos-app.json', import.meta.url);

/** Read from disk on every call, so an edit shows up without a restart. */
export function loadManifest(): InstantManifest {
  return JSON.parse(readFileSync(MANIFEST_URL, 'utf8')) as InstantManifest;
}

/** `ui://<id>/dashboard.html` gives `dashboard`; anything else falls back to the slot name. */
function uiName(resourceUri: string, slot: string): string {
  return /\/([A-Za-z0-9][A-Za-z0-9._-]*)\.html$/.exec(resourceUri)?.[1] ?? slot;
}

/** `privos-app.json` plus one UI-only tool per entry point. The input is not modified. */
export function buildRelayManifest(manifest: InstantManifest): RelayManifest {
  if (manifest.tools !== undefined) {
    throw new Error('privos-app.json must not declare tools: an INSTANT app has none. The preview adds its own in memory.');
  }
  const used = new Set<string>();
  const tools: RelayTool[] = [];
  for (const slot of ENTRY_POINT_SLOTS) {
    const entry = manifest.ui?.entryPoints?.[slot];
    if (!entry) continue;
    const ui = uiName(entry.resourceUri, slot);
    // Two entry points may show the same page; every tool still needs its own name.
    const name = used.has(`${APP_NAME}_${ui}`) ? `${APP_NAME}_${ui}_${slot}` : `${APP_NAME}_${ui}`;
    used.add(name);
    tools.push({
      name,
      title: `${entry.title} ${ui}`.slice(0, 160),
      description: `Open the ${ui} of this app.`,
      inputSchema: { type: 'object', properties: {} },
      ui: { resourceUri: entry.resourceUri },
    });
  }
  if (tools.length === 0) throw new Error('privos-app.json declares no ui.entryPoints, so there is no UI to preview.');
  return { ...manifest, tools };
}

/**
 * The dev server has one UI provider, so every entry point has to show the same
 * page. The template has one page (`dashboard.html`).
 */
export function relayUiUri(manifest: RelayManifest): string {
  const uris = new Set(manifest.tools.map((tool) => tool.ui.resourceUri));
  if (uris.size !== 1) {
    throw new Error(`The preview serves one UI page; privos-app.json points its entry points at ${uris.size}: ${[...uris].join(', ')}`);
  }
  return [...uris][0]!;
}

/** What the SDK needs to pair and to answer `initialize`; built from the manifest, never by hand. */
export function buildDescriptor(manifest: RelayManifest): AppDescriptor {
  return {
    id: manifest.name,
    name: manifest.name,
    version: manifest.version,
    title: manifest.title,
    description: manifest.description,
    author: manifest.author,
    permissions: manifest.permissions,
  };
}

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** `tools/list` is the relay manifest's tool list; the tools only open the UI, so `tools/call` just acknowledges. */
export async function handleRelayRequest(request: ApplicationMcpRequest): Promise<unknown> {
  const { tools } = buildRelayManifest(loadManifest());
  if (request.method === 'tools/list') {
    return { tools: tools.map(({ ui, ...tool }) => ({ ...tool, _meta: { ui } })) };
  }
  if (request.method === 'tools/call') {
    const name = (request.params as { name?: unknown } | undefined)?.name;
    if (typeof name !== 'string' || !tools.some((tool) => tool.name === name)) {
      throw rpcError(INVALID_PARAMS, `Unknown tool: ${typeof name === 'string' ? name : '<missing>'}`);
    }
    return { content: [{ type: 'text', text: 'Opened.' }] };
  }
  throw rpcError(METHOD_NOT_FOUND, `Method not found: ${request.method}`);
}
