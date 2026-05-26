import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.e2e-capture.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
