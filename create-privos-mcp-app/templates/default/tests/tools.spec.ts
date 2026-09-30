import { readFileSync } from 'node:fs';

import type { ApplicationMcpRequest, ToolCallContext } from '@privos_ai/app-server';
import { describe, expect, it } from 'vitest';

import { handleMcpRequest, toolHandlers } from '../src/tools';

const manifest = JSON.parse(readFileSync(new URL('../privos-app.json', import.meta.url), 'utf8')) as {
  tools: Array<{ name: string; ui?: unknown }>;
};
const whoami = manifest.tools.find((tool) => tool.name.endsWith('_whoami'))!.name;

const verifiedContext: ToolCallContext = {
  transport: 'relay',
  identityState: 'verified',
  sessionScope: 'test',
  roomId: 'room-from-the-signed-dispatch',
  actor: { userId: 'user-1', username: 'ada', claims: {}, provenance: 'user-token' },
};
const anonymousContext: ToolCallContext = { transport: 'relay', identityState: 'missing', sessionScope: 'test' };

const call = (name: string, args: Record<string, unknown>, context: ToolCallContext) =>
  handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, context) as Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>;

describe('tools', () => {
  it('has a handler for every tool the manifest declares', () => {
    for (const tool of manifest.tools) expect(toolHandlers[tool.name], tool.name).toBeTypeOf('function');
  });

  it('lists the manifest tools, with the UI under _meta', async () => {
    const request: ApplicationMcpRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const result = (await handleMcpRequest(request, verifiedContext)) as { tools: Array<{ name: string; ui?: unknown; _meta?: { ui?: unknown } }> };
    expect(result.tools.map((tool) => tool.name)).toEqual(manifest.tools.map((tool) => tool.name));
    for (const tool of result.tools) {
      expect(tool.ui).toBeUndefined();
      const declared = manifest.tools.find((candidate) => candidate.name === tool.name)!;
      expect(tool._meta?.ui).toEqual(declared.ui);
    }
  });

  it('reports the verified caller and the room of the signed dispatch', async () => {
    const result = await call(whoami, {}, verifiedContext);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      userId: 'user-1',
      username: 'ada',
      roomId: 'room-from-the-signed-dispatch',
      provenance: 'user-token',
    });
  });

  it('ignores a roomId or userId passed as an argument', async () => {
    const result = await call(whoami, { roomId: 'someone-elses-room', userId: 'someone-else' }, verifiedContext);
    const body = JSON.parse(result.content[0]!.text) as { roomId: string; userId: string };
    expect(body.roomId).toBe('room-from-the-signed-dispatch');
    expect(body.userId).toBe('user-1');
  });

  it('refuses without a verified actor instead of falling back to an unverified identity', async () => {
    const result = await call(whoami, { userId: 'claimed-user', roomId: 'claimed-room' }, anonymousContext);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain('claimed');
  });

  it('rejects an unknown tool and an unknown method with JSON-RPC codes', async () => {
    await expect(call('no_such_tool', {}, verifiedContext)).rejects.toMatchObject({ code: -32602 });
    await expect(call('constructor', {}, verifiedContext)).rejects.toMatchObject({ code: -32602 });
    await expect(
      handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'prompts/list' }, verifiedContext),
    ).rejects.toMatchObject({ code: -32601 });
  });
});
