import type { ToolCallContext, VerifiedActor } from '../context/tool-call-context.js';
import type { VerifiedRuntimeAuthorizationV3 } from './dispatch-assertion.js';

export type ManagedIngressRoomAuthority = Readonly<{
	sourceAuthorization: VerifiedRuntimeAuthorizationV3;
	sourceActor: VerifiedActor;
	workspaceId: string;
	deploymentId: string;
	generationId: string;
	generationNumber: number;
	runtimeInstallationId: string;
	mcpAppId: string;
	manifestDigest: string;
	resourceManifestHash: string;
	runtimeResourceInventoryHash: string;
	runtimeApprovalReceiptHash: string;
	runtimeAuthorizationEpoch: number;
	roomId: string;
	authorizationBindingId: string;
	bindingReceiptHash: string;
	bindingEpoch: number;
	bindingGrantHash?: string;
	bindingTokenVersion?: number;
}>;

const roomAuthorities = new WeakMap<object, WeakMap<ToolCallContext, ManagedIngressRoomAuthority>>();

/** Internal ingress seam; this module is not a public package export. */
export function registerManagedIngressRoomAuthority(
	owner: object,
	context: ToolCallContext,
	authorization: VerifiedRuntimeAuthorizationV3,
): void {
	if (
		authorization.authorizationContext !== 'room' ||
		typeof authorization.roomId !== 'string' ||
		typeof authorization.authorizationBindingId !== 'string' ||
		typeof authorization.bindingReceiptHash !== 'string' ||
		!Number.isSafeInteger(authorization.bindingEpoch) ||
		context.runtimeAuthorization !== authorization ||
		context.identityState !== 'verified' ||
		!context.actor ||
		context.roomId !== authorization.roomId ||
		context.actor.roomId !== authorization.roomId ||
		!Object.isFrozen(authorization) ||
		!Object.isFrozen(context.actor) ||
		!Object.isFrozen(context.actor.claims)
	) {
		throw new Error('managed_ingress_room_authority_invalid');
	}

	const authority: ManagedIngressRoomAuthority = Object.freeze({
		sourceAuthorization: authorization,
		sourceActor: context.actor,
		workspaceId: authorization.workspaceId,
		deploymentId: authorization.deploymentId,
		generationId: authorization.generationId,
		generationNumber: authorization.generationNumber,
		runtimeInstallationId: authorization.runtimeInstallationId,
		mcpAppId: authorization.mcpAppId,
		manifestDigest: authorization.manifestDigest,
		resourceManifestHash: authorization.resourceManifestHash,
		runtimeResourceInventoryHash: authorization.runtimeResourceInventoryHash,
		runtimeApprovalReceiptHash: authorization.runtimeApprovalReceiptHash,
		runtimeAuthorizationEpoch: authorization.runtimeAuthorizationEpoch,
		roomId: authorization.roomId!,
		authorizationBindingId: authorization.authorizationBindingId!,
		bindingReceiptHash: authorization.bindingReceiptHash!,
		bindingEpoch: authorization.bindingEpoch!,
		...('bindingGrantHash' in authorization ? { bindingGrantHash: authorization.bindingGrantHash } : {}),
		...('bindingTokenVersion' in authorization ? { bindingTokenVersion: authorization.bindingTokenVersion } : {}),
	});

	let owned = roomAuthorities.get(owner);
	if (!owned) {
		owned = new WeakMap();
		roomAuthorities.set(owner, owned);
	}
	Object.freeze(context);
	owned.set(context, authority);
}

export function managedIngressRoomAuthority(
	owner: object,
	context: ToolCallContext,
): ManagedIngressRoomAuthority | undefined {
	return roomAuthorities.get(owner)?.get(context);
}
