/**
 * Pure argv parsing for the `create-privos-mcp-app` CLI, split out of
 * `index.ts` (which runs its scaffold on import) so it can be unit-tested
 * without spawning a process or triggering a filesystem side effect.
 */
export type ParsedScaffoldArgs = { appName?: string; template?: string };

/**
 * Pulls `--template <name>` / `--template=<name>` out of the raw argv,
 * leaving the remaining positional args untouched.
 */
export function parseScaffoldArgs(argv: readonly string[]): ParsedScaffoldArgs {
	const rest = [...argv];
	let template: string | undefined;
	const eqIndex = rest.findIndex((arg) => arg.startsWith('--template='));
	if (eqIndex !== -1) {
		template = rest[eqIndex]!.slice('--template='.length);
		rest.splice(eqIndex, 1);
	} else {
		const flagIndex = rest.indexOf('--template');
		if (flagIndex !== -1) {
			// No value after a trailing `--template` is a deliberate empty
			// string, not "unset" — it must fail the unknown-template check
			// downstream rather than silently falling back to the default
			// template.
			const hasValue = flagIndex + 1 < rest.length;
			template = hasValue ? rest[flagIndex + 1] : '';
			rest.splice(flagIndex, hasValue ? 2 : 1);
		}
	}
	return { appName: rest[0], template };
}
