import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/adapters/**', 'src/http.ts', 'src/config.ts'],
    },
  },
});
