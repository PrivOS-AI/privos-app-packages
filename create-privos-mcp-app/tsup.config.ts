import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // CJS: the scaffolder resolves its templates dir via __dirname, which only
  // exists in CommonJS output. Keep the shebang from src/index.ts intact.
  format: ['cjs'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  dts: false,
});
