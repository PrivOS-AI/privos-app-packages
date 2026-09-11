/**
 * Fakes the HUB side of the relay for tests. Node's global `WebSocket` (used
 * by hub-relay-client.ts) has no server counterpart, so this fixture uses the
 * `ws` package (a devDependency ONLY — `hub-relay-client.ts` itself never
 * imports `ws`) to stand in for the hub in `hub-relay-client.test.ts` and
 * `integration.test.ts`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerWebSocket } from 'ws';

export const RELAY_PATH = '/api/v1/agents.harness.relay';

export interface JsonRpcFrame {
	jsonrpc: '2.0';
	id?: string | number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export class FakeHub {
	private readonly httpServer = http.createServer();
	private readonly wss = new WebSocketServer({ noServer: true });
	/**
	 * Every accepted upgrade, INCLUDING the client's own `probeUpgradeStatus`
	 * preflight (which completes a real 101 handshake, sends nothing, and is
	 * destroyed immediately). Only used to sanity-check probe accounting.
	 */
	readonly sockets: ServerWebSocket[] = [];
	/** Connections that actually spoke JSON-RPC (sent `harness.hello`) — what tests should assert on. */
	readonly readyConnections: ServerWebSocket[] = [];
	readonly notifications: JsonRpcFrame[] = [];
	/** Set to reject the upgrade with a specific HTTP status before any WS handshake. */
	rejectStatus: number | undefined;
	readonly expectedToken: string;

	constructor(expectedToken: string) {
		this.expectedToken = expectedToken;
	}

	async listen(): Promise<string> {
		this.httpServer.on('upgrade', (req, socket, head) => {
			if (req.url !== RELAY_PATH || req.headers.authorization !== `Bearer ${this.expectedToken}`) {
				socket.write(`HTTP/1.1 401 Unauthorized\r\n\r\n`);
				socket.destroy();
				return;
			}
			if (this.rejectStatus) {
				socket.write(`HTTP/1.1 ${this.rejectStatus} ${this.rejectStatus === 403 ? 'Forbidden' : 'Rejected'}\r\n\r\n`);
				socket.destroy();
				return;
			}
			this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
		});
		this.wss.on('connection', (ws: ServerWebSocket) => {
			this.sockets.push(ws);
			ws.on('message', (raw: Buffer) => {
				const frame = JSON.parse(raw.toString('utf8')) as JsonRpcFrame;
				if (frame.method === 'harness.hello') {
					this.readyConnections.push(ws);
					ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { agentRoomId: 'agent-room-1', respondTo: 'owner' } }));
					return;
				}
				if (frame.method === undefined) return; // response-shaped frame we don't expect here
				// Everything else the bridge sends us is a notification (turn.chunk/tool_use/activity/done).
				this.notifications.push(frame);
			});
		});
		await new Promise<void>((resolve) => this.httpServer.listen(0, '127.0.0.1', resolve));
		const { port } = this.httpServer.address() as AddressInfo;
		return `http://127.0.0.1:${port}`;
	}

	/** Sends a `turn.start`-shaped request to the given (or latest ready) connection and waits for the reply. */
	sendRequest(method: string, params: unknown, ws?: ServerWebSocket): Promise<JsonRpcFrame> {
		const target = ws ?? this.readyConnections.at(-1)!;
		const id = `hub-${Math.random().toString(36).slice(2)}`;
		return new Promise((resolve) => {
			const onMessage = (raw: Buffer) => {
				const frame = JSON.parse(raw.toString('utf8')) as JsonRpcFrame;
				if (frame.id === id) {
					target.off('message', onMessage);
					resolve(frame);
				}
			};
			target.on('message', onMessage);
			target.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
		});
	}

	sendNotification(method: string, params: unknown, ws?: ServerWebSocket): void {
		(ws ?? this.readyConnections.at(-1)!).send(JSON.stringify({ jsonrpc: '2.0', method, params }));
	}

	async close(): Promise<void> {
		this.wss.close();
		await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
	}
}
