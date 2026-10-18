import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ net: { fetch: fetchMock } }));

import { createStaticHandler, CSP, devCsp } from '../../src/main/chttp/static';

let root: string;
let outside: string;

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'static-test-'));
  root = path.join(base, 'renderer');
  outside = path.join(base, 'secret.txt');
  fs.mkdirSync(path.join(root, 'assets', 'sub dir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'assets', 'sub dir', 'a b.css'), 'body{}');
  fs.writeFileSync(path.join(root, 'assets', 'blob.bin'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(outside, 'secret');
  for (const ext of [
    'mjs',
    'json',
    'map',
    'svg',
    'png',
    'jpg',
    'jpeg',
    'webp',
    'gif',
    'ico',
    'woff',
    'woff2',
    'ttf',
    'wasm',
    'txt',
  ]) {
    fs.writeFileSync(path.join(root, `f.${ext}`), 'x');
  }
});

afterAll(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

const get = (pathname: string, method = 'GET') => {
  const handler = createStaticHandler({ root });
  const url = new URL(`chttp://localhost${pathname}`);
  return handler(new Request(url, { method }), url);
};

describe('static handler (production)', () => {
  it('serves index.html at / with no-cache and CSP', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('<title>t</title>');
  });

  it('serves assets with MIME type and CSP, without no-cache', async () => {
    const res = await get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(res.headers.get('cache-control')).toBeNull();
    expect(res.headers.get('content-length')).toBe('14');
    expect(await res.text()).toBe('console.log(1)');
  });

  it('maps every documented extension (5.5)', async () => {
    const expected: Record<string, string> = {
      mjs: 'text/javascript; charset=utf-8',
      json: 'application/json',
      map: 'application/json',
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      ico: 'image/x-icon',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
      wasm: 'application/wasm',
      txt: 'text/plain; charset=utf-8',
    };
    for (const [ext, type] of Object.entries(expected)) {
      expect((await get(`/f.${ext}`)).headers.get('content-type'), ext).toBe(type);
    }
    expect((await get('/assets/blob.bin')).headers.get('content-type')).toBe('application/octet-stream');
  });

  it('decodes percent-encoded paths', async () => {
    const res = await get('/assets/sub%20dir/a%20b.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('returns 400 when the path cannot be decoded', async () => {
    expect((await get('/%E0%A4%A')).status).toBe(400);
  });

  it('returns 403 when the decoded path escapes the root', async () => {
    // URL 解析会消除 ../ 与 %2e%2e/，只有编码后的分隔符（%2f、%5c）在解码后才会出现 ..
    const cases = ['/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/assets/..%2f..%2fsecret.txt'];
    if (path.sep === '\\') cases.push('/..%5csecret.txt'); // 反斜杠只在 Windows 上是分隔符
    for (const p of cases) expect((await get(p)).status, p).toBe(403);
  });

  it('never serves files outside the root even after URL normalization', async () => {
    const res = await get('/%2e%2e/secret.txt'); // 被 URL 规范化为 /secret.txt，在根目录内查找
    expect(res.status).toBe(404);
  });

  it('falls back to index.html for extension-less paths (SPA)', async () => {
    const res = await get('/some/route');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-security-policy')).toBe(CSP);
  });

  it('falls back to index.html for a directory', async () => {
    const res = await get('/assets');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('returns 404 for a missing file with an extension', async () => {
    expect((await get('/missing.js')).status).toBe(404);
  });

  it('returns headers but no body for HEAD', async () => {
    const res = await get('/assets/app.js', 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('14');
    expect(await res.text()).toBe('');
  });
});

describe('static handler (development)', () => {
  beforeEach(() => fetchMock.mockReset());

  it('builds a dev CSP that only adds the HMR websocket to connect-src', () => {
    const csp = devCsp('http://localhost:5173');
    expect(csp).toBe(CSP.replace("connect-src 'self'", "connect-src 'self' ws://localhost:5173"));
    expect(csp).toContain("script-src 'self';");
  });

  it('proxies to the dev server and sets the dev CSP', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html', 'x-up': '1' } }),
    );
    const handler = createStaticHandler({ root, devServerUrl: 'http://localhost:5173' });
    const url = new URL('chttp://localhost/src/main.ts?t=1');
    const res = await handler(new Request(url, { headers: { accept: 'text/html', origin: 'chttp://localhost' } }), url);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5173/src/main.ts?t=1',
      expect.objectContaining({ method: 'GET' }),
    );
    const forwarded = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(forwarded.get('accept')).toBe('text/html');
    expect(forwarded.has('origin')).toBe(false); // 见 static.ts：Origin 不转发给 dev server
    expect(res.status).toBe(200);
    expect(res.headers.get('x-up')).toBe('1');
    expect(res.headers.get('content-security-policy')).toBe(devCsp('http://localhost:5173'));
    expect(await res.text()).toBe('<html></html>');
  });

  it('keeps dev server status codes', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404, statusText: 'Not Found' }));
    const handler = createStaticHandler({ root, devServerUrl: 'http://localhost:5173' });
    const url = new URL('chttp://localhost/x.js');
    const res = await handler(new Request(url), url);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-security-policy')).toBeTruthy();
  });
});
