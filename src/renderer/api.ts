import { ApiError, Codes, type ApiResult } from '@shared/api';

type Query = Record<string, string | number | boolean>;
interface RequestInit2 {
  method?: string;
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: Query): string {
  const url = new URL(`/api${path}`, location.origin);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  return url.toString();
}

function fetchApi(path: string, init: RequestInit2): Promise<Response> {
  const hasBody = init.body !== undefined;
  return fetch(buildUrl(path, init.query), {
    method: init.method ?? (hasBody ? 'POST' : 'GET'),
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
}

/** JSON 接口：code 为 0 时返回 data，否则抛出 ApiError */
export async function request<T>(path: string, init: RequestInit2 = {}): Promise<T> {
  const res = await fetchApi(path, init);
  const r = (await res.json()) as ApiResult<T>;
  if (r.code !== Codes.OK) throw new ApiError(r.code, r.msg);
  return r.data as T;
}

export interface SseEvent<T = unknown> {
  event: string;
  data: T;
  id?: string;
}

/** SSE 接口：逐个产出事件；通过 signal 中止即断开连接 */
export async function* stream<T = unknown>(path: string, init: RequestInit2 = {}): AsyncGenerator<SseEvent<T>> {
  const res = await fetchApi(path, init);
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const evt = parseFrame<T>(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        if (evt) yield evt;
      }
    }
  } finally {
    // 调用方提前 break 时主动断开连接
    void reader.cancel().catch(() => {});
  }
}

export function parseFrame<T>(raw: string): SseEvent<T> | null {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue; // 心跳或注释
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  if (data.length === 0) return null;
  const text = data.join('\n');
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 非 JSON 时保留原文 */
  }
  return { event, data: parsed as T, id };
}
