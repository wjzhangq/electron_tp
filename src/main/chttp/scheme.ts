import { protocol } from 'electron';
import { Codes, fail } from '@shared/api';
import { ORIGIN } from '@shared/ipc';
import type { Router } from './router';
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

const isApiPath = (p: string): boolean => p === '/api' || p.startsWith('/api/');

export function handleChttp(router: Router, serveStatic: StaticHandler): void {
  protocol.handle(SCHEME, async (req) => {
    let api = false;
    try {
      const url = new URL(req.url);
      if (url.host !== HOST) return new Response('Not Found', { status: 404 });

      const origin = req.headers.get('origin');
      if (origin && origin !== ORIGIN) return new Response('Forbidden', { status: 403 });

      api = isApiPath(url.pathname);
      return api ? await router.dispatch(req, url) : await serveStatic(req, url);
    } catch (e) {
      // FR-RTE-10：任何未捕获异常都转为响应，不让请求以网络错误结束
      logger.error('[chttp] unhandled error', e);
      return api
        ? new Response(JSON.stringify(fail(Codes.INTERNAL, 'internal error')), {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
          })
        : new Response('Internal Server Error', { status: 500 });
    }
  });
}
