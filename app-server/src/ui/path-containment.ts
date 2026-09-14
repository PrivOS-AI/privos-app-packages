import path from 'node:path';

/**
 * True when `fileRealpath` resolves to a location strictly inside
 * `dirRealpath` — both already resolved with `fs.realpathSync`, so a symlink
 * that would otherwise let a caller escape the directory (`assets/evil ->
 * /etc/passwd`) is caught here rather than trusted. Shared by `serveBuiltUi`
 * (runtime asset reads) and `buildUiBundle` (build-time asset packing) —
 * every reader of `distDir/assets/*` must apply the same containment rule.
 */
export function isContainedIn(dirRealpath: string, fileRealpath: string): boolean {
	const relative = path.relative(dirRealpath, fileRealpath);
	return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
