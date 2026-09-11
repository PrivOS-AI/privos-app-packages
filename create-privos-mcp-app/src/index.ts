#!/usr/bin/env node
/**
 * CLI entry point for create-privos-mcp-app.
 * Usage: npx create-privos-mcp-app my-app [--template <default|instant>]
 */
import { parseScaffoldArgs } from './cli-args';
import { scaffoldApp, SCAFFOLD_TEMPLATES } from './scaffolder';

const { appName, template } = parseScaffoldArgs(process.argv.slice(2));
if (!appName) {
	console.error(`Usage: npx create-privos-mcp-app <app-name> [--template <${SCAFFOLD_TEMPLATES.join('|')}>]`);
	process.exit(1);
}

scaffoldApp(appName, { template })
	.then(() => {
		console.log(`\nDone! Created ${appName}/`);
		console.log(`\n  cd ${appName}`);
		console.log('  npm install');
		console.log('  npm run dev\n');
	})
	.catch((err) => {
		console.error('Error:', err.message);
		process.exit(1);
	});
