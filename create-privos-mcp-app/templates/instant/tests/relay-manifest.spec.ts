import { readFileSync } from 'node:fs';

import { sha256CanonicalJson } from '@privos_ai/app-server';
import { describe, expect, it } from 'vitest';

import {
  buildDescriptor,
  buildRelayManifest,
  handleRelayRequest,
  loadManifest,
  relayUiUri,
  type InstantManifest,
} from '../scripts/relay-manifest';

const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fileText = () => readFileSync(new URL('../privos-app.json', import.meta.url), 'utf8');

describe('relay manifest', () => {
  it('adds one UI tool per entry point and keeps everything else', () => {
    const manifest = loadManifest();
    const relay = buildRelayManifest(manifest);

    expect(relay.tools).toHaveLength(Object.keys(manifest.ui.entryPoints).length);
    const [roomTab] = relay.tools;
    expect(roomTab!.name).toMatch(TOOL_NAME);
    expect(roomTab!.title.length).toBeGreaterThan(0);
    expect(roomTab!.ui.resourceUri).toBe(manifest.ui.entryPoints.roomTab!.resourceUri);
    expect(roomTab!.inputSchema).toEqual({ type: 'object', properties: {} });
    const { tools: _tools, ...rest } = relay;
    expect(rest).toEqual(manifest);
  });

  it('names the tools uniquely, in slot order, even when two entry points show the same page', () => {
    const manifest = clone(loadManifest());
    const roomTab = manifest.ui.entryPoints.roomTab!;
    manifest.ui.entryPoints = { standalone: roomTab, roomTab, sidebar: roomTab };
    const relay = buildRelayManifest(manifest);

    expect(relay.tools.map((tool) => tool.ui.resourceUri)).toEqual([roomTab.resourceUri, roomTab.resourceUri, roomTab.resourceUri]);
    expect(new Set(relay.tools.map((tool) => tool.name)).size).toBe(3);
    expect(relay.tools[1]!.name.endsWith('_sidebar')).toBe(true);
    expect(relay.tools[2]!.name.endsWith('_standalone')).toBe(true);
    expect(relayUiUri(relay)).toBe(roomTab.resourceUri);
  });

  it('never touches privos-app.json or the manifest it is given', () => {
    const before = fileText();
    const manifest = loadManifest();
    const snapshot = clone(manifest);
    buildRelayManifest(manifest);

    expect(manifest).toEqual(snapshot);
    expect(fileText()).toBe(before);
    expect((JSON.parse(before) as { tools?: unknown }).tools).toBeUndefined();
  });

  it('is deterministic, so the digest pinned at pairing is the digest the running app reports', () => {
    const first = sha256CanonicalJson(buildRelayManifest(loadManifest()));
    const second = sha256CanonicalJson(buildRelayManifest(loadManifest()));
    expect(first).toBe(second);
  });

  it('changes the digest when privos-app.json really changes', () => {
    const manifest = loadManifest();
    const edited: InstantManifest = { ...clone(manifest), description: `${manifest.description} Edited.` };
    expect(sha256CanonicalJson(buildRelayManifest(edited))).not.toBe(sha256CanonicalJson(buildRelayManifest(manifest)));
  });

  it('refuses a manifest that already declares tools, or has no entry point, or several pages', () => {
    const manifest = loadManifest();
    expect(() => buildRelayManifest({ ...manifest, tools: [] })).toThrow(/must not declare tools/);
    expect(() => buildRelayManifest({ ...clone(manifest), ui: { entryPoints: {} } })).toThrow(/no ui.entryPoints/);

    const twoPages = clone(manifest);
    twoPages.ui.entryPoints.sidebar = { title: 'Other', resourceUri: `ui://${manifest.name}/other.html` };
    expect(() => relayUiUri(buildRelayManifest(twoPages))).toThrow(/one UI page/);
  });

  it('builds the pairing descriptor from the relay manifest', () => {
    const relay = buildRelayManifest(loadManifest());
    const descriptor = buildDescriptor(relay);
    expect(descriptor.id).toBe(relay.name);
    expect(descriptor.permissions).toEqual(relay.permissions);
  });
});

describe('relay handler', () => {
  const request = (method: string, params?: unknown) => ({ jsonrpc: '2.0' as const, id: 1, method, params });

  it('lists the relay tools with the UI under _meta', async () => {
    const relay = buildRelayManifest(loadManifest());
    const result = (await handleRelayRequest(request('tools/list'))) as { tools: Array<{ name: string; ui?: unknown; _meta: { ui: unknown } }> };
    expect(result.tools.map((tool) => tool.name)).toEqual(relay.tools.map((tool) => tool.name));
    for (const tool of result.tools) {
      expect(tool.ui).toBeUndefined();
      expect(tool._meta.ui).toEqual(relay.tools.find((candidate) => candidate.name === tool.name)!.ui);
    }
  });

  it('answers a call of a UI tool and rejects anything else', async () => {
    const [tool] = buildRelayManifest(loadManifest()).tools;
    await expect(handleRelayRequest(request('tools/call', { name: tool!.name }))).resolves.toMatchObject({ content: [{ type: 'text' }] });
    await expect(handleRelayRequest(request('tools/call', { name: 'nope' }))).rejects.toMatchObject({ code: -32602 });
    await expect(handleRelayRequest(request('prompts/list'))).rejects.toMatchObject({ code: -32601 });
  });
});
