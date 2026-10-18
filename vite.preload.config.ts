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
    // 固定输出文件名为 preload.cjs（window.ts 按此路径加载）
    rollupOptions: { output: { entryFileNames: 'preload.cjs' } },
  },
});
