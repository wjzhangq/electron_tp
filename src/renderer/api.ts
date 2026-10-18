import { ApiError, type ApiErrorBody } from '@shared/api';

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

/** 非 2xx 响应转为 ApiError；响应体不是 { code, message } 时用状态文本兜底 */
export async function toApiError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | undefined;
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    /* 非 JSON */
  }
  return new ApiError(
    res.status,
    typeof body?.message === 'string' ? body.message : res.statusText || `HTTP ${res.status}`,
    typeof body?.code === 'string' ? body.code : undefined,
  );
}

/** JSON 接口：2xx 返回响应数据（204 为 undefined），否则抛出 ApiError */
export async function request<T>(path: string, init: RequestInit2 = {}): Promise<T> {
  const res = await fetchApi(path, init);
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface SseEvent<T = unknown> {
  event: string;
  data: T;
  id?: string;
}

/**
 * SSE 接口：逐个产出事件；通过 signal 中止或提前 break 即断开连接。
 * 建立连接失败（非 2xx）时抛出 ApiError；流中途的失败以 `event: error` 事件产出，data 为 { code, message }。
 */
export async function* stream<T = unknown>(path: string, init: RequestInit2 = {}): AsyncGenerator<SseEvent<T>> {
  const res = await fetchApi(path, init);
  if (!res.ok) throw await toApiError(res);
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('text/event-stream')) {
    void res.body?.cancel().catch(() => {});
    throw new Error(`expected text/event-stream from ${path}, got "${type}"`);
  }
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value.replace(/\r\n?/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const evt = parseFrame<T>(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        if (evt) yield evt;
      }
    }
    const last = parseFrame<T>(buf);
    if (last) yield last;
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
