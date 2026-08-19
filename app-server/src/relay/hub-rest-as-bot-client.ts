/**
 * Hub REST transport that authenticates as this app's own installation bot.
 *
 * Hub authenticates a REST call from the header PAIR `x-user-id` +
 * `x-auth-token` (privos-hub `apps/meteor/app/api/server/api.ts` auth path).
 * This transport reads that pair from `agent-bot-credential.ts` on every
 * call — never once at construction — and never carries any Sandbox
 * selector, verified-room binding, or human-actor identity: the bot is a
 * standing, room-independent identity, so this transport needs no
 * `ToolCallContext` at all and works exactly the same inside a live tool
 * call as it does in the background.
 *
 * This is the canonical home of `RoomBoundHubClient` / `RoomBoundHubFetchInit`.
 * Both this bot-credential transport and the per-call room-bound workload
 * client (`workloadIdentityClient.forRoom(context)`) satisfy the same
 * `RoomBoundHubClient` shape, so callers can accept either without a second
 * interface.
 */
import type { WorkloadIdentityClient } from '../workload/workload-identity.js';

import {
	markAgentBotCredentialLive,
	markAgentBotCredentialRejected,
	readAgentBotCredential,
} from './agent-bot-credential.js';

/** The room-bound surface a Hub REST caller is allowed to use. */
export interface RoomBoundHubClient {
	authorizedFetch(input: string, init: RoomBoundHubFetchInit): Promise<Response>;
}

export interface RoomBoundHubFetchInit extends RequestInit {
	/** One exact granted permission this call exercises. Documentation only here: this transport carries exactly one identity, not a per-scope token. */
	requiredScope: string;
	retryMode?: 'safe-methods' | 'idempotent' | 'never';
	replayable?: true;
}

/** The credential is absent: there is nothing to send. Distinct from a Hub rejection. */
export class AgentBotCredentialAbsentError extends Error {
	constructor() {
		super('agent_bot_credential_absent');
		this.name = 'AgentBotCredentialAbsentError';
	}
}

/**
 * Hub could not be reached, or its origin could not be resolved. Distinct
 * from a 401: nothing here says the credential itself is wrong. Deliberately
 * carries no cause detail — a caught network error's message is never safe to
 * surface, since nothing guarantees it cannot embed request state.
 */
export class AgentBotHubUnreachableError extends Error {
	constructor() {
		super('agent_bot_hub_unreachable');
		this.name = 'AgentBotHubUnreachableError';
	}
}

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 200;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableMethod = (method: string, retryMode: RoomBoundHubFetchInit['retryMode']): boolean => {
	if (retryMode === 'safe-methods') return method === 'GET' || method === 'HEAD';
	if (retryMode === 'idempotent') return method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE';
	return false;
};

export interface AgentBotHubClientOptions {
	/** Resolve the current Hub origin. `undefined` means Hub is unreachable right now. */
	resolveHubOrigin: () => Promise<string | undefined>;
	fetchImplementation?: typeof fetch;
}

/**
 * Build the bot-credential transport.
 *
 * Every call re-reads the credential and re-resolves the Hub origin, so a
 * long-lived instance never holds a stale value across a container restart
 * boundary (irrelevant in practice, since a restart is a new process) or
 * across a hot credential re-issue within the same process (relevant: the
 * standalone control channel adopts a re-issued value in-process, and reading
 * fresh here is what makes that observable without a restart).
 */
export function createAgentBotHubClient(options: AgentBotHubClientOptions): RoomBoundHubClient {
	const doFetch = options.fetchImplementation ?? fetch;

	async function attempt(url: string, init: RoomBoundHubFetchInit, credential: { botUserId: string; token: string }): Promise<Response> {
		const { requiredScope: _requiredScope, retryMode: _retryMode, replayable: _replayable, headers, ...rest } = init;
		const response = await doFetch(url, {
			...rest,
			headers: {
				...(headers as Record<string, string> | undefined),
				'x-user-id': credential.botUserId,
				'x-auth-token': credential.token,
			},
		});
		if (response.status === 401) markAgentBotCredentialRejected();
		else if (response.ok) markAgentBotCredentialLive();
		return response;
	}

	return {
		async authorizedFetch(input, init) {
			const credential = readAgentBotCredential();
			if (!credential) throw new AgentBotCredentialAbsentError();

			let hubOrigin: string | undefined;
			try {
				hubOrigin = await options.resolveHubOrigin();
			} catch {
				hubOrigin = undefined;
			}
			if (!hubOrigin) throw new AgentBotHubUnreachableError();
			const url = `${hubOrigin}${input}`;

			const method = (init.method || 'GET').toUpperCase();
			const retryable = isRetryableMethod(method, init.retryMode);
			const maxAttempts = retryable ? RETRY_ATTEMPTS : 1;

			for (let index = 0; index < maxAttempts; index += 1) {
				try {
					const response = await attempt(url, init, credential);
					// A 401 is a definitive rejection: retrying with the SAME stale
					// credential cannot succeed, so it is never retried.
					if (response.status === 401) return response;
					if (response.status >= 500 && retryable && index < maxAttempts - 1) {
						await delay(RETRY_BASE_DELAY_MS * 2 ** index);
						continue;
					}
					return response;
				} catch {
					// Network/DNS/timeout failure. The caught error is discarded
					// entirely and never inspected: nothing guarantees its message
					// cannot embed request state, and none of it is safe to surface.
					if (!retryable || index >= maxAttempts - 1) throw new AgentBotHubUnreachableError();
					await delay(RETRY_BASE_DELAY_MS * 2 ** index);
				}
			}
			// Unreachable in practice (the loop above always returns or throws),
			// kept only so this function has an exhaustive static return type.
			throw new AgentBotHubUnreachableError();
		},
	};
}

/**
 * Managed-mode production factory: resolve the Hub origin from the same
 * broker connection the workload identity client already maintains,
 * independent of any verified `ToolCallContext` — `brokerContext()` is
 * available whenever this process is paired, exactly the background-safe
 * property this transport needs. Managed mode only: standalone-production
 * (Relay) never mounts a workload broker, so this factory is not usable
 * there — see `createAgentBotHubClientFromHubOrigin`.
 */
export function createAgentBotHubClientFromWorkloadIdentity(workloadIdentityClient: WorkloadIdentityClient): RoomBoundHubClient {
	return createAgentBotHubClient({
		resolveHubOrigin: async () => {
			try {
				return (await workloadIdentityClient.brokerContext()).hubOrigin;
			} catch {
				return undefined;
			}
		},
	});
}

/**
 * Standalone-production factory: there is no workload broker to resolve a
 * Hub origin from in this mode, so the caller supplies the one already
 * pinned in the paired standalone identity file (`loadStandaloneIdentity()`
 * → `relay.privosUrl` — the same origin the Relay OAuth token and WebSocket
 * are reached at).
 */
export function createAgentBotHubClientFromHubOrigin(hubOrigin: string): RoomBoundHubClient {
	return createAgentBotHubClient({ resolveHubOrigin: async () => hubOrigin });
}
