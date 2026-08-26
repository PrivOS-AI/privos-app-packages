#!/usr/bin/env node
// Compatibility alias for `privos-app lint`: kept as its own bin entry
// (`privos-app-lint`) with byte-identical output and exit code, delegating
// to the same implementation so the two can never drift.
import { runLint } from './cli/commands/lint.js';

process.exit(runLint(process.argv.slice(2)));
