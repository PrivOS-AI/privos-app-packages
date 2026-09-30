#!/usr/bin/env node
/**
 * CLI entry point for create-privos-mcp-app.
 * Usage: npx create-privos-mcp-app my-app [--template <default|instant>] [--id <app-id>]
 */
import { parseScaffoldArgs } from './cli-args';
import { describeScaffold, nodeVersionWarning, scaffoldApp, SCAFFOLD_TEMPLATES } from './scaffolder';

const { appName, template, id } = parseScaffoldArgs(process.argv.slice(2));
if (!appName) {
	console.error(
		`Usage: npx create-privos-mcp-app <app-name> [--template <${SCAFFOLD_TEMPLATES.join('|')}>] [--id <app-id>]`,
	);
	process.exit(1);
}

const nodeWarning = nodeVersionWarning(process.version);
if (nodeWarning) console.warn(`Warning: ${nodeWarning}`);

scaffoldApp(appName, { template, id })
	.then((result) => {
		const { warnings, steps } = describeScaffold(result);
		console.log(`\nDone! Created ${appName}/ (app id ${result.appId})`);
		for (const warning of warnings) console.warn(`\nWarning: ${warning}`);
		console.log('\nNext steps:');
		for (const step of steps) console.log(`  ${step}`);
		console.log('');
	})
	.catch((err) => {
		console.error('Error:', err.message);
		process.exit(1);
	});
