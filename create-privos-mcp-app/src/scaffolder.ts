/**
 * Scaffolds a new Privos MCP app project from a template.
 * Copies template files, replaces the app name and id placeholders, and
 * prepares the git repository the marketplace publish flow needs.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';

const TEMPLATES_ROOT = path.join(__dirname, '..', 'templates');
/** Every template directory under `templates/` this CLI knows how to scaffold. */
export const SCAFFOLD_TEMPLATES = ['default', 'instant'] as const;
export type ScaffoldTemplate = (typeof SCAFFOLD_TEMPLATES)[number];
const DEFAULT_SCAFFOLD_TEMPLATE: ScaffoldTemplate = 'default';
const APP_SERVER_PACKAGE_NAME = '@privos_ai/app-server';
const SKILL_NAME = 'privos-app-publish';

/**
 * npm never packs a file called `.gitignore`, so the templates carry it as
 * `gitignore` and it takes its real name on copy.
 */
const TEMPLATE_IGNORE_FILE = 'gitignore';

/** The Portal's rule for a manifest `name` (`marketplace-archive-manifest.ts`). */
const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;
/** The Portal's rule for the listing slug derived from the id. */
const LISTING_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * The listing slug the Portal derives from an app id
 * (`canonicalListingSlug` in `marketplace-publish-authorization-service.ts`).
 * Listing slugs are globally unique, so the id decides which listing the app
 * can ever publish to.
 */
export function canonicalListingSlug(appId: string): string {
	return appId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** Returns why `appId` cannot be published, or `undefined` when the Portal would accept it. */
export function validateAppId(appId: string): string | undefined {
	if (!APP_ID_PATTERN.test(appId)) {
		return `App id "${appId}" is invalid: use 2-128 lowercase letters, numbers, dots, hyphens or underscores, starting with a letter or number (${APP_ID_PATTERN}).`;
	}
	const slug = canonicalListingSlug(appId);
	if (!LISTING_SLUG_PATTERN.test(slug)) {
		return `App id "${appId}" gives the marketplace listing slug "${slug}" (${slug.length} characters), which must be 2-63 lowercase letters, numbers or hyphens. Shorten the id.`;
	}
	return undefined;
}

/**
 * Replaces the {{APP_NAME}} and {{APP_ID}} placeholders. The replacements are
 * functions, never strings: a replacement string would interpret `$&`, `$1`
 * and `$$` inside the value.
 */
export function applyPlaceholders(content: string, appName: string, appId: string): string {
	return content.replace(/\{\{APP_NAME\}\}/g, () => appName).replace(/\{\{APP_ID\}\}/g, () => appId);
}

/** Recursively copy directory, applying the placeholders and the ignore-file rename. */
function copyDir(src: string, dest: string, appName: string, appId: string): void {
	fs.mkdirSync(dest, { recursive: true });

	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const srcPath = path.join(src, entry.name);
		const destName = entry.name === TEMPLATE_IGNORE_FILE ? '.gitignore' : entry.name;
		const destPath = path.join(dest, destName);

		if (entry.isDirectory()) {
			copyDir(srcPath, destPath, appName, appId);
		} else {
			fs.writeFileSync(destPath, applyPlaceholders(fs.readFileSync(srcPath, 'utf-8'), appName, appId));
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

export type GitOutcome =
	| { status: 'initialized' }
	| { status: 'inside-work-tree'; root: string }
	| { status: 'unavailable' }
	| { status: 'failed'; reason: string };

export interface ScaffoldOptions {
	template?: string;
	/** Manifest id (`privos-app.json` `name`). Defaults to the placeholder `com.example.<app-name>`. */
	id?: string;
}

export interface ScaffoldResult {
	appName: string;
	appId: string;
	/** True when no `--id` was given: the id is a placeholder that must be replaced before publishing. */
	idIsPlaceholder: boolean;
	template: ScaffoldTemplate;
	targetDir: string;
	git: GitOutcome;
}

function runGit(args: string[], cwd: string) {
	return spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 15_000 });
}

/**
 * Publishing archives the git repository root, so an app has to be its own
 * repository. Creates one (`main` branch, nothing committed) only when git
 * exists and `dir` is not already inside a work tree. A git problem is
 * reported, never thrown: the scaffold itself has already succeeded.
 */
function prepareRepository(dir: string): GitOutcome {
	const probe = runGit(['rev-parse', '--show-toplevel'], dir);
	if (probe.error) {
		return (probe.error as NodeJS.ErrnoException).code === 'ENOENT'
			? { status: 'unavailable' }
			: { status: 'failed', reason: probe.error.message };
	}
	if (probe.status === 0) return { status: 'inside-work-tree', root: probe.stdout.trim() };
	// Only "not a git repository" means it is safe to start one; any other
	// refusal (unsafe ownership, bare repository) could hide an enclosing repo.
	if (!/not a git repository/i.test(probe.stderr)) {
		return { status: 'failed', reason: probe.stderr.trim() || `git exited with status ${probe.status}` };
	}
	const init = runGit(['init', '-b', 'main'], dir);
	if (init.error || init.status !== 0) {
		return { status: 'failed', reason: (init.error?.message ?? init.stderr.trim()) || `git exited with status ${init.status}` };
	}
	return { status: 'initialized' };
}

export async function scaffoldApp(appName: string, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
	if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(appName)) {
		throw new Error('App name must be 2-63 lowercase letters, numbers or hyphens, starting with a letter or number');
	}
	const template = options.template ?? DEFAULT_SCAFFOLD_TEMPLATE;
	if (!(SCAFFOLD_TEMPLATES as readonly string[]).includes(template)) {
		throw new Error(`Unknown template "${template}". Valid templates: ${SCAFFOLD_TEMPLATES.join(', ')}`);
	}
	const idIsPlaceholder = options.id === undefined;
	const appId = options.id ?? `com.example.${appName}`;
	if (!idIsPlaceholder) {
		const problem = validateAppId(appId);
		if (problem) throw new Error(problem);
	}
	const targetDir = path.resolve(process.cwd(), appName);

	if (fs.existsSync(targetDir)) {
		throw new Error(`Directory "${appName}" already exists`);
	}

	copyDir(path.join(TEMPLATES_ROOT, template), targetDir, appName, appId);
	copyAppServerSkill(targetDir);
	const git = prepareRepository(targetDir);
	return { appName, appId, idIsPlaceholder, template: template as ScaffoldTemplate, targetDir, git };
}

