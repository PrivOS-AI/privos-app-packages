#!/usr/bin/env node
import { runLint } from './commands/lint.js';
import { runPublish } from './commands/publish.js';

function printUsage(): void {
	console.log(`Usage: privos-app <command> [options]

Commands:
  lint [manifestPath]   Validate privos-app.json structure (default: ./privos-app.json)
  publish [options]     Package, authorize, upload and submit the app to the Marketplace

Run "privos-app publish --help" for publish options.`);
}

async function main(): Promise<number> {
	const [subcommand, ...rest] = process.argv.slice(2);
	switch (subcommand) {
		case 'lint':
			return runLint(rest);
		case 'publish':
			return runPublish(rest);
		case '-h':
		case '--help':
			printUsage();
			return 0;
		case undefined:
			printUsage();
			return 5;
		default:
			console.error(`Unknown command "${subcommand}". Usage: privos-app <lint|publish> [options]`);
			return 5;
	}
}

main().then(
	(exitCode) => process.exit(exitCode),
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(4);
	},
);
