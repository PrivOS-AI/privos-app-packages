/**
 * Scaffolds a new Privos MCP app project from the default template.
 * Copies template files, replaces placeholders with app name.
 */
import * as fs from 'fs';
import * as path from 'path';

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates', 'default');
const APP_SERVER_PACKAGE_NAME = '@privos_ai/app-server';
const SKILL_NAME = 'privos-app-publish';

/** Recursively copy directory, replacing {{APP_NAME}} and {{APP_ID}} placeholders */
function copyDir(src: string, dest: string, appName: string): void {
	fs.mkdirSync(dest, { recursive: true });

	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);

		if (entry.isDirectory()) {
			copyDir(srcPath, destPath, appName);
		} else {
			let content = fs.readFileSync(srcPath, 'utf-8');
			content = content.replace(/\{\{APP_NAME\}\}/g, appName);
			content = content.replace(/\{\{APP_ID\}\}/g, `com.privos.${appName}`);
			fs.writeFileSync(destPath, content);
		}
	}
}

/**
 * Finds the installed `@privos_ai/app-server` package root directory.
 * `@privos_ai/app-server` is ESM-only (`"type": "module"`, `exports["."]`
 * has no `require` condition) while this package is CommonJS, so
 * `require.resolve('@privos_ai/app-server')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`
 * — resolving the main entry is not an option. `require.resolve.paths` only
 * enumerates the `node_modules` directories Node would search for the bare
 * specifier (it does not touch `exports`), so checking each for a
 * `@privos_ai/app-server/package.json` finds the installed package root
 * without loading any of its code.
 */
function resolveAppServerPackageRoot(): string {
	const candidateDirs = require.resolve.paths(APP_SERVER_PACKAGE_NAME) ?? [];
	for (const dir of candidateDirs) {
		const packageDir = path.join(dir, APP_SERVER_PACKAGE_NAME);
		if (fs.existsSync(path.join(packageDir, 'package.json'))) {
			return packageDir;
		}
	}
	throw new Error(
		`Could not resolve "${APP_SERVER_PACKAGE_NAME}" — it must be installed as a dependency of create-privos-mcp-app to copy its Claude skill.`,
	);
}

/**
 * Copies the `privos-app-publish` Claude skill from the installed
 * `@privos_ai/app-server` package into the generated app's
 * `.claude/skills/privos-app-publish/`. Reads from the installed package
 * rather than vendoring a second copy in this repo, so the skill content
 * has exactly one source of truth (`app-server/skill/`).
 */
function copyAppServerSkill(targetDir: string): void {
	const packageRoot = resolveAppServerPackageRoot();
	const skillSourceDir = path.join(packageRoot, 'skill');
	const skillSourceFile = path.join(skillSourceDir, 'SKILL.md');
	if (!fs.existsSync(skillSourceFile)) {
		throw new Error(`"${APP_SERVER_PACKAGE_NAME}" is missing skill/SKILL.md at ${skillSourceDir}.`);
	}

	const skillDestDir = path.join(targetDir, '.claude', 'skills', SKILL_NAME);
	fs.mkdirSync(skillDestDir, { recursive: true });
	fs.copyFileSync(skillSourceFile, path.join(skillDestDir, 'SKILL.md'));

	const referencesSourceDir = path.join(skillSourceDir, 'references');
	if (fs.existsSync(referencesSourceDir)) {
		const referencesDestDir = path.join(skillDestDir, 'references');
		fs.mkdirSync(referencesDestDir, { recursive: true });
		for (const entry of fs.readdirSync(referencesSourceDir, { withFileTypes: true })) {
			if (entry.isFile()) {
				fs.copyFileSync(path.join(referencesSourceDir, entry.name), path.join(referencesDestDir, entry.name));
			}
		}
	}
}

export async function scaffoldApp(appName: string): Promise<void> {
	if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(appName)) {
		throw new Error('App name must be 2-63 lowercase letters, numbers or hyphens, starting with a letter or number');
	}
	const targetDir = path.resolve(process.cwd(), appName);

	if (fs.existsSync(targetDir)) {
		throw new Error(`Directory "${appName}" already exists`);
	}

	copyDir(TEMPLATE_DIR, targetDir, appName);
	copyAppServerSkill(targetDir);
}
