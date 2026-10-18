import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request, stream } from '../../src/renderer/api';
import { createLogger } from '../../src/api/log';

const enc = new TextEncoder();
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', { origin: 'chttp://localhost' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const sseResponse = (chunks: string[], status = 200) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );

const collect = async <T>(it: AsyncGenerator<T>) => {
  const out: T[] = [];
  for await (const e of it) out.push(e);
  return out;
};

describe('request()', () => {
  it('sends JSON bodies as POST with query parameters and returns the body', async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: 1 }));
    expect(await request('/x', { body: { a: 1 }, query: { q: 'v', n: 2 } })).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('chttp://localhost/api/x?q=v&n=2');
    expect(init).toMatchObject({ method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });
  });

  it('returns undefined for 204 and throws ApiError for non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await request('/x', { method: 'DELETE' })).toBeUndefined();
    fetchMock.mockResolvedValueOnce(Response.json({ code: 'NOT_FOUND', message: 'nope' }, { status: 404 }));
    await expect(request('/x')).rejects.toMatchObject({ name: 'ApiError', status: 404, code: 'NOT_FOUND' });
  });
});

describe('stream()', () => {
  it('yields events across chunk boundaries and flushes a trailing frame without a blank line', async () => {
    fetchMock.mockResolvedValue(sseResponse(['event: a\r\nda', 'ta: {"i":1}\r\n\r\n: ping\n\n', 'data: last']));
    expect(await collect(stream('/s'))).toEqual([
      { event: 'a', data: { i: 1 }, id: undefined },
      { event: 'message', data: 'last', id: undefined },
    ]);
  });

  it('throws ApiError when the connection is rejected', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ code: 'METHOD_NOT_ALLOWED', message: 'method GET not allowed' }, { status: 405 }),
    );
    await expect(collect(stream('/s'))).rejects.toMatchObject({ status: 405, code: 'METHOD_NOT_ALLOWED' });
  });

  it('throws instead of silently ending when the response is not an event stream', async () => {
    fetchMock.mockResolvedValue(Response.json({ a: 1 }));
    await expect(collect(stream('/s'))).rejects.toThrow(/expected text\/event-stream/);
  });

  it('cancels the connection when the caller breaks early', async () => {
    let cancelled = false;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode('data: 1\n\n'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    for await (const _ of stream('/s')) break;
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
});

describe('API service logger', () => {
  it('formats arguments and posts them to the main process', () => {
    const post = vi.fn();
    const log = createLogger('plugin:x', post);
    log.warn('a', { b: 1 }, 2);
    log.debug('d');
    expect(post).toHaveBeenNthCalledWith(1, { type: 'log', level: 'warn', scope: 'plugin:x', text: 'a { b: 1 } 2' });
    expect(post).toHaveBeenNthCalledWith(2, { type: 'log', level: 'debug', scope: 'plugin:x', text: 'd' });
  });
});
