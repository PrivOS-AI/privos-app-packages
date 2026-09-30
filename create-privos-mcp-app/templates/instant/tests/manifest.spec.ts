import { readFileSync } from 'node:fs';

import { lintInstantManifest, lintManifest } from '@privos_ai/app-server';
import { describe, expect, it } from 'vitest';

interface Permission {
  scope: string;
  requirement: 'required' | 'optional';
  reason: string;
  degradedBehavior?: string;
}

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('privos-app.json')) as {
  name: string;
  version: string;
  permissions: Permission[];
};
const pkg = JSON.parse(read('package.json')) as { name: string; version: string };

describe('privos-app.json', () => {
  it('passes the SDK lint, including the INSTANT rules', () => {
    expect(lintManifest(manifest)).toMatchObject({ valid: true });
    expect(lintInstantManifest(manifest).errors).toEqual([]);
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
});
