// 别名与 tsconfig、Vite 保持一致（FR-BLD-4）
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@app/sdk': path.resolve(__dirname, 'src/sdk/index.ts'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: [
        'src/main/chttp/router.ts',
        'src/main/chttp/sse.ts',
        'src/main/chttp/static.ts',
        'src/main/plugins/loader.ts',
        'src/main/tasks/auto-import.ts',
        'src/main/logger.ts',
        'src/shared/**',
        'scripts/build-plugins.ts',
      ],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 80 },
    },
  },
});
