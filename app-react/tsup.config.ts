import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  outDir: 'dist',
  treeshake: true,
  // React is a peer dependency — never bundle it or the JSX runtime.
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  // Use the automatic JSX runtime (matches tsconfig "jsx": "react-jsx").
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
