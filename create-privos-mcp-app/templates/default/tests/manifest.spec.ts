import { readFileSync } from 'node:fs';

import { buildPairingMetadata, lintManifest } from '@privos_ai/app-server';
import { describe, expect, it } from 'vitest';

import { buildDescriptor, loadManifest } from '../src/manifest';

interface Permission {
  scope: string;
  requirement: 'required' | 'optional';
  feature: string;
  reason: string;
  degradedBehavior?: string;
}

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('privos-app.json')) as {
  name: string;
  version: string;
  port: number;
  permissions: Permission[];
  tools: Array<{ name: string; title: string; ui?: { resourceUri: string } }>;
  capabilities?: { verifiedActor?: boolean };
};
const pkg = JSON.parse(read('package.json')) as { name: string; version: string };

describe('privos-app.json', () => {
  it('passes the SDK lint', () => {
    expect(lintManifest(manifest)).toMatchObject({ valid: true });
  });

  it('agrees with package.json on name and version', () => {
    expect(manifest.name).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
  });

  it('points every ui:// URI at the manifest name', () => {
    const uris = read('privos-app.json').match(/ui:\/\/[^"]+/g) ?? [];
    expect(uris.length).toBeGreaterThan(0);
    for (const uri of uris) expect(new URL(uri).host).toBe(manifest.name);
  });

  it('gives every optional permission a degradedBehavior and every reason long enough', () => {
    for (const permission of manifest.permissions) {
      expect(permission.reason.length, `${permission.scope} reason`).toBeGreaterThanOrEqual(10);
      if (permission.requirement === 'optional') {
        expect(permission.degradedBehavior?.length, `${permission.scope} degradedBehavior`).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('asks for a verified actor and titles every tool', () => {
    expect(manifest.capabilities?.verifiedActor).toBe(true);
    for (const tool of manifest.tools) expect(tool.title.length, tool.name).toBeGreaterThan(0);
  });

  it('keeps the Dockerfile port in step with the manifest port', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain(`EXPOSE ${manifest.port}`);
    expect(dockerfile).toContain(`PORT=${manifest.port}`);
  });

  it('builds the pairing announcement from the same file', () => {
    const manifest = loadManifest();
    const meta = buildPairingMetadata(buildDescriptor(manifest));
    expect(meta.permissions?.map((permission) => permission.scope)).toEqual(manifest.permissions.map((permission) => permission.scope));
    expect(meta.version).toBe(manifest.version);
  });
});
