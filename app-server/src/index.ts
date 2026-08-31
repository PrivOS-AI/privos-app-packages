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
	VerifiedActorProvenance,
	IdentityState,
	ToolCallContext,
} from './context/tool-call-context.js';
export type { AppAccessMode, PlatformContext } from './context/platform-context.js';
export { getPlatformContext, publicUrlFor } from './context/platform-context.js';
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
	UiAssetContent,
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
	pairAndAwaitApproval,
	resumeStandalonePairing,
	pairFromDescriptor,
	connectRelay,
} from './relay/relay-client.js';
export type {
	PairAppMeta,
	PairingResult,
	LegacyPairingResult,
	PendingPairingResult,
	CompletedPairingResult,
	PairOverWebSocketOptions,
	ResumeStandalonePairingOptions,
	RelayClientOptions,
	RelayHandle,
} from './relay/relay-client.js';
export { rawDataToText, MessageTooLargeError } from './relay/message-adapter.js';
export {
	DEFAULT_HUB_USER_TOKEN_JWKS_PATH,
	buildHubUserTokenAuthOptions,
	extractRelayUserTokenCredential,
	validateHubUserTokenOrigin,
} from './relay/hub-user-token-actor.js';
export type { HubUserTokenAuthOptions } from './relay/hub-user-token-actor.js';

export {
	DEFAULT_STANDALONE_IDENTITY_FILE,
	DEFAULT_STANDALONE_PENDING_IDENTITY_FILE,
	StandaloneIdentityError,
	loadStandaloneIdentity,
	loadStandalonePendingIdentity,
	saveStandaloneIdentity,
	saveStandalonePendingIdentity,
	consumeStandalonePendingIdentity,
	rotateStandaloneIdentity,
	standaloneIdentityFileExists,
	standaloneHubFingerprint,
	assertStandaloneIdentityShape,
	assertStandalonePendingIdentityShape,
	resolveStandalonePendingIdentityFilePath,
} from './relay/standalone-identity.js';
export type {
	StandaloneIdentityV2,
	StandalonePendingIdentityV2,
	LoadedStandaloneIdentity,
	LoadedStandalonePendingIdentity,
	StandaloneIdentityErrorCode,
} from './relay/standalone-identity.js';
export {
	STANDALONE_SECRET_ROTATE_METHOD,
	STANDALONE_TRUST_ROTATE_METHOD,
	STANDALONE_CAPABILITIES_CHANGED_METHOD,
	STANDALONE_AGENT_BOT_CREDENTIAL_METHOD,
	StandaloneControlError,
	isStandaloneControlMethod,
	createStandaloneRelayIdentityController,
	loadStandaloneRelayIdentityController,
} from './relay/standalone-control.js';
export type {
	StandaloneEffectiveCapabilities,
	StandaloneRelayIdentityController,
	StandaloneRelayIdentityControllerOptions,
} from './relay/standalone-control.js';
export {
	checkManifestDigestDrift,
	createStandaloneReadinessCheck,
} from './relay/standalone-readiness.js';
export type {
	StandaloneReadinessCheckOptions,
	StandaloneReadinessReason,
	StandaloneReadinessResult,
} from './relay/standalone-readiness.js';

export {
	AGENT_BOT_CREDENTIAL_ENV_KEY,
	AGENT_BOT_USER_ID_ENV_KEY,
	AGENT_BOT_CREDENTIAL_OPERATOR_INSTRUCTION,
	readAgentBotCredential,
	getAgentBotCredentialState,
	setAdoptedAgentBotCredential,
	markAgentBotCredentialLive,
	markAgentBotCredentialRejected,
	resetAgentBotCredentialOutcomeForTests,
} from './relay/agent-bot-credential.js';
export type { AgentBotCredential, AgentBotCredentialState } from './relay/agent-bot-credential.js';
export {
	createAgentBotHubClient,
	createAgentBotHubClientFromWorkloadIdentity,
	createAgentBotHubClientFromHubOrigin,
	AgentBotCredentialAbsentError,
	AgentBotHubUnreachableError,
} from './relay/hub-rest-as-bot-client.js';
export type {
	RoomBoundHubClient,
	RoomBoundHubFetchInit,
	AgentBotHubClientOptions,
} from './relay/hub-rest-as-bot-client.js';

