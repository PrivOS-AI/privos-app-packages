/**
 * Relay wiring sketch for @privos/app-server (mock Hub in unit tests; real Hub in staging).
 *
 * Direct entrypoint remains `src/server.ts`. This file documents the Relay twin
 * using the same handler/descriptor — run only when CLIENT_ID/SECRET are set.
 */
import {
	connectRelay,
	type AppDescriptor,
	type ApplicationMcpRequest,
	type ToolCallContext,
} from '@privos/app-server';

const descriptor: AppDescriptor = {
	id: 'ai.privos.minimal',
	name: 'Minimal',
	version: '0.0.1',
	title: 'Minimal MCP App',
};

async function handler(request: ApplicationMcpRequest, _ctx: ToolCallContext) {
	if (request.method === 'tools/list') {
		return {
			tools: [
				{
					name: 'minimal.ping',
					inputSchema: { type: 'object', properties: {} },
				},
			],
		};
	}
	if (request.method === 'tools/call') {
		return { content: [{ type: 'text', text: '{"ok":true}' }] };
	}
	throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
}

const privosUrl = process.env.PRIVOS_URL;
const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;

if (!privosUrl || !clientId || !clientSecret) {
	console.error('Set PRIVOS_URL, CLIENT_ID, CLIENT_SECRET to run relay smoke.');
	process.exit(2);
}

const handle = connectRelay({
	privosUrl,
	clientId,
	clientSecret,
	descriptor,
	handler,
	ui: {
		uri: 'ui://minimal/main.html',
		renderHtml: async () => '<!DOCTYPE html><html><body>Minimal</body></html>',
	},
});

await handle.whenConnected();
console.log('[minimal-relay] connected — Ctrl+C to stop');

process.on('SIGINT', () => {
	void handle.stop().then(() => process.exit(0));
});
