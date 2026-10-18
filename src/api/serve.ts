import { ErrorCodes } from '@shared/api';
import type { FromServicePort, RequestHead, ToServicePort, WirePort } from '@shared/wire';
import { errorResponse } from './router';

export interface Dispatcher {
  dispatch(req: Request, url: URL): Promise<Response>;
}

/** 在服务进程中处理一次经 MessagePort 转发来的请求 */
export function serve(head: RequestHead, port: WirePort, router: Dispatcher, onError: (e: unknown) => void): void {
  let bodyCtrl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = head.hasBody
    ? new ReadableStream<Uint8Array>({
        start: (c) => {
          bodyCtrl = c;
        },
      })
    : null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed = false;
  let pulls = 0;
  let pumping = false;

  const post = (m: FromServicePort): void => port.postMessage(m);
  const finish = (): void => {
    if (closed) return;
    closed = true;
    port.close();
  };
  const cancel = (): void => {
    if (closed) return;
    closed = true;
    try {
      bodyCtrl?.error(new Error('request cancelled'));
    } catch {
      /* 已结束 */
    }
    void reader?.cancel().catch(() => {});
    port.close();
  };

  const pump = async (): Promise<void> => {
    if (pumping || !reader) return;
    pumping = true;
    try {
      while (pulls > 0 && !closed) {
        pulls--;
        const { value, done } = await reader.read();
        if (closed) return;
        if (done) {
          post({ t: 'end' });
          finish();
          return;
        }
        post({ t: 'chunk', chunk: value });
      }
    } catch (e) {
      if (!closed) {
        post({ t: 'error', message: String(e) });
        finish();
      }
    } finally {
      pumping = false;
    }
  };

  port.onMessage((raw) => {
    const m = raw as ToServicePort;
    try {
      switch (m.t) {
        case 'body':
          bodyCtrl?.enqueue(m.chunk);
          break;
        case 'body-end':
          bodyCtrl?.close();
          break;
        case 'body-error':
          bodyCtrl?.error(new Error('request body aborted'));
          break;
        case 'pull':
          pulls++;
          void pump();
          break;
        case 'cancel':
          cancel();
          break;
      }
    } catch {
      /* 请求体已被关闭或取消 */
    }
  });
  port.onClose(cancel);

  void (async () => {
    let res: Response;
    try {
      const url = new URL(head.url);
      const req = new Request(url, {
        method: head.method,
        headers: head.headers,
        body,
        duplex: 'half',
      } as RequestInit);
      res = await router.dispatch(req, url);
    } catch (e) {
      onError(e);
      res = errorResponse(500, ErrorCodes.INTERNAL, 'internal error');
    }
    if (closed) {
      void res.body?.cancel().catch(() => {});
      return;
    }
    post({ t: 'head', status: res.status, headers: [...res.headers] });
    if (!res.body) {
      post({ t: 'end' });
      finish();
      return;
    }
    reader = res.body.getReader();
    void pump();
  })();
}