export { serveApp, DEFAULT_SERVE_APP_PORT } from './serve-app.js';
export type {
	ServeAppOptions,
	ServeAppHandle,
	ServeAppHandlerContext,
	ServeAppTransportOverride,
	ServeAppTestSeams,
} from './serve-app.js';

export { resolveRuntimeMode, RuntimeModeError } from './runtime-mode.js';
export type {
	RuntimeMode,
	RuntimeModeResolution,
	RuntimeModeErrorCode,
	ResolveRuntimeModeOptions,
} from './runtime-mode.js';

export {
	DEFAULT_WORKLOAD_SOCKET,
	WorkloadIdentityClient,
	WorkloadIdentityError,
	WorkloadPermissionDeniedError,
	RoomBoundWorkloadClient,
	getWorkloadIdentityClient,
} from './workload/workload-identity.js';
export type {
	EffectiveCapabilities,
	WorkloadBinding,
	WorkloadBrokerContext,
	WorkloadBrokerResponse,
	WorkloadFetchInit,
	RoomBoundWorkloadFetchInit,
	WorkloadIdentityClientOptions,
	WorkloadIdentityErrorCode,
} from './workload/workload-identity.js';
export {
	BoundedRuntimeDispatchReplayConsumerV3,
	assertRuntimeDispatchRelayAffinityV3,
	assertRuntimeDispatchTrustConfigurationV3,
	extractRuntimeDispatchRelayEnvelopeV3,
	isExactRuntimeReadinessRpcV3,
	isUnsignedRuntimeReadinessRpcV3,
	parseRuntimeDispatchTrustV3Json,
	sha256RuntimeDispatchBodyV3,
	verifyClusterDispatchAssertionV3,
	verifyDispatchAssertion,
	verifyRuntimeDispatchAssertionV3,
} from './workload/dispatch-assertion.js';
export type {
	RuntimeDispatchAffinityV3,
	RuntimeDispatchExecutionModeV3,
	RuntimeDispatchRelayAuthorizationV3,
	RuntimeDispatchRelayEnvelopeV3,
	RuntimeDispatchReplayConsumerV3,
	RuntimeDispatchReplayInputV3,
	RuntimeDispatchSecurityV3,
	RuntimeDispatchTrustHintV3,
	RuntimeDispatchTrustResolverV3,
	RuntimeDispatchTrustV3,
	VerifiedClusterDispatchAssertionV3,
	VerifiedDispatchActor,
	VerifiedDispatchAssertion,
	VerifiedRuntimeDispatchAssertionV3,
	VerifiedRuntimeAuthorizationV3,
} from './workload/dispatch-assertion.js';
export {
	createPinnedPortalJwksResolverV3,
	createPublisherRuntimeTrustProvisioningRouterV3,
	SingleProcessFilePublisherRuntimeTrustStoreV3,
} from './workload/publisher-runtime-trust.js';
export type {
	PublisherPortalJwksResolutionV3,
	PublisherPortalJwksResolverV3,
	PublisherRuntimeTrustActiveEvidenceV3,
	PublisherRuntimeTrustDurableStoreV3,
	PublisherRuntimeTrustEvidenceV3,
	PublisherRuntimeTrustOperationV3,
	PublisherRuntimeTrustPreparedEvidenceV3,
	PublisherRuntimeTrustProvisioningRequestV3,
	PublisherRuntimeTrustProvisioningRouterOptionsV3,
	PublisherRuntimeTrustStoreMutationV3,
} from './workload/publisher-runtime-trust.js';

export {
	canonicalJson,
	canonicalJsonValue,
	lintManifest,
	lintManifestV2,
	sha256CanonicalJson,
	SUPPORTED_MANIFEST_SCHEMA_VERSIONS,
} from './manifest-tools.js';
export type { ManifestLintResult } from './manifest-tools.js';

export { serveBuiltUi } from './ui/serve-built-ui.js';
export type { ServeBuiltUi, ServeBuiltUiOptions } from './ui/serve-built-ui.js';
export {
	MCP_UI_ASSET_FILENAME_RE,
	MCP_UI_ASSET_EXTENSIONS,
	deriveAssetUriPrefix,
} from './ui/asset-filename-rule.js';
export type { McpUiAssetExtension } from './ui/asset-filename-rule.js';
export type { AssetManifestEntry, AssetsManifest } from './ui/assets-manifest.js';
