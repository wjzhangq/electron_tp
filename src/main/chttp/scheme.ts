import { protocol } from 'electron';
import { ErrorCodes, type ApiErrorBody } from '@shared/api';
import { ORIGIN } from '@shared/ipc';
import { logger } from '../logger';

export const SCHEME = 'chttp';
export const HOST = 'localhost';

/** 必须在 app ready 之前调用 */
export function registerChttpScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ]);
}

export type StaticHandler = (req: Request, url: URL) => Promise<Response>;
export type ApiHandler = (req: Request) => Promise<Response>;

const isApiPath = (p: string): boolean => p === '/api' || p.startsWith('/api/');

/** 主进程只做主机名 / Origin 校验与分发：/api 转发给 API 服务进程，其余由静态资源处理 */
export function handleChttp(api: ApiHandler, serveStatic: StaticHandler): void {
  protocol.handle(SCHEME, async (req) => {
    let isApi = false;
    try {
      const url = new URL(req.url);
      if (url.host !== HOST) return new Response('Not Found', { status: 404 });

      const origin = req.headers.get('origin');
      if (origin && origin !== ORIGIN) return new Response('Forbidden', { status: 403 });

      isApi = isApiPath(url.pathname);
      return isApi ? await api(req) : await serveStatic(req, url);
    } catch (e) {
      // FR-RTE-10：任何未捕获异常都转为响应，不让请求以网络错误结束
      logger.error('[chttp] unhandled error', e);
      return isApi
        ? new Response(
            JSON.stringify({ code: ErrorCodes.INTERNAL, message: 'internal error' } satisfies ApiErrorBody),
            {
              status: 500,
              headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
            },
          )
        : new Response('Internal Server Error', { status: 500 });
    }
  });
}
