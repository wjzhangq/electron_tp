// 不依赖 electron（FR-RTE-11）
import { Codes, fail, isApiError, ok } from '@shared/api';
import type { ApiRequest, JsonHandler, Logger, Method, RouteRegistrar, SseHandler } from '@app/sdk';
import { SseStreamImpl } from './sse';

interface Route {
  method: Method;
  path: string;
  pattern: RegExp;
  keys: string[];
  kind: 'json' | 'sse';
  handler: JsonHandler | SseHandler;
}

export interface RouterOptions {
  maxBodyBytes: number;
  exposeErrors: boolean;
  heartbeatMs: number;
  /** 单条 SSE 未被消费的缓冲上限（FR-SSE-8） */
  maxSseBufferBytes: number;
  logger: Pick<Logger, 'warn' | 'error'>;
}

export const defaultRouterOptions: RouterOptions = {
  maxBodyBytes: 10 * 1024 * 1024,
  exposeErrors: false,
  heartbeatMs: 15_000,
  maxSseBufferBytes: 16 * 1024 * 1024,
  logger: console,
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** 与 ApiError 字段一致的错误对象（Router 不依赖插件各自打包的 ApiError 类） */
const apiError = (code: number, message: string): Error =>
  Object.assign(new Error(message), { name: 'ApiError', code });

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern: new RegExp(`^${source}/?$`), keys };
}

export class Router implements RouteRegistrar {
  private readonly options: RouterOptions;

  constructor(
    options: Partial<RouterOptions> = {},
    private readonly table: Route[] = [],
    private readonly prefix = '',
  ) {
    this.options = { ...defaultRouterOptions, ...options };
  }

  get(p: string, h: JsonHandler) {
    this.add('GET', p, 'json', h);
  }
  post(p: string, h: JsonHandler) {
    this.add('POST', p, 'json', h);
  }
  put(p: string, h: JsonHandler) {
    this.add('PUT', p, 'json', h);
  }
  patch(p: string, h: JsonHandler) {
    this.add('PATCH', p, 'json', h);
  }
  delete(p: string, h: JsonHandler) {
    this.add('DELETE', p, 'json', h);
  }
  sse(p: string, h: SseHandler, method: Method = 'GET') {
    this.add(method, p, 'sse', h);
  }

  /** 返回共享同一路由表的子路由器 */
  scope(prefix: string): Router {
    return new Router(this.options, this.table, this.prefix + prefix);
  }

  removeScope(prefix: string): void {
    for (let i = this.table.length - 1; i >= 0; i--) {
      const r = this.table[i]!;
      if (r.path === prefix || r.path.startsWith(prefix + '/')) this.table.splice(i, 1);
    }
  }

  private add(method: Method, path: string, kind: Route['kind'], handler: Route['handler']): void {
    const full = this.prefix + path;
    if (this.table.some((r) => r.method === method && r.path === full)) {
      throw new Error(`duplicate route: ${method} ${full}`);
    }
    this.table.push({ method, path: full, kind, handler, ...compile(full) });
  }

  async dispatch(req: Request, url: URL): Promise<Response> {
    let matchedPath = false;
    for (const route of this.table) {
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      matchedPath = true;
      if (route.method !== req.method) continue;

      const length = Number(req.headers.get('content-length') ?? 0);
      if (length > this.options.maxBodyBytes) return json(fail(Codes.PAYLOAD_TOO_LARGE, 'payload too large'));

      const params: Record<string, string> = {};
      try {
        route.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(m[i + 1] ?? '');
        });
      } catch {
        return json(fail(Codes.PARAM_INVALID, 'invalid path parameter encoding')); // FR-RTE-10
      }
      const apiReq = this.toApiRequest(req, url, params);

      return route.kind === 'sse'
        ? this.runSse(route.handler as SseHandler, apiReq)
        : this.runJson(route.handler as JsonHandler, apiReq);
    }
    return matchedPath
      ? json(fail(Codes.METHOD_NOT_ALLOWED, `method ${req.method} not allowed`))
      : json(fail(Codes.NOT_FOUND, `api ${url.pathname} not found`));
  }

  private toApiRequest(req: Request, url: URL, params: Record<string, string>): ApiRequest & { abort(): void } {
    const controller = new AbortController();
    const max = this.options.maxBodyBytes;
    let body: Promise<string> | undefined;
    // FR-RTE-2：请求体只读取一次并缓存
    const readText = (): Promise<string> => {
      body ??= req.text().then((text) => {
        if (Buffer.byteLength(text) > max) throw apiError(Codes.PAYLOAD_TOO_LARGE, 'payload too large');
        return text;
      });
      return body;
    };
    return {
      method: req.method,
      path: url.pathname,
      params,
      query: url.searchParams,
      headers: req.headers,
      signal: controller.signal,
      abort: () => controller.abort(),
      text: readText,
      json: async <T>() => {
        const text = await readText();
        try {
          return (text ? JSON.parse(text) : undefined) as T;
        } catch (e) {
          throw apiError(Codes.JSON_PARSE, `json parse error: ${(e as Error).message}`);
        }
      },
    };
  }

  private toFailure(e: unknown) {
    if (isApiError(e)) return fail(e.code, e.message);
    this.options.logger.error('[api] unhandled error', e);
    return fail(Codes.INTERNAL, this.options.exposeErrors ? String(e) : 'internal error');
  }

  private async runJson(handler: JsonHandler, req: ApiRequest): Promise<Response> {
    try {
      const result = await handler(req);
      if (result instanceof Response) return result;
      return json(ok(result === undefined ? null : result));
    } catch (e) {
      return json(this.toFailure(e));
    }
  }

  private runSse(handler: SseHandler, req: ApiRequest & { abort(): void }): Response {
    const sse = new SseStreamImpl(this.options.heartbeatMs, this.options.maxSseBufferBytes, this.options.logger);
    sse.onClose(() => req.abort());
    void (async () => {
      try {
        await handler(req, sse);
      } catch (e) {
        const f = this.toFailure(e);
        sse.error(f.code, f.msg);
      }
    })();
    return new Response(sse.body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }
}
