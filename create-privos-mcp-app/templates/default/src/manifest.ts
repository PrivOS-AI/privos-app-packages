/**
 * The reviewed manifest (`privos-app.json`) is the one source of truth: the
 * descriptor the app pairs and initializes with, `tools/list`, the served
 * `/.well-known/mcp/manifest.json` and the tests all read it from here.
 *
 * It is read from disk on every call, not imported, so an edit shows up without
 * a restart: the SDK's `/ready` compares the same file with the manifest the
 * workspace approved and reports the drift.
 */
import { readFileSync } from 'node:fs';

import type { AppDescriptor } from '@privos_ai/app-server';

export interface ManifestTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  ui?: { resourceUri: string };
}

export interface AppManifest {
  name: string;
  version: string;
  title: string;
  description: string;
  author: { name: string; email?: string; website?: string };
  permissions: NonNullable<AppDescriptor['permissions']>;
  tools: ManifestTool[];
  port: number;
}

// Both `src/` and the compiled `dist-server/` sit one level below the project root.
const MANIFEST_URL = new URL('../privos-app.json', import.meta.url);

export function loadManifest(): AppManifest {
  return JSON.parse(readFileSync(MANIFEST_URL, 'utf8')) as AppManifest;
}

/** What the SDK needs to pair and to answer `initialize`; built from the manifest, never by hand. */
export function buildDescriptor(manifest: AppManifest = loadManifest()): AppDescriptor {
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

/** `ui://<app id>/dashboard.html`, the shell every UI tool points at. */
export function dashboardUri(manifest: AppManifest = loadManifest()): string {
  return `ui://${manifest.name}/dashboard.html`;
}
