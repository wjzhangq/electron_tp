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
    // 固定输出文件名为 main.cjs（与 package.json 的 main 对应），避免与 preload 的 index 入口重名
    lib: { entry: 'src/main/index.ts', fileName: () => 'main.cjs', formats: ['cjs'] },
  },
});
