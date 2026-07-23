/**
 * @privos/app-react — thin React wrappers for Privos MCP app development.
 * Wraps the standard @modelcontextprotocol/ext-apps SDK with Privos convenience hooks.
 */
export { PrivosAppProvider, PrivosAppContext } from './PrivosAppProvider';
export type { McpApp, RestRequestParams, RestResponse, UploadFileParams, PrivosHostContext } from './PrivosAppProvider';
export { usePrivosApp } from './use-privos-app';
export { usePrivosContext } from './use-privos-context';
export type { PrivosContext } from './use-privos-context';
export { usePrivosUserToken } from './use-privos-user-token';
export { usePrivosTool } from './use-privos-tool';
export { useLists } from './hooks/use-lists';
export { useFiles } from './hooks/use-files';
export { useRoom } from './hooks/use-room';

export {
	USER_TOKEN_REFRESH_SKEW_MS,
	USER_TOKEN_REFRESH_MIN_DELAY_MS,
	USER_TOKEN_REFRESH_FALLBACK_MS,
	USER_TOKEN_REFRESH_FAILED_BACKOFF_MS,
	readUserTokenExpMs,
	shouldRefreshUserTokenNow,
	msUntilUserTokenRefresh,
	isFresherUserToken,
	isIdentityTokenErrorMessage,
	toolResultLooksIdentityInvalid,
} from './user-token';
export type { UserTokenRefreshResult } from './user-token';

export { parseToolResult } from './parse-tool-result';

/** Advanced: shared exp-timer + visibility triggers for custom HOST context providers. */
export { useUserTokenRefreshEffects } from './use-user-token-refresh-effects';
export type { UseUserTokenRefreshEffectsOptions } from './use-user-token-refresh-effects';
