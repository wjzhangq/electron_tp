import fs from 'node:fs';
import path from 'node:path';
import { net } from 'electron';
import type { StaticHandler } from './scheme';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/** SEC-8：开发模式只额外放开 HMR 的 WebSocket 地址 */
export const devCsp = (devServerUrl: string): string =>
  CSP.replace("connect-src 'self'", `connect-src 'self' ws://${new URL(devServerUrl).host}`);

export function createStaticHandler(opts: { root: string; devServerUrl?: string }): StaticHandler {
  const root = path.resolve(opts.root);
  const devServerUrl = opts.devServerUrl;

  if (devServerUrl) {
    const csp = devCsp(devServerUrl);
    // 开发：转发到 Vite dev server，SPA 回落由 dev server 处理；同样下发 CSP
    return async (req, url) => {
      // Origin 已在协议入口（handleChttp）校验过；原样转发 Origin: chttp://localhost 会使 net.fetch 以 net::ERR_FAILED 失败
      // （页面中的 <script type="module"> 必带 Origin），因此转发时去掉该头，其余请求头保持不变
      const headers = new Headers(req.headers);
      headers.delete('origin');
      const res = await net.fetch(new URL(url.pathname + url.search, devServerUrl).toString(), {
        method: req.method,
        headers,
      });
      const resHeaders = new Headers(res.headers);
      resHeaders.set('Content-Security-Policy', csp);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: resHeaders });
    };
  }

  return async (req, url) => {
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    const resolved = path.resolve(root, '.' + rel);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    let file = resolved;
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) {
      if (path.extname(rel)) return new Response('Not Found', { status: 404 });
      file = path.join(root, 'index.html'); // SPA 回落
    }

    // 用 fs 直接读取（asar 内同样可用），不经过 file:// 协议
    const data = await fs.promises.readFile(file);
    const ext = path.extname(file).toLowerCase();
    const headers = new Headers({
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': String(data.byteLength),
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
    });
    if (ext === '.html') headers.set('Cache-Control', 'no-cache');
    return new Response(req.method === 'HEAD' ? null : new Uint8Array(data), { status: 200, headers });
  };
}
