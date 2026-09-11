import fs from 'node:fs';
import path from 'node:path';

/**
 * Lint rules for `executionMode: "INSTANT"` manifests — frontend-only PrivOS
 * apps with no runtime (Phase 11: "Instant MCP Apps"). Every check here is
 * enforced only when the manifest declares `executionMode: "INSTANT"`; any
 * other manifest is untouched by this module.
 *
 * The optional `agent` section caps mirror the size caps privos-hub's
 * `sanitizeAgentData` enforces server-side
 * (`server/services/agent-export-import/sanitize-agent-data.ts`), which
 * *truncates* silently. Here a cap breach is a publish-time lint error naming
 * the field instead — a publisher should never discover a truncated persona
 * only after install. The two repos do not share a package, so the numbers
 * below are kept in sync by hand.
 */

export const INSTANT_EXECUTION_MODE = 'INSTANT' as const;

/** The three room surfaces the Hub models a UI-only entry point for. */
export const INSTANT_UI_ENTRY_POINT_SLOTS = ['roomTab', 'sidebar', 'standalone'] as const;
export type InstantUiEntryPointSlot = (typeof INSTANT_UI_ENTRY_POINT_SLOTS)[number];

export type InstantUiEntryPoint = Readonly<{
	title: string;
	/** `ui://<appId>/<file>.html` — `<appId>` must equal the manifest's `name`. */
	resourceUri: string;
}>;

export type InstantManifestUi = Readonly<{
	entryPoints: Readonly<Partial<Record<InstantUiEntryPointSlot, InstantUiEntryPoint>>>;
}>;

export type InstantManifestAgent = Readonly<{
	purpose: string;
	instructions?: string;
	personality?: string;
	knowledge?: readonly string[];
	/**
	 * Bounded at install time by the Hub against the workspace's bot
	 * permission catalog (`buildBotKeyCatalogPatterns`) minus
	 * `BOT_BEARER_DENIED_V1_PREFIXES` — a manifest can only narrow. Not part
	 * of `sanitizeAgentData`'s fixed field set, so no length cap applies here.
	 */
	hubTools?: readonly string[];
}>;

export type InstantManifestLintResult = Readonly<{
	errors: readonly string[];
	warnings: readonly string[];
}>;

/**
 * Fields a runtime app may declare that an INSTANT app never may — there is
 * no container, no relay, no OCI image, so nothing configures one.
 */
const FORBIDDEN_INSTANT_FIELDS = [
	'tools',
	'serverUrl',
	'runtimeTrustProvisioningUrl',
	'port',
	'resources',
	'volumes',
	'stateless',
] as const;

// Kept identical to privos-hub's sanitizeAgentData caps by hand (see module
// doc comment above) — a lint pass here must reject exactly what the Hub
// would otherwise truncate silently.
const AGENT_PURPOSE_MAX_LEN = 2000;
const AGENT_PERSONALITY_MAX_LEN = 2000;
const AGENT_INSTRUCTIONS_MAX_LEN = 5000;
const AGENT_KNOWLEDGE_MAX_ITEMS = 20;
const AGENT_KNOWLEDGE_ITEM_MAX_LEN = 500;

const ENTRY_POINT_RESOURCE_URI_RE = /^ui:\/\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*\.html)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectForbiddenFieldErrors(manifest: Record<string, unknown>): string[] {
	return FORBIDDEN_INSTANT_FIELDS
		.filter((field) => manifest[field] !== undefined)
		.map((field) => `${field} is forbidden for executionMode: "INSTANT" (frontend-only apps have no runtime to configure)`);
}

function collectUiEntryPointErrors(manifest: Record<string, unknown>): string[] {
	const errors: string[] = [];
	const ui = manifest.ui;
	const entryPointsRaw = isRecord(ui) ? ui.entryPoints : undefined;
	if (!isRecord(entryPointsRaw)) {
		errors.push('ui.entryPoints is required for executionMode: "INSTANT"');
		return errors;
	}
	const entryPoints = entryPointsRaw;
	if (entryPoints.roomTab === undefined) {
		errors.push('ui.entryPoints.roomTab is required for executionMode: "INSTANT"');
	}
	const appId = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name : undefined;
	for (const [slot, rawSlot] of Object.entries(entryPoints)) {
		if (!(INSTANT_UI_ENTRY_POINT_SLOTS as readonly string[]).includes(slot)) {
			errors.push(`ui.entryPoints.${slot} is not a supported slot (expected one of ${INSTANT_UI_ENTRY_POINT_SLOTS.join(', ')})`);
			continue;
		}
		if (!isRecord(rawSlot)) {
			errors.push(`ui.entryPoints.${slot} must be an object`);
			continue;
		}
		if (typeof rawSlot.title !== 'string' || !rawSlot.title.trim()) {
			errors.push(`ui.entryPoints.${slot}.title must be a non-empty string`);
		}
		const resourceUri = rawSlot.resourceUri;
		const match = typeof resourceUri === 'string' ? ENTRY_POINT_RESOURCE_URI_RE.exec(resourceUri) : null;
		if (!match) {
			errors.push(`ui.entryPoints.${slot}.resourceUri must match "ui://<appId>/<file>.html"`);
		} else if (appId && match[1] !== appId) {
			errors.push(`ui.entryPoints.${slot}.resourceUri must be namespaced under this manifest's "name" (expected host "${appId}")`);
		}
	}
	return errors;
}

