import { afterEach, describe, expect, it, vi } from 'vitest';
import { SseStreamImpl } from '../../src/main/chttp/sse';
import { Router } from '../../src/main/chttp/router';
import { ApiError } from '../../src/shared/api';

const quiet = { warn: () => {}, error: () => {} };
const decoder = new TextDecoder();

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  let out = '';
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += decoder.decode(value);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('SseStreamImpl encoding', () => {
  it('writes strings as-is and other values as JSON', async () => {
    const sse = new SseStreamImpl(0, 1024 * 1024, quiet);
    sse.send('plain');
    sse.send({ a: 1 });
    sse.send(42);
    sse.close();
    expect(await readAll(sse.body)).toBe('data: plain\n\ndata: {"a":1}\n\ndata: 42\n\n');
  });

  it('writes event, id and retry fields', async () => {
    const sse = new SseStreamImpl(0, 1024 * 1024, quiet);
    sse.send({ i: 1, total: 5 }, { event: 'progress', id: '1', retry: 3000 });
    sse.send({ done: true }, { event: 'complete' });
    sse.close();
    expect(await readAll(sse.body)).toBe(
      'event: progress\nid: 1\nretry: 3000\ndata: {"i":1,"total":5}\n\nevent: complete\ndata: {"done":true}\n\n',
    );
  });

  it('splits multi-line data into multiple data: lines', async () => {
    const sse = new SseStreamImpl(0, 1024 * 1024, quiet);
    sse.send('a\nb\r\nc');
    sse.close();
    expect(await readAll(sse.body)).toBe('data: a\ndata: b\ndata: c\n\n');
  });

  it('error() sends an error event and closes', async () => {
    const sse = new SseStreamImpl(0, 1024 * 1024, quiet);
    const onClose = vi.fn();
    sse.onClose(onClose);
    sse.error(30004, 'oops');
    expect(sse.isClosed).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(await readAll(sse.body)).toBe('event: error\ndata: {"code":30004,"msg":"oops"}\n\n');
  });
});

describe('SseStreamImpl lifecycle', () => {
  it('ignores writes after close, close is idempotent, late onClose fires immediately', async () => {
    const sse = new SseStreamImpl(0, 1024 * 1024, quiet);
    const onClose = vi.fn();
    sse.onClose(onClose);
    sse.send('a');
    sse.close();
    sse.close();
    sse.send('b');
    expect(onClose).toHaveBeenCalledOnce();
    const late = vi.fn();
    sse.onClose(late);
    expect(late).toHaveBeenCalledOnce();
    expect(await readAll(sse.body)).toBe('data: a\n\n');
  });

  it('marks closed and runs onClose when the client cancels; callback errors are swallowed', async () => {
    const sse = new SseStreamImpl(0, 1024 * 1024, quiet);
    const onClose = vi.fn();
    sse.onClose(() => {
      throw new Error('ignored');
    });
    sse.onClose(onClose);
    await sse.body.cancel();
    expect(sse.isClosed).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(() => sse.send('x')).not.toThrow();
    expect(() => sse.close()).not.toThrow();
  });

  it('sends a heartbeat comment periodically and stops it on close', async () => {
    vi.useFakeTimers();
    const sse = new SseStreamImpl(15_000, 1024 * 1024, quiet);
    const reader = sse.body.getReader();
    vi.advanceTimersByTime(15_000);
    expect(decoder.decode((await reader.read()).value)).toBe(': ping\n\n');
    vi.advanceTimersByTime(15_000);
    expect(decoder.decode((await reader.read()).value)).toBe(': ping\n\n');
    sse.close();
    expect(vi.getTimerCount()).toBe(0);
    expect((await reader.read()).done).toBe(true);
  });

  it('does not start a heartbeat when heartbeatMs is 0', () => {
    vi.useFakeTimers();
    const sse = new SseStreamImpl(0, 1024 * 1024, quiet);
    expect(vi.getTimerCount()).toBe(0);
    sse.close();
  });

  it('clears the heartbeat when the client disconnects', async () => {
    vi.useFakeTimers();
    const sse = new SseStreamImpl(1000, 1024 * 1024, quiet);
    expect(vi.getTimerCount()).toBe(1);
    await sse.body.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the stream and warns when unconsumed buffer exceeds the limit (FR-SSE-8)', async () => {
    const warn = vi.fn();
    const sse = new SseStreamImpl(0, 100 * 1024, { warn });
    const onClose = vi.fn();
    sse.onClose(onClose);
    const chunk = 'x'.repeat(10 * 1024);
    for (let i = 0; i < 20 && !sse.isClosed; i++) sse.send(chunk); // 没有消费者读取
    expect(sse.isClosed).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/client too slow/));
    // 缓冲被丢弃，读取方收到错误而不是旧数据
    await expect(sse.body.getReader().read()).rejects.toThrow(/sse buffer overflow/);
  });

  it('defaults the buffer limit to 16 MB via Router options', async () => {
    const r = new Router({ logger: quiet, heartbeatMs: 0 });
    let stream: { isClosed: boolean } | undefined;
    r.sse('/api/s', (_req, sse) => {
      stream = sse;
      const chunk = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 15; i++) sse.send(chunk);
    });
    const url = new URL('chttp://localhost/api/s');
    const res = await r.dispatch(new Request(url), url);
    await tick();
    expect(stream?.isClosed).toBe(false);
    await res.body?.cancel();
  });
});

describe('SSE through Router', () => {
  const open = async (r: Router, path = '/api/s') => {
    const url = new URL(`chttp://localhost${path}`);
    return r.dispatch(new Request(url), url);
  };

  it('sends an error event and closes when the handler throws', async () => {
    const r = new Router({ logger: quiet, heartbeatMs: 0 });
    r.sse('/api/s', async (_req, sse) => {
      sse.send({ i: 1 }, { event: 'progress' });
      throw new ApiError(40002, 'nope');
    });
    r.sse('/api/t', () => {
      throw new Error('hidden');
    });
    expect(await (await open(r)).text()).toBe(
      'event: progress\ndata: {"i":1}\n\nevent: error\ndata: {"code":40002,"msg":"nope"}\n\n',
    );
    expect(await (await open(r, '/api/t')).text()).toBe(
      'event: error\ndata: {"code":30004,"msg":"internal error"}\n\n',
    );
  });

  it('aborts req.signal and fires onClose when the client disconnects', async () => {
    const r = new Router({ logger: quiet, heartbeatMs: 0 });
    const onClose = vi.fn();
    let signal: AbortSignal | undefined;
    let isClosed: () => boolean = () => false;
    r.sse('/api/s', (req, sse) => {
      signal = req.signal;
      isClosed = () => sse.isClosed;
      sse.onClose(onClose);
      sse.send('hello'); // 不调用 close：连接保持（FR-SSE-7）
    });
    const res = await open(r);
    const reader = res.body!.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe('data: hello\n\n');
    expect(signal?.aborted).toBe(false);
    expect(isClosed()).toBe(false);
    await reader.cancel();
    expect(signal?.aborted).toBe(true);
    expect(isClosed()).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('supports SSE over POST with a request body', async () => {
    const r = new Router({ logger: quiet, heartbeatMs: 0 });
    r.sse(
      '/api/s',
      async (req, sse) => {
        sse.send(await req.json());
        sse.close();
      },
      'POST',
    );
    const url = new URL('chttp://localhost/api/s');
    const res = await r.dispatch(new Request(url, { method: 'POST', body: '{"q":1}' }), url);
    expect(await res.text()).toBe('data: {"q":1}\n\n');
  });
});
