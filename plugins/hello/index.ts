import { ApiError, Codes, definePlugin } from '@app/sdk';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

export default definePlugin({
  name: 'hello',
  version: '1.0.0',
  setup(router, ctx) {
    // GET /api/plugins/hello/greet?name=Tom
    router.get('/greet', (req) => {
      const who = req.query.get('name');
      if (!who) throw new ApiError(Codes.PARAM_INVALID, 'name is required');
      return { message: `hello, ${who}` };
    });

    // POST /api/plugins/hello/echo   body: {"text":"hi"}
    router.post('/echo', async (req) => {
      const body = await req.json<{ text?: string }>();
      if (typeof body?.text !== 'string') throw new ApiError(40001, 'text must be a string');
      return { text: body.text, length: body.text.length };
    });

    // GET /api/plugins/hello/count?n=5   （SSE）
    router.sse('/count', async (req, sse) => {
      const total = Math.min(Number(req.query.get('n') ?? 5) || 5, 100);
      for (let i = 1; i <= total && !sse.isClosed; i++) {
        sse.send({ i, total }, { event: 'progress', id: String(i) });
        await sleep(500, req.signal);
      }
      if (!sse.isClosed) {
        sse.send({ done: true }, { event: 'complete' });
        sse.close();
      }
    });

    ctx.logger.info('ready');
  },
});
