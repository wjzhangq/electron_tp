// 不依赖 electron：把 protocol.handle 收到的 Request 经 WirePort 转发给 API 服务进程，并把响应还原为 Response
import { ErrorCodes, type ApiErrorBody } from '@shared/api';
import type { FromServicePort, RequestHead, ToServicePort, WirePort } from '@shared/wire';

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export const unavailable = (message = 'api service unavailable'): Response =>
  new Response(JSON.stringify({ code: ErrorCodes.UNAVAILABLE, message } satisfies ApiErrorBody), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export const toHead = (req: Request): RequestHead => ({
  method: req.method,
  url: req.url,
  headers: [...req.headers],
  hasBody: req.body !== null,
});

export function forward(req: Request, port: WirePort): Promise<Response> {
  return new Promise<Response>((resolve) => {
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
    let waiting: (() => void) | undefined;
    let responded = false;
    let done = false;

    const send = (m: ToServicePort): void => port.postMessage(m);
    const wake = (): void => {
      const w = waiting;
      waiting = undefined;
      w?.();
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      wake();
      port.close();
    };

    port.onMessage((raw) => {
      const m = raw as FromServicePort;
      switch (m.t) {
        case 'head': {
          responded = true;
          if (NULL_BODY_STATUS.has(m.status)) {
            resolve(new Response(null, { status: m.status, headers: m.headers }));
            finish();
            return;
          }
          const body = new ReadableStream<Uint8Array>(
            {
              start: (c) => {
                ctrl = c;
              },
              pull: () => {
                if (done) return;
                return new Promise<void>((r) => {
                  waiting = r;
                  send({ t: 'pull' });
                });
              },
              cancel: () => {
                if (done) return;
                send({ t: 'cancel' });
                finish();
              },
            },
            { highWaterMark: 0 },
          );
          resolve(new Response(body, { status: m.status, headers: m.headers }));
          break;
        }
        case 'chunk':
          ctrl?.enqueue(m.chunk);
          wake();
          break;
        case 'end':
          ctrl?.close();
          finish();
          break;
        case 'error':
          ctrl?.error(new Error(m.message));
          finish();
          break;
      }
    });

    port.onClose(() => {
      if (done) return;
      if (!responded) resolve(unavailable('api service disconnected'));
      else {
        try {
          ctrl?.error(new Error('api service disconnected'));
        } catch {
          /* 已关闭 */
        }
      }
      finish();
    });

    if (req.body) {
      void (async () => {
        try {
          for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
            if (done) return;
            send({ t: 'body', chunk });
          }
          send({ t: 'body-end' });
        } catch {
          if (!done) send({ t: 'body-error' });
        }
      })();
    }
  });
}
