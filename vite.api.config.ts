import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@app/sdk': path.resolve(__dirname, 'src/sdk/index.ts'),
    },
  },
  build: {
    // API 服务进程入口，主进程按 .vite/build/api.cjs 加载（见 src/main/index.ts）
    lib: { entry: 'src/api/index.ts', fileName: () => 'api.cjs', formats: ['cjs'] },
  },
});
