export const MCP_PROTOCOL_VERSION = '2025-03-26';

export const MCP_UI_MIME = 'text/html;profile=mcp-app';

export type AppPermissionRequirement = 'required' | 'optional';
export type AppPermissionContext = 'workspace' | 'room';
export type AppPermissionExecutionContext = 'user' | 'background' | 'both';

export interface AppPermissionDescriptor {
	scope: string;
	requirement: AppPermissionRequirement;
	context: AppPermissionContext;
	executionContext: AppPermissionExecutionContext;
	feature: string;
	reason: string;
	recommended?: boolean;
	degradedBehavior?: string;
}

export interface AppDescriptor {
	id: string;
	name: string;
	version: string;
	title?: string;
	description?: string;
	homepage?: string;
	author?: { name: string; email?: string; website?: string };
	scopes?: readonly string[];
	/** Manifest v2 permission contract. Do not combine with legacy scopes. */
	permissions?: readonly AppPermissionDescriptor[];
	/** Direct manifest icon path/URL (e.g. `/public/icon.svg`). */
	manifestIcon?: string;
	/** Pairing / initialize icon (often a data URI for relay). */
	relayIcon?: string;
	/** Extra capabilities merged under runtime-owned defaults; may not override reserved keys. */
	capabilities?: Record<string, unknown>;
	/**
	 * Exact published manifest (schema v3). When present it is echoed verbatim as
	 * `serverInfo.manifest` on `initialize`, so a Hub can re-read the app's current
	 * permission contract (and re-pin its digest after admin approval) without a
	 * re-pair. Standalone-production `serveApp` fills this from `resolveManifest`.
	 */
	manifest?: Record<string, unknown>;
	/**
	 * Set instead of `manifest` when the SDK's own attempt to resolve the
	 * published manifest failed (e.g. `connectRelay`'s default `privos-app.json`
	 * read). Echoed verbatim as `serverInfo.manifestError` on `initialize` so a
	 * Hub can tell "old SDK, never echoes" apart from "this SDK tried and the
	 * file is missing/invalid" instead of guessing from a version number alone.
	 */
	manifestError?: string;
}

const RESERVED_CAPABILITY_KEYS = new Set(['tools', 'extensions']);

export function validateDescriptorCapabilities(
	capabilities: Record<string, unknown> | undefined,
): void {
	if (!capabilities) return;
	for (const key of Object.keys(capabilities)) {
		if (RESERVED_CAPABILITY_KEYS.has(key)) {
			throw new Error(
				`descriptor.capabilities must not override reserved capability "${key}"`,
			);
		}
	}
}

export function validateDescriptorPermissions(descriptor: Pick<AppDescriptor, 'scopes' | 'permissions'>): void {
	if (descriptor.scopes?.length && descriptor.permissions?.length) {
		throw new Error('descriptor must not combine legacy scopes with permissions v2');
	}
	if (!descriptor.permissions) return;
	if (descriptor.permissions.length === 0) throw new Error('descriptor.permissions must not be empty');
	const seen = new Set<string>();
	for (const permission of descriptor.permissions) {
		if (
			!permission ||
			!/^[-a-z0-9]+:[-a-z0-9:]+$/.test(permission.scope) ||
			!['required', 'optional'].includes(permission.requirement) ||
			!['workspace', 'room'].includes(permission.context) ||
			!['user', 'background', 'both'].includes(permission.executionContext) ||
			!/^[-a-z0-9.]+$/.test(permission.feature) ||
			permission.reason.trim().length < 3
		) {
			throw new Error(`invalid permission declaration: ${permission?.scope || 'unknown'}`);
		}
		if (seen.has(permission.scope)) throw new Error(`duplicate permission scope: ${permission.scope}`);
		if (permission.requirement === 'optional' && (!permission.degradedBehavior || permission.degradedBehavior.trim().length < 10)) {
			throw new Error(`optional permission must declare safe degraded behavior: ${permission.scope}`);
		}
		if (permission.requirement === 'required' && permission.degradedBehavior) {
			throw new Error(`required permission cannot declare degraded behavior: ${permission.scope}`);
		}
		seen.add(permission.scope);
	}
}

export function buildInitializeResult(
	descriptor: AppDescriptor,
	options?: { uiEnabled?: boolean },
): {
	protocolVersion: string;
	capabilities: Record<string, unknown>;
	serverInfo: Record<string, unknown>;
} {
	validateDescriptorCapabilities(descriptor.capabilities);
	validateDescriptorPermissions(descriptor);

	const capabilities: Record<string, unknown> = {
		tools: {},
		...(options?.uiEnabled
			? {
					extensions: {
						'io.modelcontextprotocol/ui': {
							mimeTypes: [MCP_UI_MIME],
						},
					},
				}
			: {}),
		...(descriptor.capabilities ?? {}),
	};

	const serverInfo: Record<string, unknown> = {
		name: descriptor.title || descriptor.name || descriptor.id,
		version: descriptor.version,
	};
	if (descriptor.relayIcon) serverInfo.icon = descriptor.relayIcon;
	if (descriptor.scopes?.length) serverInfo.scopes = [...descriptor.scopes];
	if (descriptor.permissions?.length) serverInfo.permissions = descriptor.permissions.map((permission) => ({ ...permission }));
	if (descriptor.manifest) serverInfo.manifest = structuredClone(descriptor.manifest);
	else if (descriptor.manifestError) serverInfo.manifestError = descriptor.manifestError;

	return {
		protocolVersion: MCP_PROTOCOL_VERSION,
		capabilities,
		serverInfo,
	};
}

export function buildManifestJson(descriptor: AppDescriptor): Record<string, unknown> {
	validateDescriptorCapabilities(descriptor.capabilities);
	validateDescriptorPermissions(descriptor);
	return {
		schemaVersion: descriptor.permissions ? 2 : 1,
		name: descriptor.id,
		version: descriptor.version,
		title: descriptor.title || descriptor.name,
		description: descriptor.description ?? '',
		...(descriptor.manifestIcon ? { icon: descriptor.manifestIcon } : {}),
		...(descriptor.author
			? {
					author: {
						name: descriptor.author.name,
						...(descriptor.author.email ? { email: descriptor.author.email } : {}),
						...(descriptor.author.website ? { website: descriptor.author.website } : {}),
					},
				}
			: {}),
		...(descriptor.homepage ? { homepage: descriptor.homepage } : {}),
		...(descriptor.scopes ? { scopes: [...descriptor.scopes] } : {}),
		...(descriptor.permissions ? { permissions: descriptor.permissions.map((permission) => ({ ...permission })) } : {}),
		...(descriptor.capabilities ? { capabilities: { ...descriptor.capabilities } } : {}),
	};
}

export function buildPairingMetadata(descriptor: AppDescriptor): {
	name: string;
	description: string;
	version: string;
	icon?: string;
	scopes?: string[];
	permissions?: AppPermissionDescriptor[];
} {
	validateDescriptorPermissions(descriptor);
	return {
		name: descriptor.title || descriptor.name || descriptor.id,
		description: descriptor.description ?? '',
		version: descriptor.version,
		...(descriptor.relayIcon ? { icon: descriptor.relayIcon } : {}),
		...(descriptor.scopes?.length ? { scopes: [...descriptor.scopes] } : {}),
		...(descriptor.permissions?.length ? { permissions: descriptor.permissions.map((permission) => ({ ...permission })) } : {}),
	};
}
