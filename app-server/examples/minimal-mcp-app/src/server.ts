/**
 * Minimal Direct MCP app — no business domain.
 * Used for conformance / smoke of @privos_ai/app-server.
 */
import express from 'express';
import {
	createDirectRouter,
	type AppDescriptor,
	type ApplicationMcpRequest,
	type ToolCallContext,
} from '@privos_ai/app-server';

const descriptor: AppDescriptor = {
	id: 'ai.privos.minimal',
	name: 'Minimal',
	version: '0.0.1',
	title: 'Minimal MCP App',
	description: 'Conformance example for @privos_ai/app-server',
	scopes: ['basic:information'],
};

async function handler(request: ApplicationMcpRequest, _ctx: ToolCallContext) {
	if (request.method === 'tools/list') {
		return {
			tools: [
				{
					name: 'minimal.ping',
					title: 'Ping',
					description: 'Health-style tool',
					inputSchema: { type: 'object', properties: {} },
				},
			],
		};
	}
	if (request.method === 'tools/call') {
		const name = (request.params as { name?: string } | undefined)?.name;
		if (name === 'minimal.ping') {
			return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
		}
		throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
	}
	throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
}

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(
	createDirectRouter({
		descriptor,
		handler,
		ui: {
			uri: 'ui://minimal/main.html',
			renderHtml: async () =>
				'<!DOCTYPE html><html><body><h1>Minimal</h1></body></html>',
		},
	}),
);

const port = Number(process.env.PORT) || 3101;
app.listen(port, () => {
	console.log(`[minimal-mcp-app] listening on http://localhost:${port}`);
});
