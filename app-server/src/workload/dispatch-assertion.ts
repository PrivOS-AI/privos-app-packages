import crypto from 'node:crypto';

import type { WorkloadBrokerContext } from './workload-identity.js';

const replay = new Map<string, number>();

export type VerifiedDispatchActor = Readonly<{
	subject: string;
	username?: string;
	roomId?: string;
}>;

export type VerifiedDispatchAssertion = Readonly<{
	jti: string;
	issuedAt: number;
	expiresAt: number;
	actor?: VerifiedDispatchActor;
}>;

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalize(child)]),
		);
	}
	return value;
}

function canonical(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

export function verifyDispatchAssertion(input: {
	compact: string;
	body: unknown;
	context: WorkloadBrokerContext;
	now?: number;
}): VerifiedDispatchAssertion {
	const parts = input.compact.split('.');
	if (parts.length !== 3) throw new Error('dispatch_assertion_invalid');
	const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
	const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
	if (header.alg !== 'ES256' || header.typ !== 'privos-hub-dispatch+jws' || header.kid !== input.context.hubKid) {
		throw new Error('dispatch_assertion_invalid');
	}
	const key = crypto.createPublicKey({ key: input.context.hubPublicJwk, format: 'jwk' });
	if (!crypto.verify(
		'sha256',
		Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
		{ key, dsaEncoding: 'ieee-p1363' },
		Buffer.from(parts[2]!, 'base64url'),
	)) throw new Error('dispatch_assertion_invalid');
	const now = input.now ?? Math.floor(Date.now() / 1000);
	if (
		payload.type !== 'hub-dispatch-assertion' ||
		payload.aud !== 'privos-mcp-app' ||
		payload.htm !== 'POST' ||
		payload.htu !== '/mcp' ||
		!Number.isInteger(payload.iat) ||
		!Number.isInteger(payload.exp) ||
		Number(payload.iat) > now + 5 ||
		Number(payload.exp) < now ||
		Number(payload.exp) - Number(payload.iat) > 30 ||
		payload.workspaceId !== input.context.binding.workspaceId ||
		payload.installationId !== input.context.binding.installationId ||
		payload.mcpAppId !== input.context.binding.mcpAppId ||
		payload.replicaId !== input.context.binding.replicaId ||
		payload.receiptHash !== input.context.binding.receiptHash ||
		payload.grantEpoch !== input.context.binding.grantEpoch ||
		payload.bodyDigest !== `sha256:${crypto.createHash('sha256').update(canonical(input.body)).digest('hex')}` ||
		typeof payload.jti !== 'string'
	) throw new Error('dispatch_assertion_binding_mismatch');
	let actor: VerifiedDispatchActor | undefined;
	if (payload.actor !== undefined) {
		const candidate = payload.actor as Record<string, unknown>;
		if (
			!candidate ||
			typeof candidate !== 'object' ||
			typeof candidate.subject !== 'string' ||
			candidate.subject.length === 0 ||
			(candidate.username !== undefined && typeof candidate.username !== 'string') ||
			(candidate.roomId !== undefined && typeof candidate.roomId !== 'string')
		) throw new Error('dispatch_assertion_actor_invalid');
		actor = Object.freeze({
			subject: candidate.subject,
			...(candidate.username ? { username: candidate.username } : {}),
			...(candidate.roomId ? { roomId: candidate.roomId } : {}),
		});
	}
	for (const [jti, exp] of replay) if (exp < now) replay.delete(jti);
	if (replay.has(payload.jti)) throw new Error('dispatch_assertion_replayed');
	replay.set(payload.jti, Number(payload.exp));
	return Object.freeze({
		jti: payload.jti,
		issuedAt: Number(payload.iat),
		expiresAt: Number(payload.exp),
		...(actor ? { actor } : {}),
	});
}
