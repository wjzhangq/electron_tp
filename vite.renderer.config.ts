import path from 'node:path';
import { defineConfig } from 'vite';

const DEV_PORT = 5173;

export default defineConfig({
  resolve: { alias: { '@shared': path.resolve(__dirname, 'src/shared') } },
  server: {
    port: DEV_PORT,
    strictPort: true,
    // 页面 origin 是 chttp://localhost，需要显式指定 HMR 的连接地址
    hmr: { protocol: 'ws', host: 'localhost', clientPort: DEV_PORT },
  },
});
