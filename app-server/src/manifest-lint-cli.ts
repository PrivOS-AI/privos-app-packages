#!/usr/bin/env node
// Compatibility alias for `privos-app lint`: kept as its own bin entry
// (`privos-app-lint`) with byte-identical output and exit code, delegating
// to the same implementation so the two can never drift. That includes the
// Phase 11 executionMode: "INSTANT" rule set — `runLint` (cli/commands/lint.ts)
// dispatches to `lintInstantManifest` (manifest-lint-instant.ts), so both this
// alias and the `privos-app lint` subcommand pick it up identically.
import { runLint } from './cli/commands/lint.js';

process.exit(runLint(process.argv.slice(2)));
