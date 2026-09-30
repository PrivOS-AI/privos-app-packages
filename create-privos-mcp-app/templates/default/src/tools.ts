/**
 * Tool handlers and the MCP dispatch around them. `tools/list` is the
 * manifest's own tool list and `tools/call` dispatches by name, so a tool
 * exists in exactly one place in the manifest and one place here.
 *
 * A handler is a function of `(arguments, context)`. Take the caller and the
 * room only from `context`: `context.actor` is the user the Hub signed for and
 * `context.roomId` the room its dispatch was authorized for. Never read a user
 * or room id from the arguments, from request metadata or from a header: those
 * are not proof of anything.
 */
import type { ApplicationMcpRequest, ToolCallContext } from '@privos_ai/app-server';

import { loadManifest } from './manifest.js';

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export type ToolHandler = (args: Record<string, unknown>, context: ToolCallContext) => ToolResult | Promise<ToolResult>;

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function textResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export const toolHandlers: Record<string, ToolHandler> = {
  '{{APP_NAME}}_dashboard': () => textResult('Dashboard opened.'),

  /**
   * Fails closed: without a verified actor the tool answers with an error and
   * never falls back to an unverified identity.
   */
  '{{APP_NAME}}_whoami': (_args, context) => {
    const { actor } = context;
    if (!actor) {
      return textResult('No verified caller is available for this request, so it was refused.', true);
    }
    return textResult({
      userId: actor.userId,
      username: actor.username ?? null,
      roomId: context.roomId ?? null,
      provenance: actor.provenance,
    });
  },
};

export async function handleMcpRequest(request: ApplicationMcpRequest, context: ToolCallContext): Promise<unknown> {
  if (request.method === 'tools/list') {
    return {
      tools: loadManifest().tools.map(({ ui, ...tool }) => (ui ? { ...tool, _meta: { ui } } : tool)),
    };
  }

  if (request.method === 'tools/call') {
    const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = typeof params.name === 'string' ? params.name : '';
    const handler = Object.hasOwn(toolHandlers, name) ? toolHandlers[name] : undefined;
    if (!handler) throw rpcError(INVALID_PARAMS, `Unknown tool: ${name || '<missing>'}`);
    const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
    return handler(args, context);
  }

  throw rpcError(METHOD_NOT_FOUND, `Method not found: ${request.method}`);
}
