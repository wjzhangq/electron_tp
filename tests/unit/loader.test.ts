import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/sdk';
import { Router } from '../../src/api/router';

type Loader = typeof import('../../src/api/plugins/loader');
let loader: Loader;
let root: string;
let logs: Array<[string, keyof Logger, string]>;

const createLogger = (scope: string): Logger => {
  const at =
    (lvl: keyof Logger) =>
    (...a: unknown[]) =>
      logs.push([scope, lvl, a.map(String).join(' ')]);
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
};
const opts = (extra: { root?: string; setupTimeoutMs?: number } = {}) => ({
  root,
  app: { version: '9.9.9', isPackaged: false },
  createLogger,
  ...extra,
});

beforeEach(async () => {
  vi.resetModules();
  logs = [];
  loader = await import('../../src/api/plugins/loader');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** 写一个已构建好的 CJS 插件（等同于 build-plugins 的产物） */
const plugin = (dir: string, body: string) => {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, 'index.js'), body);
};
const def = (name: string, setup: string, extra = '') =>
  `exports.default = { name: ${JSON.stringify(name)}, version: '1.0.0', setup: ${setup}${extra} };`;

const quiet = { warn: () => {}, error: () => {} };
const call = async (r: Router, method: string, p: string) => {
  const url = new URL(`chttp://localhost${p}`);
  const res = await r.dispatch(new Request(url, { method }), url);
  return { status: res.status, data: await res.json() };
};

