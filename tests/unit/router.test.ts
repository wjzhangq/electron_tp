// Router 不依赖 electron，无需 mock
import { describe, expect, it, vi } from 'vitest';
import { Router } from '../../src/api/router';
import { ApiError } from '../../src/shared/api';

const quiet = { warn: () => {}, error: () => {} };
const newRouter = (opts: ConstructorParameters<typeof Router>[0] = {}) => new Router({ logger: quiet, ...opts });

const dispatch = (r: Router, method: string, path: string, init: { body?: string; headers?: HeadersInit } = {}) => {
  const url = new URL(`chttp://localhost${path}`);
  const req = new Request(url, { method, body: init.body, headers: init.headers });
  return r.dispatch(req, url);
};

const call = async (r: Router, method: string, path: string, body?: unknown) => {
  const res = await dispatch(r, method, path, { body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json() };
};

describe('Router', () => {
  it('returns handler data as a 200 JSON body', async () => {
    const r = newRouter();
    r.get('/api/ping', () => ({ pong: true }));
    const res = await dispatch(r, 'GET', '/api/ping');
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ pong: true });
  });

  it('returns 204 without a body for undefined, and JSON null for null', async () => {
    const r = newRouter();
    r.delete('/api/x', () => undefined);
    r.get('/api/n', () => null);
    const res = await dispatch(r, 'DELETE', '/api/x');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(await call(r, 'GET', '/api/n')).toEqual({ status: 200, body: null });
  });

  it('supports all methods, path params and query', async () => {
    const r = newRouter();
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      r[m]('/api/items/:id/:sub', (req) => ({ m: req.method, p: req.params, q: req.query.get('q'), path: req.path }));
    }
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await call(r, m, '/api/items/a%20b/c?q=1')).body).toEqual({
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
    expect((await call(r, 'GET', '/api/a.b/')).body).toBe(1);
    expect((await call(r, 'GET', '/api/axb')).status).toBe(404);
  });

  it('exposes headers to handlers', async () => {
    const r = newRouter();
    r.get('/api/h', (req) => req.headers.get('x-test'));
    const res = await dispatch(r, 'GET', '/api/h', { headers: { 'x-test': 'yes' } });
    expect(await res.json()).toBe('yes');
  });

  it('maps ApiError to its HTTP status with a { code, message } body', async () => {
    const r = newRouter();
    r.get('/api/x/:id', (req) => {
      throw new ApiError(400, `bad ${req.params.id}`);
    });
    r.get('/api/y', () => {
      throw new ApiError(422, 'text invalid', 'TEXT_INVALID');
    });
    expect(await call(r, 'GET', '/api/x/7')).toEqual({ status: 400, body: { code: 'BAD_REQUEST', message: 'bad 7' } });
    expect(await call(r, 'GET', '/api/y')).toEqual({
      status: 422,
      body: { code: 'TEXT_INVALID', message: 'text invalid' },
    });
  });

  it('returns 404 for unknown routes and 405 with Allow for wrong methods', async () => {
    const r = newRouter();
    r.get('/api/x', () => 1);
    r.put('/api/x', () => 1);
    const res = await dispatch(r, 'POST', '/api/x');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, PUT');
    expect(await res.json()).toEqual({ code: 'METHOD_NOT_ALLOWED', message: 'method POST not allowed' });
    expect(await call(r, 'GET', '/api/none')).toEqual({
      status: 404,
      body: { code: 'NOT_FOUND', message: 'api /api/none not found' },
    });
  });

  it('recognizes ApiError-shaped objects from separately bundled plugins', async () => {
    const r = newRouter();
    r.get('/api/x', () => {
      throw Object.assign(new Error('from plugin'), { name: 'ApiError', status: 409, code: 'CONFLICT' });
    });
    expect(await call(r, 'GET', '/api/x')).toEqual({ status: 409, body: { code: 'CONFLICT', message: 'from plugin' } });
  });

  it('maps unknown errors to 500 INTERNAL without details in production', async () => {
    const error = vi.fn();
    const r = newRouter({ logger: { warn: () => {}, error } });
    r.get('/api/boom', () => {
      throw new Error('secret detail');
    });
    expect(await call(r, 'GET', '/api/boom')).toEqual({
      status: 500,
      body: { code: 'INTERNAL', message: 'internal error' },
    });
    expect(error).toHaveBeenCalledOnce();
  });

  it('exposes error message (but not stack) when exposeErrors is on', async () => {
    const r = newRouter({ exposeErrors: true });
    r.get('/api/boom', async () => {
      throw new Error('detail');
    });
    const { status, body } = await call(r, 'GET', '/api/boom');
    expect(status).toBe(500);
    expect(body.message).toBe('Error: detail');
    expect(body.message).not.toMatch(/\n\s+at /);
  });

  it('passes a Response through untouched', async () => {
    const r = newRouter();
    r.get('/api/file', () => new Response('raw', { status: 201, headers: { 'content-type': 'text/plain' } }));
    const res = await dispatch(r, 'GET', '/api/file');
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('raw');
  });

  it('rejects malformed path params with 400', async () => {
    const r = newRouter();
    r.get('/api/x/:id', (req) => req.params.id);
    expect((await call(r, 'GET', '/api/x/%E0%A4%A')).status).toBe(400);
  });

  it('allows reading the body more than once, in any order', async () => {
    const r = newRouter();
    r.post('/api/echo', async (req) => ({ text: await req.text(), json: await req.json() }));
    r.post('/api/echo2', async (req) => ({ json: await req.json(), again: await req.json(), text: await req.text() }));
    expect((await call(r, 'POST', '/api/echo', { a: 1 })).body).toEqual({ text: '{"a":1}', json: { a: 1 } });
    expect((await call(r, 'POST', '/api/echo2', { a: 1 })).body).toEqual({
      json: { a: 1 },
      again: { a: 1 },
      text: '{"a":1}',
    });
  });

  it('decodes multi-byte UTF-8 split across chunks', async () => {
    const r = newRouter();
    r.post('/api/t', async (req) => req.text());
    const bytes = new TextEncoder().encode('你好');
    const url = new URL('chttp://localhost/api/t');
    const body = new ReadableStream({
      start(c) {
        c.enqueue(bytes.slice(0, 2));
        c.enqueue(bytes.slice(2));
        c.close();
      },
    });
    const req = new Request(url, { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect(await (await r.dispatch(req, url)).json()).toBe('你好');
  });

  it('returns undefined for an empty JSON body and 400 INVALID_JSON for invalid JSON', async () => {
    const r = newRouter();
    r.post('/api/j', async (req) => ({ v: (await req.json()) ?? 'empty' }));
    expect((await call(r, 'POST', '/api/j')).body).toEqual({ v: 'empty' });
    const res = await dispatch(r, 'POST', '/api/j', { body: '{bad' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_JSON');
  });

  it('rejects bodies over the limit by Content-Length (413)', async () => {
    const handler = vi.fn();
    const r = newRouter({ maxBodyBytes: 4 });
    r.post('/api/up', handler);
    const res = await dispatch(r, 'POST', '/api/up', { body: '12345', headers: { 'content-length': '5' } });
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('PAYLOAD_TOO_LARGE');
    expect(handler).not.toHaveBeenCalled();
  });

  it('stops reading a streamed body as soon as it exceeds the limit (413)', async () => {
    const r = newRouter({ maxBodyBytes: 4 });
    r.post('/api/up', async (req) => req.text());
    const url = new URL('chttp://localhost/api/up');
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(c) {
        pulled++;
        c.enqueue(new TextEncoder().encode('123'));
        if (pulled > 100) c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request(url, { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect((await r.dispatch(req, url)).status).toBe(413);
    expect(pulled).toBeLessThan(5);
    expect(cancelled).toBe(true);
    expect((await call(r, 'POST', '/api/up', 'ab')).body).toBe('"ab"');
  });

  it('defaults the body limit to 10 MB', async () => {
    const r = newRouter();
    r.post('/api/up', () => 'ok');
    const over = await dispatch(r, 'POST', '/api/up', { headers: { 'content-length': String(10 * 1024 * 1024 + 1) } });
    expect(over.status).toBe(413);
  });

  it('scopes and removes plugin routes', async () => {
    const r = newRouter();
    r.scope('/api/plugins/a').get('/hi', () => 'a');
    r.scope('/api/plugins/ab').get('/hi', () => 'ab');
    r.scope('/api/plugins')
      .scope('/a')
      .post('/x', () => 'nested');
    expect((await call(r, 'GET', '/api/plugins/a/hi')).body).toBe('a');
    expect((await call(r, 'POST', '/api/plugins/a/x')).body).toBe('nested');
    r.removeScope('/api/plugins/a');
    expect((await call(r, 'GET', '/api/plugins/a/hi')).status).toBe(404);
    expect((await call(r, 'POST', '/api/plugins/a/x')).status).toBe(404);
    // 前缀相同但不是同一 scope 的路由不受影响
    expect((await call(r, 'GET', '/api/plugins/ab/hi')).body).toBe('ab');
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
