import type { Logger, SseSendOptions, SseStream } from '@app/sdk';

const encoder = new TextEncoder();
const HIGH_WATER_MARK = 64 * 1024;

export class SseStreamImpl implements SseStream {
  readonly body: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private closed = false;
  private readonly closeCallbacks: Array<() => void> = [];
  private readonly heartbeat?: NodeJS.Timeout;

  constructor(
    heartbeatMs: number,
    private readonly maxBufferBytes: number,
    private readonly logger: Pick<Logger, 'warn'>,
  ) {
    this.body = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          this.controller = c;
        },
        cancel: () => this.finish(), // 客户端断开
      },
      { highWaterMark: HIGH_WATER_MARK, size: (chunk) => chunk.byteLength },
    );
    if (heartbeatMs > 0) this.heartbeat = setInterval(() => this.write(': ping\n\n'), heartbeatMs);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(data: unknown, opts: SseSendOptions = {}): void {
    const lines: string[] = [];
    if (opts.event) lines.push(`event: ${opts.event}`);
    if (opts.id) lines.push(`id: ${opts.id}`);
    if (opts.retry !== undefined) lines.push(`retry: ${opts.retry}`);
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    for (const line of text.split(/\r?\n/)) lines.push(`data: ${line}`);
    this.write(lines.join('\n') + '\n\n');
  }

  error(code: number, msg: string): void {
    this.send({ code, msg }, { event: 'error' });
    this.close();
  }

  onClose(cb: () => void): void {
    if (this.closed) cb();
    else this.closeCallbacks.push(cb);
  }

  close(): void {
    if (this.closed) return;
    try {
      this.controller.close();
    } catch {
      /* 已被取消 */
    }
    this.finish();
  }

  private write(chunk: string): void {
    if (this.closed) return;
    try {
      this.controller.enqueue(encoder.encode(chunk));
    } catch {
      this.finish();
      return;
    }
    // FR-SSE-8：desiredSize = 高水位 - 已排队字节数
    const queued = HIGH_WATER_MARK - (this.controller.desiredSize ?? 0);
    if (queued > this.maxBufferBytes) {
      this.logger.warn(`[sse] client too slow, ${queued} bytes buffered, closing stream`);
      try {
        this.controller.error(new Error('sse buffer overflow')); // error() 会丢弃缓冲
      } catch {
        /* 忽略 */
      }
      this.finish();
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const cb of this.closeCallbacks.splice(0)) {
      try {
        cb();
      } catch {
        /* 忽略回调异常 */
      }
    }
  }
}
