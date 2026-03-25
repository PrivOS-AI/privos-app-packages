#!/usr/bin/env node
/**
 * CLI entry point for create-privos-mcp-app.
 * Usage: npx create-privos-mcp-app my-app
 */
import { scaffoldApp } from './scaffolder';

const appName = process.argv[2];
if (!appName) {
	console.error('Usage: npx create-privos-mcp-app <app-name>');
	process.exit(1);
}

scaffoldApp(appName)
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
