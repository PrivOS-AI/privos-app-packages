import { afterEach, describe, expect, it } from 'vitest';

import {
	AGENT_BOT_CREDENTIAL_ENV_KEY,
	AGENT_BOT_USER_ID_ENV_KEY,
	getAgentBotCredentialState,
	markAgentBotCredentialLive,
	markAgentBotCredentialRejected,
	readAgentBotCredential,
	resetAgentBotCredentialOutcomeForTests,
	setAdoptedAgentBotCredential,
} from '../../src/relay/agent-bot-credential.js';

const FAKE_TOKEN = 'agent-bot-fake-token-not-a-real-secret-93f7';

function clearEnv(): void {
	delete process.env[AGENT_BOT_CREDENTIAL_ENV_KEY];
	delete process.env[AGENT_BOT_USER_ID_ENV_KEY];
}

afterEach(() => {
	clearEnv();
	resetAgentBotCredentialOutcomeForTests();
});

describe('readAgentBotCredential', () => {
	it('is absent when neither the env pair nor an adopted value is present', () => {
		clearEnv();
		resetAgentBotCredentialOutcomeForTests();
		expect(readAgentBotCredential()).toBeNull();
		expect(getAgentBotCredentialState()).toBe('absent');
	});

	it('reads the env pair, trimming the user id', () => {
		process.env[AGENT_BOT_CREDENTIAL_ENV_KEY] = FAKE_TOKEN;
		process.env[AGENT_BOT_USER_ID_ENV_KEY] = '  bot-user-a  ';
		resetAgentBotCredentialOutcomeForTests();
		expect(readAgentBotCredential()).toEqual({ botUserId: 'bot-user-a', token: FAKE_TOKEN });
		expect(getAgentBotCredentialState()).toBe('live');
	});

	it('is absent when only one env var is set', () => {
		process.env[AGENT_BOT_CREDENTIAL_ENV_KEY] = FAKE_TOKEN;
		resetAgentBotCredentialOutcomeForTests();
		expect(readAgentBotCredential()).toBeNull();
	});
});

describe('hot adoption (standalone control channel / boot seed)', () => {
	it('adopts a credential in-process when no env pair is set', () => {
		clearEnv();
		resetAgentBotCredentialOutcomeForTests();
		setAdoptedAgentBotCredential({ botUserId: 'bot-user-b', token: FAKE_TOKEN });
		expect(readAgentBotCredential()).toEqual({ botUserId: 'bot-user-b', token: FAKE_TOKEN });
		expect(getAgentBotCredentialState()).toBe('live');
	});

	it('lets the env pair override an adopted value (operator override always wins)', () => {
		setAdoptedAgentBotCredential({ botUserId: 'adopted-user', token: 'adopted-token-not-real' });
		process.env[AGENT_BOT_CREDENTIAL_ENV_KEY] = FAKE_TOKEN;
		process.env[AGENT_BOT_USER_ID_ENV_KEY] = 'env-user';
		expect(readAgentBotCredential()).toEqual({ botUserId: 'env-user', token: FAKE_TOKEN });
	});

	it('clears a prior rejected outcome so a freshly adopted credential reads live', () => {
		setAdoptedAgentBotCredential({ botUserId: 'bot-user-c', token: 'first-token-not-real' });
		markAgentBotCredentialRejected();
		expect(getAgentBotCredentialState()).toBe('rejected');
		setAdoptedAgentBotCredential({ botUserId: 'bot-user-c', token: 'rotated-token-not-real' });
		expect(getAgentBotCredentialState()).toBe('live');
		expect(readAgentBotCredential()).toEqual({ botUserId: 'bot-user-c', token: 'rotated-token-not-real' });
	});

	it('ignores an empty adoption (never masks env with a blank pair)', () => {
		setAdoptedAgentBotCredential({ botUserId: '', token: '' });
		expect(readAgentBotCredential()).toBeNull();
	});
});

describe('outcome state machine', () => {
	it('reports rejected after a 401 and live after a success', () => {
		setAdoptedAgentBotCredential({ botUserId: 'u', token: 't-not-real' });
		markAgentBotCredentialRejected();
		expect(getAgentBotCredentialState()).toBe('rejected');
		markAgentBotCredentialLive();
		expect(getAgentBotCredentialState()).toBe('live');
	});
});
