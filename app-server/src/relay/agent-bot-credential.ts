/**
 * An app's own installation-bot credential, read from its own environment or
 * adopted live over the standalone control channel.
 *
 * There is no issuance code path here. A workspace admin issues (or re-issues)
 * the credential from Hub's admin app settings page; Hub mints it, then
 * delivers it to the running app one of two ways:
 *   - managed / marketplace: written into the app's encrypted env config, so it
 *     arrives as an environment variable at container (re)start;
 *   - standalone-production: pushed as a signed control assertion over the Relay
 *     WebSocket (see `standalone-control.ts`), which persists it into the
 *     identity file and adopts it in-process HOT — no restart required.
 *
 * This module therefore does exactly these things, and nothing else:
 *   - read the two reserved env vars, fresh, every time (env is the operator
 *     override and always wins);
 *   - fall back to a live-adopted / identity-file-persisted value when the env
 *     vars are absent (the standalone hot-adoption path);
 *   - derive a coarse state from the last outcome of actually using them;
 *   - let the transport that uses them report what happened, without ever
 *     handing the token itself to anything but the transport's own headers.
 *
 * No function here returns, logs, or throws the credential value beyond the
 * opaque pair `readAgentBotCredential` returns for the transport to place
 * directly into request headers.
 */

/** The reserved manifest env keys Hub uses to deliver this credential. */
export const AGENT_BOT_CREDENTIAL_ENV_KEY = 'PRIVOS_AGENT_BOT_CREDENTIAL';
export const AGENT_BOT_USER_ID_ENV_KEY = 'PRIVOS_AGENT_BOT_USER_ID';

/**
 * Derived credential state — never owned, always recomputed:
 *   - `absent`: neither the env pair nor an adopted value is available. Normal
 *     for a fresh install; the credential arrives later and out-of-band.
 *   - `live`: a credential is available and the most recent call using it (if
 *     any) did not come back 401. Optimistic default before any call.
 *   - `rejected`: the most recent call using this exact credential came back
 *     401. Every re-issue rotates the previous token dead, and revocation has
 *     more causes than loss (grant change, suspension, upgrade cutover,
 *     uninstall) — this app cannot distinguish them and cannot fix any of them.
 *     Only a newly delivered credential (env restart, or a fresh control-channel
 *     push) can return to `live`.
 */
export type AgentBotCredentialState = 'absent' | 'live' | 'rejected';

/** Opaque header pair. Never stringify, log, or embed this outside a request header. */
export interface AgentBotCredential {
	readonly botUserId: string;
	readonly token: string;
}

/** Operator-facing instruction shown while the app cannot use its own credential. */
export const AGENT_BOT_CREDENTIAL_OPERATOR_INSTRUCTION =
	'A workspace admin must issue or re-issue this app’s credential from Hub → Admin → Apps '
	+ '→ this app → Settings, then press Apply. This app cannot issue or repair its own credential.';

// Last observed outcome of actually using the credential. `null` means no
// call has been made yet in this process, which reads as `live` (optimistic)
// per the state machine above.
let lastOutcome: 'live' | 'rejected' | null = null;

// A credential adopted at boot (seeded from the persisted identity file) or
// hot over the standalone control channel. Env always wins over this; it is the
// fallback that makes standalone delivery without a restart observable at all.
let adopted: AgentBotCredential | null = null;

function normalize(botUserId: string, token: string): AgentBotCredential | null {
	if (!token.trim() || !botUserId.trim()) return null;
	return Object.freeze({ botUserId: botUserId.trim(), token });
}

/**
 * Adopt a credential delivered out-of-band (standalone control channel, or a
 * boot-time seed from the persisted identity file). Env always overrides this,
 * so adopting never masks an operator-set env value. A fresh adoption clears the
 * last outcome so a previously-rejected token does not keep the state `rejected`.
 */
export function setAdoptedAgentBotCredential(credential: AgentBotCredential): void {
	const next = normalize(credential.botUserId, credential.token);
	if (!next) return;
	adopted = next;
	lastOutcome = null;
}

/**
 * Read the credential: the env pair first (operator override), then any
 * adopted / persisted value. `null` when neither is available.
 */
export function readAgentBotCredential(): AgentBotCredential | null {
	const token = process.env[AGENT_BOT_CREDENTIAL_ENV_KEY];
	const botUserId = process.env[AGENT_BOT_USER_ID_ENV_KEY];
	if (token && botUserId) {
		const fromEnv = normalize(botUserId, token);
		if (fromEnv) return fromEnv;
	}
	return adopted;
}

/** Current derived state. Safe to expose to a UI: never carries the token. */
export function getAgentBotCredentialState(): AgentBotCredentialState {
	if (!readAgentBotCredential()) return 'absent';
	return lastOutcome === 'rejected' ? 'rejected' : 'live';
}

/** Record that the credential was just used successfully. */
export function markAgentBotCredentialLive(): void {
	lastOutcome = 'live';
}

/** Record that Hub just rejected this exact credential with 401. */
export function markAgentBotCredentialRejected(): void {
	lastOutcome = 'rejected';
}

/** Test-only: reset all in-process state so cases do not leak into each other. */
export function resetAgentBotCredentialOutcomeForTests(): void {
	lastOutcome = null;
	adopted = null;
}
