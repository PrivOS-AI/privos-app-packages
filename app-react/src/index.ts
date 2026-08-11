/**
 * @privos_ai/app-react — thin React wrappers for Privos MCP app development.
 * Wraps the standard @modelcontextprotocol/ext-apps SDK with Privos convenience hooks.
 */
export { PrivosAppProvider, PrivosAppContext } from './PrivosAppProvider';
export type {
	McpApp,
	RestRequestParams,
	RestResponse,
	UploadFileParams,
	PrivosHostContext,
	ProviderEmbedRect,
	ProviderEmbedDecision,
	ProviderEmbedDenialReason,
} from './PrivosAppProvider';
export { usePrivosApp } from './use-privos-app';
export { usePrivosContext } from './use-privos-context';
export type { PrivosContext } from './use-privos-context';
export { usePrivosCapability } from './use-privos-capability';
export type { PrivosCapabilityState } from './use-privos-capability';
export { usePrivosTool } from './use-privos-tool';
export { useLists } from './hooks/use-lists';
export { useFiles } from './hooks/use-files';
export { useRoom } from './hooks/use-room';
export { useAppChatSurface } from './hooks/use-app-chat-surface';
export type { UseAppChatSurfaceOptions, UseAppChatSurfaceResult } from './hooks/use-app-chat-surface';
export { useProviderEmbed } from './hooks/use-provider-embed';
export type { ProviderEmbedState, UseProviderEmbedResult } from './hooks/use-provider-embed';

export { parseToolResult } from './parse-tool-result';