function collectAgentSectionErrors(manifest: Record<string, unknown>): string[] {
	const agent = manifest.agent;
	if (agent === undefined) return [];
	if (!isRecord(agent)) return ['agent must be an object'];

	const errors: string[] = [];
	const purpose = agent.purpose;
	if (typeof purpose !== 'string' || !purpose.trim()) {
		errors.push('agent.purpose must be a non-empty string');
	} else if (purpose.length > AGENT_PURPOSE_MAX_LEN) {
		errors.push(`agent.purpose exceeds the maximum length of ${AGENT_PURPOSE_MAX_LEN} characters`);
	}

	const instructions = agent.instructions;
	if (instructions !== undefined) {
		if (typeof instructions !== 'string') errors.push('agent.instructions must be a string');
		else if (instructions.length > AGENT_INSTRUCTIONS_MAX_LEN) {
			errors.push(`agent.instructions exceeds the maximum length of ${AGENT_INSTRUCTIONS_MAX_LEN} characters`);
		}
	}

	const personality = agent.personality;
	if (personality !== undefined) {
		if (typeof personality !== 'string') errors.push('agent.personality must be a string');
		else if (personality.length > AGENT_PERSONALITY_MAX_LEN) {
			errors.push(`agent.personality exceeds the maximum length of ${AGENT_PERSONALITY_MAX_LEN} characters`);
		}
	}

	const knowledge = agent.knowledge;
	if (knowledge !== undefined) {
		if (!Array.isArray(knowledge) || knowledge.some((item) => typeof item !== 'string')) {
			errors.push('agent.knowledge must be an array of strings');
		} else {
			if (knowledge.length > AGENT_KNOWLEDGE_MAX_ITEMS) {
				errors.push(`agent.knowledge exceeds the maximum of ${AGENT_KNOWLEDGE_MAX_ITEMS} items`);
			}
			knowledge.forEach((item: string, index: number) => {
				if (item.length > AGENT_KNOWLEDGE_ITEM_MAX_LEN) {
					errors.push(`agent.knowledge[${index}] exceeds the maximum length of ${AGENT_KNOWLEDGE_ITEM_MAX_LEN} characters`);
				}
			});
		}
	}

	const hubTools = agent.hubTools;
	if (hubTools !== undefined) {
		if (!Array.isArray(hubTools) || hubTools.some((item) => typeof item !== 'string' || !item.trim())) {
			errors.push('agent.hubTools must be an array of non-empty strings');
		}
	}

	return errors;
}

function collectDockerfileWarning(manifestDir: string | undefined): string[] {
	if (!manifestDir) return [];
	try {
		if (fs.existsSync(path.join(manifestDir, 'Dockerfile'))) {
			return ['Dockerfile is present alongside executionMode: "INSTANT" — it is ignored (no image is ever built for a frontend-only app)'];
		}
	} catch {
		// Best-effort only; an unreadable directory must not fail the lint.
	}
	return [];
}

/**
 * Lints the INSTANT-only rules on top of `lintManifest`'s base checks. A
 * no-op (empty errors/warnings) for any manifest that does not declare
 * `executionMode: "INSTANT"`. `options.manifestDir` — the directory holding
 * `privos-app.json` — enables the Dockerfile-presence warning; omit it to
 * skip that check (e.g. when linting an in-memory manifest with no project
 * directory on disk).
 */
export function lintInstantManifest(manifest: unknown, options: { manifestDir?: string } = {}): InstantManifestLintResult {
	const value = isRecord(manifest) ? manifest : {};
	if (value.executionMode !== INSTANT_EXECUTION_MODE) {
		return Object.freeze({ errors: Object.freeze([]), warnings: Object.freeze([]) });
	}
	const errors = [
		...collectForbiddenFieldErrors(value),
		...collectUiEntryPointErrors(value),
		...collectAgentSectionErrors(value),
	];
	const warnings = collectDockerfileWarning(options.manifestDir);
	return Object.freeze({ errors: Object.freeze(errors), warnings: Object.freeze(warnings) });
}
