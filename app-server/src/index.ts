export { MCP_PROTOCOL_VERSION, MCP_UI_MIME } from './app-descriptor.js';
export type {
	AppDescriptor,
	AppPermissionDescriptor,
	AppPermissionRequirement,
	AppPermissionContext,
	AppPermissionExecutionContext,
} from './app-descriptor.js';
export {
	buildInitializeResult,
	buildManifestJson,
	buildPairingMetadata,
	validateDescriptorCapabilities,
	validateDescriptorPermissions,
} from './app-descriptor.js';

export type {
	VerifiedActor,
	IdentityState,
	ToolCallContext,
} from './context/tool-call-context.js';
export type { IdentityEnforcementMode } from './context/identity-mode.js';
export { parseIdentityEnforcementMode } from './context/identity-mode.js';
export {
	IdentityAssertionError,
	assertActorAvailable,
	assertActorMatchesLegacyId,
} from './context/identity-assertions.js';

export type {
	AuthOptions,
	CallerCredential,
	VerifyUserTokenResult,
} from './auth/user-token.js';
export {
	verifyUserToken,
	verifyPrivosUser,
	clearJwksCache,
} from './auth/user-token.js';

export type {
	JsonRpcId,
	JsonRpcErrorObject,
	McpRequest,
	McpNotification,
	McpResponse,
	ApplicationMcpRequest,
	ApplicationMcpMethod,
} from './protocol/types.js';
export {
	PARSE_ERROR,
	INVALID_REQUEST,
	METHOD_NOT_FOUND,
	INVALID_PARAMS,
	INTERNAL_ERROR,
	SERVER_BUSY,
	jsonRpcError,
	normalizeThrownError,
} from './protocol/errors.js';
export {
	parseJsonRpcMessage,
	parseJsonText,
	isMcpNotificationMethod,
} from './protocol/dispatch.js';

export type {
	AppMcpHandler,
	AppErrorMapper,
	CallerCredentialExtractor,
	CallerCredentialResolution,
	UiResourceProvider,
	RuntimeLimits,
	AppServerRuntimeOptions,
	DispatchOutcome,
	RelayCallerAuthSurface,
} from './runtime.js';
export {
	AppServerRuntime,
	DEFAULT_MAX_MESSAGE_BYTES,
	DEFAULT_MAX_BUFFERED_BYTES,
	encodeInFlightId,
	extractDirectCallerCredential,
	relayCallerAuthSurface,
	resolveCallerCredential,
	ephemeralSessionScope,
} from './runtime.js';

export { createDirectRouter } from './direct/express-router.js';
export type { DirectRouterOptions } from './direct/express-router.js';
export {
	createHttpIngressApp,
	startHttpIngress,
	resolveHttpIngressListen,
} from './direct/http-ingress.js';
export type {
	HttpIngressAppOptions,
	HttpIngressListenOptions,
	HttpIngressHandle,
	ReadinessCheckResult,
	ResolveHttpIngressListenOptions,
} from './direct/http-ingress.js';

export {
	pairOverWebSocket,
	pairFromDescriptor,
	connectRelay,
} from './relay/relay-client.js';
export type {
	PairAppMeta,
	PairingResult,
	RelayClientOptions,
	RelayHandle,
} from './relay/relay-client.js';
export { rawDataToText, MessageTooLargeError } from './relay/message-adapter.js';

export {
	DEFAULT_WORKLOAD_SOCKET,
	WorkloadIdentityClient,
	WorkloadIdentityError,
	WorkloadPermissionDeniedError,
	getWorkloadIdentityClient,
} from './workload/workload-identity.js';
export type {
	EffectiveCapabilities,
	WorkloadBinding,
	WorkloadBrokerContext,
	WorkloadBrokerResponse,
	WorkloadFetchInit,
	WorkloadIdentityClientOptions,
	WorkloadIdentityErrorCode,
} from './workload/workload-identity.js';
export { verifyDispatchAssertion } from './workload/dispatch-assertion.js';
export type { VerifiedDispatchActor, VerifiedDispatchAssertion } from './workload/dispatch-assertion.js';

export {
	canonicalJson,
	canonicalJsonValue,
	lintManifestV2,
	sha256CanonicalJson,
} from './manifest-tools.js';
export type { ManifestLintResult } from './manifest-tools.js';
