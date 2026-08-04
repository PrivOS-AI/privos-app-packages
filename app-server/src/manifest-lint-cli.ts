#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { lintManifest } from './manifest-tools.js';

const manifestPath = path.resolve(process.argv[2] || 'privos-app.json');
let manifest: unknown;
try {
	manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch {
	console.error(JSON.stringify({ valid: false, errors: [`Unable to read valid JSON from ${manifestPath}`] }, null, 2));
	process.exit(1);
}

const result = lintManifest(manifest);
console.log(JSON.stringify({ manifestPath, ...result }, null, 2));
if (!result.valid) process.exit(1);