const MINIMUM_NODE_MAJOR = 22;

/** One warning line when the running Node is older than the generated app supports. */
export function nodeVersionWarning(nodeVersion: string): string | undefined {
	const major = Number(nodeVersion.replace(/^v/, '').split('.')[0]);
	return major < MINIMUM_NODE_MAJOR
		? `Node ${nodeVersion} is older than ${MINIMUM_NODE_MAJOR}. The generated app needs Node ${MINIMUM_NODE_MAJOR} or newer (engines.node >=${MINIMUM_NODE_MAJOR}); upgrade before you run npm install.`
		: undefined;
}

/** What the CLI prints after a scaffold: warnings first, then the next steps. */
export function describeScaffold(result: ScaffoldResult): { warnings: string[]; steps: string[] } {
	const { appName, appId, git } = result;
	const warnings: string[] = [];
	if (result.idIsPlaceholder) {
		warnings.push(
			`The app id is the placeholder "${appId}". Replace it (package.json "name", privos-app.json "name" and every ui:// URI) `
				+ 'before publishing, or scaffold again with --id <your-id>. The marketplace listing slug derives from it and is globally unique.',
		);
	}
	const publishNeedsOwnRepo = 'Publishing archives the repository root, so the app must be its own repository root.';
	let commitStep = 'Make the first commit in the app\'s own repository, including package-lock.json (the marketplace build runs npm ci).';
	switch (git.status) {
		case 'initialized':
			commitStep = 'git add -A && git commit -m "Initial commit"   # include package-lock.json; the marketplace build runs npm ci';
			break;
		case 'inside-work-tree':
			warnings.push(`${appName}/ is inside the git repository at ${git.root}. ${publishNeedsOwnRepo} Move it out, or run "git init -b main" inside it.`);
			break;
		case 'unavailable':
			warnings.push(`git was not found on PATH, so no repository was created. ${publishNeedsOwnRepo} Install git and run "git init -b main" inside ${appName}/.`);
			break;
		case 'failed':
			warnings.push(`Could not create a git repository (${git.reason}). ${publishNeedsOwnRepo} Run "git init -b main" inside ${appName}/.`);
			break;
	}
	const steps = [`cd ${appName}`, 'npm install --include=dev', commitStep];
	steps.push(
		result.template === 'instant'
			? 'npm run dev   # live UI preview in a workspace over Relay; run "npm run pair" once first'
			: 'npm run dev   # watch mode with a live UI; run "npm run pair" once to open the app in a workspace',
	);
	return { warnings, steps };
}
