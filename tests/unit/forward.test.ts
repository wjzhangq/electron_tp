// 主进程 forward() ↔ 服务进程 serve() 经真实的 MessageChannel 端到端联调（用 Node 的 worker_threads 端口代替 MessagePortMain）
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forward, toHead, unavailable } from '../../src/main/chttp/forward';
import { serve } from '../../src/api/serve';
import { Router } from '../../src/api/router';
import type { WirePort } from '../../src/shared/wire';

const quiet = { warn: () => {}, error: () => {} };
const opened: MessagePort[] = [];

function adapt(p: MessagePort): WirePort {
  opened.push(p);
  const closeCbs: Array<() => void> = [];
  let closed = false;
  const fire = () => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs.splice(0)) cb();
  };
  p.on('close', fire);
  return {
    postMessage: (m) => {
      if (!closed) p.postMessage(m);
    },
    onMessage: (cb) => p.on('message', cb),
    onClose: (cb) => (closed ? cb() : closeCbs.push(cb)),
    close: () => {
      p.close();
      fire();
    },
  };
}

afterEach(() => {
  for (const p of opened.splice(0)) p.close();
});

function pipe(router: Pick<Router, 'dispatch'>, req: Request, onError = vi.fn()) {
  const { port1, port2 } = new MessageChannel();
  serve(toHead(req), adapt(port2), router, onError);
  return forward(req, adapt(port1));
}

const url = (p: string) => `chttp://localhost${p}`;

describe('forward ↔ serve', () => {
  it('round-trips status, headers and JSON body', async () => {
    const r = new Router({ logger: quiet });
    r.get('/api/x', (req) => ({ q: req.query.get('q'), h: req.headers.get('x-test') }));
    const res = await pipe(r, new Request(url('/api/x?q=1'), { headers: { 'x-test': 'yes' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ q: '1', h: 'yes' });
  });

  it('streams the request body to the service', async () => {
    const r = new Router({ logger: quiet });
    r.post('/api/echo', async (req) => req.json());
    const res = await pipe(r, new Request(url('/api/echo'), { method: 'POST', body: JSON.stringify({ a: '你好' }) }));
    expect(await res.json()).toEqual({ a: '你好' });
  });

  it('enforces the body limit on the streamed body', async () => {
    const r = new Router({ logger: quiet, maxBodyBytes: 8 });
    r.post('/api/up', async (req) => req.text());
    const body = new ReadableStream({
      start(c) {
        for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode('12345'));
        c.close();
      },
    });
    const res = await pipe(r, new Request(url('/api/up'), { method: 'POST', body, duplex: 'half' } as RequestInit));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('keeps error statuses and returns 204 without a body', async () => {
    const r = new Router({ logger: quiet });
    r.delete('/api/x', () => undefined);
    expect((await pipe(r, new Request(url('/api/none')))).status).toBe(404);
    const res = await pipe(r, new Request(url('/api/x'), { method: 'DELETE' }));
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it('streams SSE chunk by chunk', async () => {
    const r = new Router({ logger: quiet, heartbeatMs: 0 });
    r.sse('/api/s', async (_req, sse) => {
      for (let i = 1; i <= 3; i++) {
        sse.send({ i });
        await new Promise((res) => setTimeout(res, 5));
      }
      sse.close();
    });
    const res = await pipe(r, new Request(url('/api/s')));
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await res.text()).toBe('data: {"i":1}\n\ndata: {"i":2}\n\ndata: {"i":3}\n\n');
  });

  it('only reads from the service when the consumer pulls (backpressure)', async () => {
    const r = new Router({ logger: quiet, heartbeatMs: 0, maxSseBufferBytes: 64 * 1024 * 1024 });
    let sent = 0;
    r.sse('/api/s', (_req, sse) => {
      for (; sent < 50; sent++) sse.send('x');
    });
    const res = await pipe(r, new Request(url('/api/s')));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe('data: x\n\n');
    await new Promise((res) => setTimeout(res, 20));
    expect(sent).toBe(50);
    // 未读取的数据留在服务端，读一次只拿到一块
    expect(decoder.decode((await reader.read()).value)).toBe('data: x\n\n');
    await reader.cancel();
  });

  it('propagates client cancel to the SSE handler (signal + onClose)', async () => {
    const r = new Router({ logger: quiet, heartbeatMs: 0 });
    const onClose = vi.fn();
    let signal: AbortSignal | undefined;
    r.sse('/api/s', (req, sse) => {
      signal = req.signal;
      sse.onClose(onClose);
      sse.send('hello');
    });
    const res = await pipe(r, new Request(url('/api/s')));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(signal?.aborted).toBe(true);
  });

  it('turns a dispatcher crash into 500 INTERNAL', async () => {
    const onError = vi.fn();
    const res = await pipe({ dispatch: () => Promise.reject(new Error('boom')) }, new Request(url('/api/x')), onError);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: 'INTERNAL', message: 'internal error' });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('answers 503 when the service side disconnects before responding', async () => {
    const { port1, port2 } = new MessageChannel();
    const pending = forward(new Request(url('/api/x')), adapt(port1));
    port2.close();
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE', message: 'api service disconnected' });
  });

  it('errors the body when the service disconnects mid-stream', async () => {
    const { port1, port2 } = new MessageChannel();
    const service = adapt(port2);
    const pending = forward(new Request(url('/api/s')), adapt(port1));
    service.postMessage({ t: 'head', status: 200, headers: [['content-type', 'text/event-stream']] });
    const res = await pending;
    const reader = res.body!.getReader();
    const read = reader.read();
    service.close();
    await expect(read).rejects.toThrow(/disconnected/);
  });

  it('builds a 503 UNAVAILABLE body', async () => {
    const res = unavailable();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE', message: 'api service unavailable' });
  });
});
