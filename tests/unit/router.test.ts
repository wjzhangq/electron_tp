// Router 不依赖 electron，无需 mock
import { describe, expect, it, vi } from 'vitest';
import { Router } from '../../src/main/chttp/router';
import { ApiError } from '../../src/shared/api';

const quiet = { warn: () => {}, error: () => {} };
const newRouter = (opts: ConstructorParameters<typeof Router>[0] = {}) => new Router({ logger: quiet, ...opts });

const dispatch = (r: Router, method: string, path: string, init: { body?: string; headers?: HeadersInit } = {}) => {
  const url = new URL(`chttp://localhost${path}`);
  const req = new Request(url, { method, body: init.body, headers: init.headers });
  return r.dispatch(req, url);
};

const call = async (r: Router, method: string, path: string, body?: unknown) =>
  (await dispatch(r, method, path, { body: body === undefined ? undefined : JSON.stringify(body) })).json();

describe('Router', () => {
  it('wraps return value', async () => {
    const r = newRouter();
    r.get('/api/ping', () => ({ pong: true }));
    expect(await call(r, 'GET', '/api/ping')).toEqual({ code: 0, msg: 'success', data: { pong: true } });
  });

  it('wraps undefined as null and keeps HTTP 200 with JSON headers', async () => {
    const r = newRouter();
    r.delete('/api/x', () => undefined);
    const res = await dispatch(r, 'DELETE', '/api/x');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ code: 0, msg: 'success', data: null });
  });

  it('supports all methods, path params and query', async () => {
    const r = newRouter();
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      r[m]('/api/items/:id/:sub', (req) => ({ m: req.method, p: req.params, q: req.query.get('q'), path: req.path }));
    }
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await call(r, m, '/api/items/a%20b/c?q=1')).data).toEqual({
        m,
        p: { id: 'a b', sub: 'c' },
        q: '1',
        path: '/api/items/a%20b/c',
      });
    }
  });

  it('matches a trailing slash and escapes regex characters in static segments', async () => {
    const r = newRouter();
    r.get('/api/a.b', () => 1);
    expect((await call(r, 'GET', '/api/a.b/')).data).toBe(1);
    expect((await call(r, 'GET', '/api/axb')).code).toBe(3007);
  });

  it('exposes headers to handlers', async () => {
    const r = newRouter();
    r.get('/api/h', (req) => req.headers.get('x-test'));
    const res = await dispatch(r, 'GET', '/api/h', { headers: { 'x-test': 'yes' } });
    expect((await res.json()).data).toBe('yes');
  });

  it('maps ApiError and unknown routes', async () => {
    const r = newRouter();
    r.get('/api/x/:id', (req) => {
      throw new ApiError(3006, `bad ${req.params.id}`);
    });
    expect(await call(r, 'GET', '/api/x/7')).toEqual({ code: 3006, msg: 'bad 7', data: '' });
    expect((await call(r, 'POST', '/api/x/7')).code).toBe(3008);
    expect((await call(r, 'GET', '/api/none')).code).toBe(3007);
  });

  it('recognizes ApiError-shaped objects from separately bundled plugins', async () => {
    const r = newRouter();
    r.get('/api/x', () => {
      throw Object.assign(new Error('from plugin'), { name: 'ApiError', code: 40001 });
    });
    expect(await call(r, 'GET', '/api/x')).toEqual({ code: 40001, msg: 'from plugin', data: '' });
  });

  it('maps unknown errors to 30004 without stack in production', async () => {
    const error = vi.fn();
    const r = newRouter({ logger: { warn: () => {}, error } });
    r.get('/api/boom', () => {
      throw new Error('secret detail');
    });
    const body = await call(r, 'GET', '/api/boom');
    expect(body).toEqual({ code: 30004, msg: 'internal error', data: '' });
    expect(error).toHaveBeenCalledOnce();
  });

  it('exposes error message (but not stack) when exposeErrors is on', async () => {
    const r = newRouter({ exposeErrors: true });
    r.get('/api/boom', async () => {
      throw new Error('detail');
    });
    const body = await call(r, 'GET', '/api/boom');
    expect(body.code).toBe(30004);
    expect(body.msg).toBe('Error: detail');
    expect(body.msg).not.toMatch(/\n\s+at /);
  });

  it('passes a Response through untouched', async () => {
    const r = newRouter();
    r.get('/api/file', () => new Response('raw', { status: 201, headers: { 'content-type': 'text/plain' } }));
    const res = await dispatch(r, 'GET', '/api/file');
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('raw');
  });

  it('rejects malformed path params with 3006', async () => {
    const r = newRouter();
    r.get('/api/x/:id', (req) => req.params.id);
    expect((await call(r, 'GET', '/api/x/%E0%A4%A')).code).toBe(3006);
  });

  it('allows reading the body more than once, in any order', async () => {
    const r = newRouter();
    r.post('/api/echo', async (req) => ({ text: await req.text(), json: await req.json() }));
    r.post('/api/echo2', async (req) => ({ json: await req.json(), again: await req.json(), text: await req.text() }));
    expect((await call(r, 'POST', '/api/echo', { a: 1 })).data).toEqual({ text: '{"a":1}', json: { a: 1 } });
    expect((await call(r, 'POST', '/api/echo2', { a: 1 })).data).toEqual({
      json: { a: 1 },
      again: { a: 1 },
      text: '{"a":1}',
    });
  });

  it('returns undefined for an empty JSON body and 30005 for invalid JSON', async () => {
    const r = newRouter();
    r.post('/api/j', async (req) => ({ v: (await req.json()) ?? 'empty' }));
    expect((await call(r, 'POST', '/api/j')).data).toEqual({ v: 'empty' });
    const res = await dispatch(r, 'POST', '/api/j', { body: '{bad' });
    expect((await res.json()).code).toBe(30005);
  });

  it('rejects bodies over the limit by Content-Length (3009)', async () => {
    const handler = vi.fn();
    const r = newRouter({ maxBodyBytes: 4 });
    r.post('/api/up', handler);
    const res = await dispatch(r, 'POST', '/api/up', { body: '12345', headers: { 'content-length': '5' } });
    expect((await res.json()).code).toBe(3009);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects bodies over the limit when actually read (3009)', async () => {
    const r = newRouter({ maxBodyBytes: 4 });
    r.post('/api/up', async (req) => req.text());
    // 不带 Content-Length（例如流式请求体）时，读取后再检查
    const url = new URL('chttp://localhost/api/up');
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('123456'));
        c.close();
      },
    });
    const req = new Request(url, { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect((await (await r.dispatch(req, url)).json()).code).toBe(3009);
    expect((await call(r, 'POST', '/api/up', 'ab')).data).toBe('"ab"');
  });

  it('defaults the body limit to 10 MB', async () => {
    const r = newRouter();
    r.post('/api/up', () => 'ok');
    const over = await dispatch(r, 'POST', '/api/up', { headers: { 'content-length': String(10 * 1024 * 1024 + 1) } });
    expect((await over.json()).code).toBe(3009);
  });

  it('scopes and removes plugin routes', async () => {
    const r = newRouter();
    r.scope('/api/plugins/a').get('/hi', () => 'a');
    r.scope('/api/plugins/ab').get('/hi', () => 'ab');
    r.scope('/api/plugins')
      .scope('/a')
      .post('/x', () => 'nested');
    expect((await call(r, 'GET', '/api/plugins/a/hi')).data).toBe('a');
    expect((await call(r, 'POST', '/api/plugins/a/x')).data).toBe('nested');
    r.removeScope('/api/plugins/a');
    expect((await call(r, 'GET', '/api/plugins/a/hi')).code).toBe(3007);
    expect((await call(r, 'POST', '/api/plugins/a/x')).code).toBe(3007);
    // 前缀相同但不是同一 scope 的路由不受影响
    expect((await call(r, 'GET', '/api/plugins/ab/hi')).data).toBe('ab');
  });

  it('rejects duplicate routes, including across scopes', () => {
    const r = newRouter();
    r.get('/api/a', () => 1);
    expect(() => r.get('/api/a', () => 2)).toThrow(/duplicate/);
    expect(() => r.scope('/api').get('/a', () => 3)).toThrow(/duplicate/);
    // 方法不同不算重复
    expect(() => r.post('/api/a', () => 4)).not.toThrow();
    r.sse('/api/s', () => {});
    expect(() => r.sse('/api/s', () => {})).toThrow(/duplicate/);
    expect(() => r.sse('/api/s', () => {}, 'POST')).not.toThrow();
  });

  it('serves SSE routes with event-stream headers', async () => {
    const r = newRouter({ heartbeatMs: 0 });
    r.sse('/api/s', (_req, sse) => {
      sse.send('hi');
      sse.close();
    });
    const res = await dispatch(r, 'GET', '/api/s');
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe('data: hi\n\n');
  });
});
