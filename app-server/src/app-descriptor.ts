export const MCP_PROTOCOL_VERSION = '2025-03-26';

export const MCP_UI_MIME = 'text/html;profile=mcp-app';

export interface AppDescriptor {
	id: string;
	name: string;
	version: string;
	title?: string;
	description?: string;
	homepage?: string;
	author?: { name: string; email?: string; website?: string };
	scopes?: readonly string[];
	/** Direct manifest icon path/URL (e.g. `/public/icon.svg`). */
	manifestIcon?: string;
	/** Pairing / initialize icon (often a data URI for relay). */
	relayIcon?: string;
	/** Extra capabilities merged under runtime-owned defaults; may not override reserved keys. */
	capabilities?: Record<string, unknown>;
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

export function buildInitializeResult(
	descriptor: AppDescriptor,
	options?: { uiEnabled?: boolean },
): {
	protocolVersion: string;
	capabilities: Record<string, unknown>;
	serverInfo: Record<string, unknown>;
} {
	validateDescriptorCapabilities(descriptor.capabilities);

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

	return {
		protocolVersion: MCP_PROTOCOL_VERSION,
		capabilities,
		serverInfo,
	};
}

export function buildManifestJson(descriptor: AppDescriptor): Record<string, unknown> {
	return {
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
	};
}

export function buildPairingMetadata(descriptor: AppDescriptor): {
	name: string;
	description: string;
	version: string;
	icon?: string;
	scopes?: string[];
} {
	return {
		name: descriptor.title || descriptor.name || descriptor.id,
		description: descriptor.description ?? '',
		version: descriptor.version,
		...(descriptor.relayIcon ? { icon: descriptor.relayIcon } : {}),
		...(descriptor.scopes?.length ? { scopes: [...descriptor.scopes] } : {}),
	};
}
