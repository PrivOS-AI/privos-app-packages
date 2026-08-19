import { afterEach, describe, expect, it } from 'vitest';

import {
	AGENT_BOT_CREDENTIAL_ENV_KEY,
	AGENT_BOT_USER_ID_ENV_KEY,
	getAgentBotCredentialState,
	resetAgentBotCredentialOutcomeForTests,
} from '../../src/relay/agent-bot-credential.js';
import {
	AgentBotCredentialAbsentError,
	AgentBotHubUnreachableError,
	createAgentBotHubClient,
	createAgentBotHubClientFromHubOrigin,
} from '../../src/relay/hub-rest-as-bot-client.js';

const FAKE_TOKEN = 'agent-bot-fake-token-not-a-real-secret-93f7';
const HUB_ORIGIN = 'https://hub.example.test';

function setCredentialEnv(): void {
	process.env[AGENT_BOT_CREDENTIAL_ENV_KEY] = FAKE_TOKEN;
	process.env[AGENT_BOT_USER_ID_ENV_KEY] = 'bot-user-a';
	resetAgentBotCredentialOutcomeForTests();
}

afterEach(() => {
	delete process.env[AGENT_BOT_CREDENTIAL_ENV_KEY];
	delete process.env[AGENT_BOT_USER_ID_ENV_KEY];
	resetAgentBotCredentialOutcomeForTests();
});

describe('createAgentBotHubClient', () => {
	it('needs no ToolCallContext: sends the credential header pair to the resolved origin', async () => {
		setCredentialEnv();
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const client = createAgentBotHubClient({
			resolveHubOrigin: async () => HUB_ORIGIN,
			fetchImplementation: (async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) || {} });
				return new Response(JSON.stringify({ success: true }), { status: 200 });
			}) as typeof fetch,
		});
		const response = await client.authorizedFetch('/api/v1/file-management.files.all/room-a', {
			method: 'GET',
			requiredScope: 'files:read',
			retryMode: 'safe-methods',
		});
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(`${HUB_ORIGIN}/api/v1/file-management.files.all/room-a`);
		expect(calls[0]!.headers['x-user-id']).toBe('bot-user-a');
		expect(calls[0]!.headers['x-auth-token']).toBe(FAKE_TOKEN);
	});

	it('createAgentBotHubClientFromHubOrigin uses the fixed caller-supplied origin', async () => {
		setCredentialEnv();
		const calls: string[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (url: string) => {
			calls.push(String(url));
			return new Response('{}', { status: 200 });
		}) as typeof fetch;
		try {
			const client = createAgentBotHubClientFromHubOrigin(HUB_ORIGIN);
			const response = await client.authorizedFetch('/api/v1/me', { method: 'GET', requiredScope: 'files:read' });
			expect(response.status).toBe(200);
			expect(calls).toEqual([`${HUB_ORIGIN}/api/v1/me`]);
		} finally {
			globalThis.fetch = original;
		}
	});

	it('an absent credential fails before any network call', async () => {
		resetAgentBotCredentialOutcomeForTests();
		const calls: string[] = [];
		const client = createAgentBotHubClient({
			resolveHubOrigin: async () => HUB_ORIGIN,
			fetchImplementation: (async (url: string) => {
				calls.push(String(url));
				return new Response('{}', { status: 200 });
			}) as typeof fetch,
		});
		await expect(client.authorizedFetch('/api/v1/me', { method: 'GET', requiredScope: 'files:read' })).rejects.toBeInstanceOf(
			AgentBotCredentialAbsentError,
		);
		expect(calls).toHaveLength(0);
	});

	it('an unresolved Hub origin is reported distinctly from a credential rejection', async () => {
		setCredentialEnv();
		const client = createAgentBotHubClient({ resolveHubOrigin: async () => undefined });
		await expect(client.authorizedFetch('/api/v1/me', { method: 'GET', requiredScope: 'files:read' })).rejects.toBeInstanceOf(
			AgentBotHubUnreachableError,
		);
	});

	it('a 401 marks the credential rejected and is never retried', async () => {
		setCredentialEnv();
		let calls = 0;
		const client = createAgentBotHubClient({
			resolveHubOrigin: async () => HUB_ORIGIN,
			fetchImplementation: (async () => {
				calls += 1;
				return new Response('{}', { status: 401 });
			}) as typeof fetch,
		});
		const response = await client.authorizedFetch('/api/v1/x', { method: 'GET', requiredScope: 'files:read', retryMode: 'safe-methods' });
		expect(response.status).toBe(401);
		expect(calls).toBe(1);
		expect(getAgentBotCredentialState()).toBe('rejected');
	});

	it('a GET retries a transient 5xx under safe-methods and eventually succeeds', async () => {
		setCredentialEnv();
		let calls = 0;
		const client = createAgentBotHubClient({
			resolveHubOrigin: async () => HUB_ORIGIN,
			fetchImplementation: (async () => {
				calls += 1;
				return calls < 3 ? new Response('{}', { status: 503 }) : new Response('{}', { status: 200 });
			}) as typeof fetch,
		});
		const response = await client.authorizedFetch('/api/v1/me', { method: 'GET', requiredScope: 'files:read', retryMode: 'safe-methods' });
		expect(response.status).toBe(200);
		expect(calls).toBe(3);
	});

	it('a mutation with retryMode "never" is never retried, even on a transient failure', async () => {
		setCredentialEnv();
		let calls = 0;
		const client = createAgentBotHubClient({
			resolveHubOrigin: async () => HUB_ORIGIN,
			fetchImplementation: (async () => {
				calls += 1;
				return new Response('{}', { status: 503 });
			}) as typeof fetch,
		});
		const response = await client.authorizedFetch('/api/v1/x', { method: 'POST', requiredScope: 'files:read', retryMode: 'never' });
		expect(response.status).toBe(503);
		expect(calls).toBe(1);
	});

	it('leak sweep: a network error embedding the token never surfaces it', async () => {
		setCredentialEnv();
		const client = createAgentBotHubClient({
			resolveHubOrigin: async () => HUB_ORIGIN,
			fetchImplementation: (async () => {
				throw new Error(`connect failed while sending x-auth-token: ${FAKE_TOKEN}`);
			}) as typeof fetch,
		});
		let caught: unknown;
		try {
			await client.authorizedFetch('/api/v1/x', { method: 'POST', requiredScope: 'files:read', retryMode: 'never' });
			expect.unreachable('expected authorizedFetch to reject');
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AgentBotHubUnreachableError);
		const message = caught instanceof Error ? caught.message : String(caught);
		expect(message.includes(FAKE_TOKEN)).toBe(false);
		expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught as object)).includes(FAKE_TOKEN)).toBe(false);
	});
});
