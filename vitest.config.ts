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
        'src/api/router.ts',
        'src/api/sse.ts',
        'src/api/serve.ts',
        'src/api/log.ts',
        'src/api/plugins/loader.ts',
        'src/main/chttp/forward.ts',
        'src/main/chttp/static.ts',
        'src/main/timers.ts',
        'src/main/logger.ts',
        'src/shared/api.ts',
        'src/renderer/api.ts',
        'scripts/build-plugins.ts',
      ],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 80 },
    },
  },
});
