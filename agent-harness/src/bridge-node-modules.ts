import { createRequire } from 'node:module';
import { sep } from 'node:path';

/**
 * The node_modules dir that actually holds `@privos_ai/skill-sdk`. npm hoists it
 * next to the bridge (e.g. under npx), so `<bridge>/node_modules` may not exist.
 */
export function bridgeNodeModulesDir(): string {
	const resolved = createRequire(import.meta.url).resolve('@privos_ai/skill-sdk');
	return resolved.slice(0, resolved.lastIndexOf(`${sep}@privos_ai${sep}skill-sdk${sep}`));
}
