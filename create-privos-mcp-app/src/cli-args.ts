/**
 * Pure argv parsing for the `create-privos-mcp-app` CLI, split out of
 * `index.ts` (which runs its scaffold on import) so it can be unit-tested
 * without spawning a process or triggering a filesystem side effect.
 */
export type ParsedScaffoldArgs = { appName?: string; template?: string; id?: string };

/**
 * Removes `--<name> <value>` / `--<name>=<value>` from `rest` and returns the
 * value. A trailing flag with no value yields a deliberate empty string, not
 * "unset" — it must fail validation downstream rather than silently falling
 * back to a default.
 */
function takeFlag(rest: string[], name: string): string | undefined {
	const eqIndex = rest.findIndex((arg) => arg.startsWith(`--${name}=`));
	if (eqIndex !== -1) {
		const value = rest[eqIndex]!.slice(`--${name}=`.length);
		rest.splice(eqIndex, 1);
		return value;
	}
	const flagIndex = rest.indexOf(`--${name}`);
	if (flagIndex === -1) return undefined;
	const hasValue = flagIndex + 1 < rest.length;
	const value = hasValue ? rest[flagIndex + 1] : '';
	rest.splice(flagIndex, hasValue ? 2 : 1);
	return value;
}

/**
 * Pulls `--template <name>` and `--id <app-id>` (or their `=value` forms) out
 * of the raw argv, leaving the remaining positional args untouched.
 */
export function parseScaffoldArgs(argv: readonly string[]): ParsedScaffoldArgs {
	const rest = [...argv];
	const template = takeFlag(rest, 'template');
	const id = takeFlag(rest, 'id');
	return { appName: rest[0], template, id };
}