describe('loadPlugins', () => {
  it('loads plugins in directory order under /api/plugins/<name> with a scoped ctx', async () => {
    plugin(
      'b-two',
      def(
        'b-two',
        `(r, ctx) => r.get('/who', () => ({ name: ctx.name, app: ctx.app, keys: Object.keys(ctx).sort() }))`,
      ),
    );
    plugin('a-one', def('a-one', `(r) => { r.get('/hi', () => 'a'); r.sse('/s', (_q, s) => s.close()); }`));
    const router = new Router({ logger: quiet });
    const statuses = await loader.loadPlugins(router, opts());
    expect(statuses).toEqual([
      { name: 'a-one', version: '1.0.0', status: 'loaded' },
      { name: 'b-two', version: '1.0.0', status: 'loaded' },
    ]);
    expect((await call(router, 'GET', '/api/plugins/a-one/hi')).data).toBe('a');
    expect((await call(router, 'GET', '/api/plugins/b-two/who')).data).toEqual({
      name: 'b-two',
      app: { version: '9.9.9', isPackaged: false },
      keys: ['app', 'logger', 'name'],
    });
  });

  it('gives each plugin a logger prefixed with its name', async () => {
    plugin('hello', def('hello', `(_r, ctx) => ctx.logger.info('ready')`));
    await loader.loadPlugins(new Router({ logger: quiet }), opts());
    expect(logs).toEqual([['plugin:hello', 'info', 'ready']]);
  });

  it('isolates a failing setup: removes its routes, marks failed, keeps others running', async () => {
    plugin('bad', def('bad', `async (r) => { r.get('/x', () => 1); throw new Error('boom'); }`));
    plugin('good', def('good', `(r) => r.get('/x', () => 'ok')`));
    const router = new Router({ logger: quiet });
    const statuses = await loader.loadPlugins(router, opts());
    expect(statuses[0]).toMatchObject({ name: 'bad', status: 'failed', error: 'Error: boom' });
    expect(statuses[0]!.version).toBeUndefined();
    expect(statuses[1]).toEqual({ name: 'good', version: '1.0.0', status: 'loaded' });
    expect((await call(router, 'GET', '/api/plugins/bad/x')).status).toBe(404);
    expect((await call(router, 'GET', '/api/plugins/good/x')).data).toBe('ok');
  });

  it('fails a plugin whose module throws on load or is missing index.js', async () => {
    plugin('throws', `throw new Error('load error');`);
    fs.mkdirSync(path.join(root, 'empty'));
    const statuses = await loader.loadPlugins(new Router({ logger: quiet }), opts());
    expect(statuses.map((s) => [s.name, s.status])).toEqual([
      ['empty', 'failed'],
      ['throws', 'failed'],
    ]);
    expect(statuses[1]!.error).toMatch(/load error/);
  });

  it('fails a plugin whose name does not match the directory, or has no setup/default export', async () => {
    plugin('mismatch', def('other', `() => {}`));
    plugin('no-default', `exports.foo = 1;`);
    plugin('no-setup', `exports.default = { name: 'no-setup', version: '1' };`);
    const statuses = await loader.loadPlugins(new Router({ logger: quiet }), opts());
    for (const s of statuses) {
      expect(s.status).toBe('failed');
      expect(s.error).toMatch(/must default-export definePlugin/);
    }
  });

  it('rejects invalid directory names without loading them', async () => {
    plugin('Bad_Name', `globalThis.__loadedBadName = true; ${def('Bad_Name', '() => {}')}`);
    plugin('1abc', def('1abc', '() => {}'));
    const statuses = await loader.loadPlugins(new Router({ logger: quiet }), opts());
    expect(statuses.every((s) => s.status === 'failed' && /invalid plugin name/.test(s.error!))).toBe(true);
    expect((globalThis as { __loadedBadName?: boolean }).__loadedBadName).toBeUndefined();
  });

  it('ignores plain files in the plugin root and tolerates a missing root', async () => {
    fs.writeFileSync(path.join(root, 'README.txt'), 'x');
    expect(await loader.loadPlugins(new Router({ logger: quiet }), opts())).toEqual([]);
    expect(await loader.loadPlugins(new Router({ logger: quiet }), opts({ root: path.join(root, 'nope') }))).toEqual(
      [],
    );
  });

  it('treats a setup timeout as failure and removes routes registered before it (FR-PLG-10)', async () => {
    plugin('slow', def('slow', `(r) => { r.get('/x', () => 1); return new Promise(() => {}); }`));
    plugin('zfast', def('zfast', `(r) => r.get('/x', () => 2)`));
    const router = new Router({ logger: quiet });
    const statuses = await loader.loadPlugins(router, opts({ setupTimeoutMs: 50 }));
    expect(statuses[0]).toMatchObject({ name: 'slow', status: 'failed' });
    expect(statuses[0]!.error).toMatch(/timed out after 50ms/);
    expect(statuses[1]!.status).toBe('loaded');
    expect((await call(router, 'GET', '/api/plugins/slow/x')).status).toBe(404);
  });

  it('rejects route registration after setup finished (success, failure or timeout)', async () => {
    const g = globalThis as { __late?: Record<string, unknown> };
    g.__late = {};
    const lateRegister = (key: string, delay: number) =>
      `setTimeout(() => { try { r.get('/late', () => 1); globalThis.__late[${JSON.stringify(key)}] = 'ok'; } catch (e) { globalThis.__late[${JSON.stringify(key)}] = String(e); } }, ${delay});`;
    plugin('ok', def('ok', `(r) => { ${lateRegister('ok', 0)} }`));
    plugin('fail', def('fail', `(r) => { ${lateRegister('fail', 0)} throw new Error('x'); }`));
    plugin('timeout', def('timeout', `(r) => { ${lateRegister('timeout', 80)} return new Promise(() => {}); }`));
    const router = new Router({ logger: quiet });
    await loader.loadPlugins(router, opts({ setupTimeoutMs: 40 }));
    await new Promise((res) => setTimeout(res, 150));
    for (const k of ['ok', 'fail', 'timeout']) {
      expect(g.__late[k], k).toMatch(/can only be registered during setup/);
      expect((await call(router, 'GET', `/api/plugins/${k}/late`)).status, k).toBe(404);
    }
    delete g.__late;
  });

  it('fails a plugin that registers a duplicate route; does not clash with built-in routes', async () => {
    plugin('dup', def('dup', `(r) => { r.get('/x', () => 1); r.get('/x', () => 2); }`));
    const router = new Router({ logger: quiet });
    router.get('/api/plugins', () => []);
    const statuses = await loader.loadPlugins(router, opts());
    expect(statuses[0]).toMatchObject({ name: 'dup', status: 'failed' });
    expect(statuses[0]!.error).toMatch(/duplicate route/);
    expect((await call(router, 'GET', '/api/plugins')).status).toBe(200);
  });

  it('supports every registrar method', async () => {
    plugin(
      'all',
      def(
        'all',
        `(r) => { r.get('/r', () => 'g'); r.post('/r', () => 'p'); r.put('/r', () => 'u'); r.patch('/r', () => 'a'); r.delete('/r', () => 'd'); r.sse('/s', (_q, s) => { s.send('x'); s.close(); }, 'POST'); }`,
      ),
    );
    const router = new Router({ logger: quiet, heartbeatMs: 0 });
    await loader.loadPlugins(router, opts());
    for (const [m, v] of [
      ['GET', 'g'],
      ['POST', 'p'],
      ['PUT', 'u'],
      ['PATCH', 'a'],
      ['DELETE', 'd'],
    ]) {
      expect((await call(router, m!, '/api/plugins/all/r')).data).toBe(v);
    }
    const url = new URL('chttp://localhost/api/plugins/all/s');
    expect(await (await router.dispatch(new Request(url, { method: 'POST' }), url)).text()).toBe('data: x\n\n');
  });
});

describe('disposePlugins', () => {
  it('calls dispose on loaded plugins only, with a per-plugin timeout', async () => {
    const g = globalThis as { __disposed?: string[] };
    g.__disposed = [];
    plugin('a', def('a', '() => {}', `, dispose: () => { globalThis.__disposed.push('a'); }`));
    plugin('b', def('b', '() => {}', `, dispose: () => new Promise(() => {})`));
    plugin('c', def('c', '() => {}'));
    plugin('d', def('d', `() => { throw new Error('x'); }`, `, dispose: () => { globalThis.__disposed.push('d'); }`));
    plugin('e', def('e', '() => {}', `, dispose: () => { throw new Error('dispose failed'); }`));
    await loader.loadPlugins(new Router({ logger: quiet }), opts());
    const started = Date.now();
    await loader.disposePlugins(50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(g.__disposed).toEqual(['a']);
    const warns = logs.filter(([scope, lvl]) => scope === 'plugins' && lvl === 'warn').map(([, , m]) => m);
    expect(warns).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/plugin b dispose timed out/),
        expect.stringMatching(/dispose failed/),
      ]),
    );
    // 已清理的插件不会被重复 dispose
    await loader.disposePlugins(50);
    expect(g.__disposed).toEqual(['a']);
    delete g.__disposed;
  });
});
