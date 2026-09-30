import { defineConfig } from 'vitest/config';

// Kept apart from vite.config.ts: that file builds the UI with `root: 'src/ui'`,
// while the tests run from the project root. `NODE_ENV=test` holds even when the
// shell exports another value.
export default defineConfig({
  root: '.',
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    env: { NODE_ENV: 'test' },
  },
});
