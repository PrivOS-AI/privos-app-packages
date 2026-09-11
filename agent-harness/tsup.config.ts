import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/cli.ts'],
	// ESM only: Node >=22 target, global WebSocket, no CJS interop needed.
	// Shebang from src/cli.ts is preserved by tsup.
	format: ['esm'],
	target: 'node22',
	outDir: 'dist',
	clean: true,
	sourcemap: false,
	dts: false,
});
