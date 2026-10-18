// E2E 运行在未打包构建上（见 PRD 8.17）：npm run test:e2e 会先 package 生成 .vite/，再 build:plugins 生成 .plugins/
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

let app: ElectronApplication;
let page: Page;

const launch = async () => {
  app = await electron.launch({ args: ['.'] });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
};

const win = <T>(fn: (w: Electron.BrowserWindow) => T) =>
  app.evaluate(({ BrowserWindow }, src) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    return new Function('w', `return (${src})(w)`)(w) as T;
  }, fn.toString());

/** 在主进程通过 net.fetch 发起 chttp 请求，可以构造页面无法发出的请求（其他主机、跨源 Origin） */
const mainFetch = (url: string, headers: Record<string, string> = {}) =>
  app.evaluate(
    async ({ net }, { url, headers }) => {
      const res = await net.fetch(url, { headers });
      return { status: res.status, text: await res.text() };
    },
    { url, headers },
  );

test.describe('app', () => {
  test.beforeEach(launch);
  test.afterEach(async () => {
    await app?.close().catch(() => {});
  });

  test('boots on chttp://localhost with the security baseline', async () => {
    await expect(page).toHaveURL(/^chttp:\/\/localhost\//);
    await expect(page.locator('h1')).toHaveText('chttp 桌面壳示例');
    // nodeIntegration 关闭、contextIsolation 开启：页面拿不到 Node 与 ipcRenderer，只能看到白名单桥接
    expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe('undefined');
    expect(await page.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe('undefined');
    expect(await page.evaluate(() => typeof (window.app as unknown as { send?: unknown }).send)).toBe('undefined');
    expect(await page.evaluate(() => Object.keys(window.app).sort())).toEqual([
      'info',
      'onThemeChanged',
      'openExternal',
      'openLogs',
      'timers',
      'toggleDevTools',
      'window',
    ]);
    const info = await page.evaluate(() => window.app.info());
    expect(info).toMatchObject({ isPackaged: false, arch: process.arch });
  });

  test('serves the page with CSP and the API over chttp', async () => {
    const html = await page.evaluate(async () => {
      const res = await fetch('/');
      return { csp: res.headers.get('content-security-policy'), cache: res.headers.get('cache-control') };
    });
    expect(html.csp).toContain("default-src 'self'");
    expect(html.csp).toContain("connect-src 'self';");
    expect(html.cache).toBe('no-cache');

    const pong = await page.evaluate(async () => {
      const res = await fetch('/api/ping');
      return { ok: res.ok, status: res.status, body: await res.json() };
    });
    expect(pong).toMatchObject({ ok: true, status: 200, body: { pong: true } });
    expect(typeof pong.body.time).toBe('number');

    const plugins = await page.evaluate(async () => (await fetch('/api/plugins')).json());
    expect(plugins).toEqual([{ name: 'hello', version: '1.0.0', status: 'loaded' }]);

    const missing = await page.evaluate(async () => {
      const res = await fetch('/api/nope');
      return { ok: res.ok, status: res.status, body: await res.json() };
    });
    expect(missing).toEqual({
      ok: false,
      status: 404,
      body: { code: 'NOT_FOUND', message: 'api /api/nope not found' },
    });
  });

  test('rejects other hosts (404) and cross-origin requests (403)', async () => {
    expect((await mainFetch('chttp://example/api/ping')).status).toBe(404);
    expect((await mainFetch('chttp://localhost/api/ping', { Origin: 'https://evil.example' })).status).toBe(403);
    const same = await mainFetch('chttp://localhost/api/ping', { Origin: 'chttp://localhost' });
    expect(same.status).toBe(200);
  });

  test('calls the hello plugin JSON and SSE APIs', async () => {
    const greet = await page.evaluate(async () => (await fetch('/api/plugins/hello/greet?name=Tom')).json());
    expect(greet).toEqual({ message: 'hello, Tom' });

    const bad = await page.evaluate(async () => {
      const res = await fetch('/api/plugins/hello/greet');
      return { status: res.status, body: await res.json() };
    });
    expect(bad).toEqual({ status: 400, body: { code: 'BAD_REQUEST', message: 'name is required' } });

    const echo = await page.evaluate(async () =>
      (await fetch('/api/plugins/hello/echo', { method: 'POST', body: JSON.stringify({ text: 'hi' }) })).json(),
    );
    expect(echo).toEqual({ text: 'hi', length: 2 });

    const invalid = await page.evaluate(async () => {
      const res = await fetch('/api/plugins/hello/echo', { method: 'POST', body: '{}' });
      return { status: res.status, body: await res.json() };
    });
    expect(invalid).toEqual({ status: 422, body: { code: 'HELLO_TEXT_INVALID', message: 'text must be a string' } });

    const sse = await page.evaluate(async () => {
      const res = await fetch('/api/plugins/hello/count?n=3');
      return { type: res.headers.get('content-type'), body: await res.text() };
    });
    expect(sse.type).toBe('text/event-stream; charset=utf-8');
    expect(sse.body).toBe(
      [1, 2, 3].map((i) => `event: progress\nid: ${i}\ndata: {"i":${i},"total":3}\n\n`).join('') +
        'event: complete\ndata: {"done":true}\n\n',
    );

    // 页面中的示例按钮走 renderer/api.ts 的 stream() 客户端
    await page.click('#btn-count');
    await expect(page.locator('#output')).toContainText('progress 5/5', { timeout: 10_000 });
    await expect(page.locator('#output')).toContainText('complete');
  });

  test('aborting an SSE fetch disconnects the stream', async () => {
    const result = await page.evaluate(async () => {
      const ac = new AbortController();
      const res = await fetch('/api/plugins/hello/count?n=100', { signal: ac.signal });
      const reader = res.body!.getReader();
      await reader.read();
      ac.abort();
      try {
        await reader.read();
        return 'not aborted';
      } catch (e) {
        return (e as Error).name;
      }
    });
    expect(result).toBe('AbortError');
  });

  test('M2 verification 1: aborting fetch cancels the ReadableStream returned by protocol.handle', async () => {
    // 在独立 session 中为 chttp 注册探针处理函数，记录流的 cancel 是否被触发；不影响应用自身的 session
    const cancelled = await app.evaluate(async ({ BrowserWindow, session }) => {
      const g = globalThis as { __probeCancelled?: boolean };
      g.__probeCancelled = false;
      const ses = session.fromPartition('probe-sse-cancel');
      ses.protocol.handle('chttp', (req) => {
        if (new URL(req.url).pathname === '/') {
          return new Response('<!doctype html><title>probe</title>', { headers: { 'content-type': 'text/html' } });
        }
        const enc = new TextEncoder();
        let timer: NodeJS.Timeout | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode('data: 0\n\n'));
            timer = setInterval(() => c.enqueue(enc.encode(': ping\n\n')), 100);
          },
          cancel() {
            clearInterval(timer);
            g.__probeCancelled = true;
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      });
      const w = new BrowserWindow({ show: false, webPreferences: { partition: 'probe-sse-cancel', sandbox: true } });
      await w.loadURL('chttp://localhost/');
      await w.webContents.executeJavaScript(`(async () => {
        const ac = new AbortController();
        const res = await fetch('/stream', { signal: ac.signal });
        const reader = res.body.getReader();
        await reader.read();
        ac.abort();
      })()`);
      for (let i = 0; i < 50 && !g.__probeCancelled; i++) await new Promise((r) => setTimeout(r, 100));
      w.destroy();
      ses.protocol.unhandle('chttp');
      return g.__probeCancelled;
    });
    expect(cancelled).toBe(true);
  });

  test('M2 verification 2: native EventSource can connect to chttp://localhost/api', async () => {
    const events = await page.evaluate(
      () =>
        new Promise<string[]>((resolve, reject) => {
          const got: string[] = [];
          const es = new EventSource('/api/plugins/hello/count?n=2');
          es.addEventListener('progress', (e) => got.push(`progress:${(e as MessageEvent).data}`));
          es.addEventListener('complete', (e) => {
            got.push(`complete:${(e as MessageEvent).data}`);
            es.close();
            resolve(got);
          });
          setTimeout(() => {
            es.close();
            reject(new Error(`timeout, got ${JSON.stringify(got)}, readyState ${es.readyState}`));
          }, 10_000);
        }),
    );
    expect(events).toEqual(['progress:{"i":1,"total":2}', 'progress:{"i":2,"total":2}', 'complete:{"done":true}']);
  });

  test('main-process timers notify the owning page and are cleared on reload', async () => {
    const state = await page.evaluate(() => window.app.timers.set({ id: 't', intervalSec: 1, data: { a: 1 } }));
    expect(state).toMatchObject({ id: 't', intervalSec: 1 });
    const tick = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const off = window.app.timers.onTick((t) => {
            off();
            resolve(t);
          });
        }),
    );
    expect(tick).toMatchObject({ id: 't', data: { a: 1 } });
    expect(await page.evaluate(() => window.app.timers.list())).toHaveLength(1);

    const invalid = await page.evaluate(() =>
      window.app.timers.set({ id: 'x', intervalSec: 0 }).then(
        () => 'ok',
        (e) => String(e),
      ),
    );
    expect(invalid).toMatch(/intervalSec/);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    expect(await page.evaluate(() => window.app.timers.list())).toEqual([]);
  });

  test('API runs in a separate utility process and is restarted after a crash', async () => {
    const pid = await app.evaluate(
      ({ app }) => app.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'API Service')?.pid,
    );
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(await app.evaluate(() => process.pid));

    process.kill(pid!, 'SIGKILL');
    await expect
      .poll(async () => page.evaluate(async () => (await fetch('/api/ping')).status), { timeout: 15_000 })
      .toBe(200);
    const newPid = await app.evaluate(
      ({ app }) => app.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'API Service')?.pid,
    );
    expect(newPid).toBeGreaterThan(0);
    expect(newPid).not.toBe(pid);
    expect(await page.evaluate(async () => (await fetch('/api/plugins')).json())).toEqual([
      { name: 'hello', version: '1.0.0', status: 'loaded' },
    ]);
  });

  test('IPC window operations act on the sender window', async () => {
    const secondId = await app.evaluate(async ({ app, BrowserWindow }) => {
      const preload = `${app.getAppPath()}/.vite/build/preload.cjs`;
      const w = new BrowserWindow({ show: true, webPreferences: { preload, sandbox: true, contextIsolation: true } });
      await w.loadURL('chttp://localhost/');
      return w.id;
    });
    const second = app.windows().find((p) => p !== page)!;
    await second.evaluate(() => window.app.window.minimize());
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.isMinimized(), secondId))
      .toBe(true);
    expect(await (await app.browserWindow(page)).evaluate((w) => w.isMinimized())).toBe(false);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.destroy(), secondId);
  });

  test('rejects non-http(s) URLs in openExternal', async () => {
    const err = await page.evaluate(() =>
      window.app.openExternal('file:///etc/passwd').then(
        () => 'ok',
        (e) => String(e),
      ),
    );
    expect(err).toMatch(/only http\/https/);
  });

  test('blocks navigation away from chttp://localhost and window.open', async () => {
    await page.evaluate(() => {
      location.href = 'https://example.com/';
    });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => location.origin)).toBe('chttp://localhost');
    const opened = await page.evaluate(() => window.open('chttp://localhost/') === null);
    expect(opened).toBe(true);
    expect(app.windows()).toHaveLength(1);
  });

  test('minimizes and maximizes via the custom title bar', async () => {
    await page.click('#btn-max');
    await expect.poll(() => win((w) => w.isMaximized())).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('data-maximized', 'true');
    await page.click('#btn-max');
    await expect.poll(() => win((w) => w.isMaximized())).toBe(false);
    await expect(page.locator('body')).toHaveAttribute('data-maximized', 'false');

    await page.click('#btn-min');
    await expect.poll(() => win((w) => w.isMinimized())).toBe(true);
    await win((w) => w.restore());
  });

  test('close flow: cancel keeps the window, tray hides it, quit exits', async () => {
    // 取消：窗口保持原状
    await page.click('#btn-close');
    await expect(page.locator('#close-dialog')).toBeVisible();
    await page.click('#close-cancel');
    await expect(page.locator('#close-dialog')).toBeHidden();
    expect(await win((w) => w.isVisible())).toBe(true);

    // 最小化到托盘：窗口隐藏，应用继续运行
    await page.click('#btn-close');
    await page.click('#close-tray');
    await expect.poll(() => win((w) => w.isVisible())).toBe(false);
    expect(await page.evaluate(async () => (await fetch('/api/ping')).ok)).toBe(true);
    await win((w) => w.show()); // 等价于托盘“显示主窗口”

    // 每次都询问（不记住选择）；选择退出后应用退出
    await page.click('#btn-close');
    await expect(page.locator('#close-dialog')).toBeVisible();
    const closed = new Promise<void>((resolve) => app.once('close', () => resolve()));
    // 点击期间页面随应用退出而关闭，click 本身可能以 "closed" 报错，以应用退出为准
    await page.click('#close-quit').catch(() => {});
    await closed;
  });

  test('close flow: closing without a page handler quits immediately', async () => {
    await page.uncheck('#chk-close'); // 调用取消函数，页面不再接管关闭
    const closed = new Promise<void>((resolve) => app.once('close', () => resolve()));
    await page.click('#btn-close').catch(() => {});
    await closed;
  });

  test('reload resets close handling so the window can always be closed', async () => {
    // 让页面注册接管后再刷新；新页面加载前 pageHandlesClose 已被重置
    await page.evaluate(() => {
      window.app.window.onCloseRequested(() => {});
    });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.uncheck('#chk-close');
    const closed = new Promise<void>((resolve) => app.once('close', () => resolve()));
    await win((w) => w.close());
    await closed;
  });

  test('close flow: a hung page does not block closing', async () => {
    // 页面接管了关闭（复选框默认勾选），随后主线程卡死：preload 无法回执，主进程超时后直接关闭
    const closed = new Promise<void>((resolve) => app.once('close', () => resolve()));
    void page
      .evaluate(() => {
        for (;;) {
          /* 卡死 */
        }
      })
      .catch(() => {});
    await page.waitForTimeout(200);
    const started = Date.now();
    await win((w) => w.close());
    await closed;
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
