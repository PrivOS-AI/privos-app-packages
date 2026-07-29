/**
 * Scaffolds a new Privos MCP app project from the default template.
 * Copies template files, replaces placeholders with app name.
 */
import * as fs from 'fs';
import * as path from 'path';

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates', 'default');

/** Recursively copy directory, replacing {{APP_NAME}} placeholder */
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

export async function scaffoldApp(appName: string): Promise<void> {
	if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(appName)) {
		throw new Error('App name must be 2-63 lowercase letters, numbers or hyphens, starting with a letter or number');
	}
	const targetDir = path.resolve(process.cwd(), appName);

	if (fs.existsSync(targetDir)) {
		throw new Error(`Directory "${appName}" already exists`);
	}

	copyDir(TEMPLATE_DIR, targetDir, appName);
}
