import { MessageChannelMain, utilityProcess, type UtilityProcess } from 'electron';
import type { PluginStatus } from '@shared/api';
import { wrapPort, type ApiServiceConfig, type FromService, type ToService, type WirePort } from '@shared/wire';
import { createLogger } from '../logger';
import { forward, toHead, unavailable } from './forward';

const log = createLogger('api-host');

export interface ApiHostOptions {
  entry: string;
  config: ApiServiceConfig;
  /** 窗口期内允许的最大自动重启次数，超过后保持不可用（503） */
  maxRestarts?: number;
  restartWindowMs?: number;
  restartDelayMs?: number;
  disposeTimeoutMs?: number;
}

/** 管理 API 服务进程（utilityProcess）：启动、转发请求、崩溃后有限次重启、退出前清理 */
export class ApiHost {
  private child: UtilityProcess | undefined;
  private ready: Promise<UtilityProcess> = Promise.reject(new Error('api service not started'));
  private readonly inflight = new Set<WirePort & { disconnect(): void }>();
  private restarts: number[] = [];
  private stopping = false;
  private readonly loggers = new Map<string, ReturnType<typeof createLogger>>();

  constructor(private readonly opts: ApiHostOptions) {
    this.ready.catch(() => {});
  }

  /** 首次启动；内置路由注册失败等致命错误时 reject */
  start(): Promise<PluginStatus[]> {
    return this.spawn();
  }

  async handle(req: Request): Promise<Response> {
    let child: UtilityProcess;
    try {
      child = await this.ready;
    } catch {
      return unavailable();
    }
    const { port1, port2 } = new MessageChannelMain();
    const port = wrapPort(port1);
    this.inflight.add(port);
    port.onClose(() => this.inflight.delete(port));
    try {
      child.postMessage({ type: 'request', head: toHead(req) } satisfies ToService, [port2]);
    } catch {
      port.close();
      return unavailable();
    }
    return forward(req, port);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    const timeout = this.opts.disposeTimeoutMs ?? 4000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        log.warn(`api service did not exit within ${timeout}ms, killing`);
        child.kill();
        resolve();
      }, timeout);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.postMessage({ type: 'dispose' } satisfies ToService);
      } catch {
        child.kill();
      }
    });
  }

  private spawn(): Promise<PluginStatus[]> {
    const child = utilityProcess.fork(this.opts.entry, [], { serviceName: 'API Service', stdio: 'inherit' });
    this.child = child;
    let settled = false;
    let fatal = false;

    const started = new Promise<PluginStatus[]>((resolve, reject) => {
      child.on('message', (raw: FromService) => {
        switch (raw.type) {
          case 'log':
            this.loggerFor(raw.scope)[raw.level](raw.text);
            break;
          case 'ready':
            settled = true;
            resolve(raw.plugins);
            break;
          case 'fatal':
            settled = true;
            fatal = true;
            log.error('api service failed to start', raw.error);
            reject(new Error(raw.error));
            child.kill();
            break;
        }
      });
      child.once('exit', (code) => {
        for (const p of this.inflight) p.disconnect();
        this.inflight.clear();
        if (this.child === child) this.child = undefined;
        if (!settled) {
          settled = true;
          reject(new Error(`api service exited during startup with code ${code}`));
          return;
        }
        if (this.stopping || fatal) return;
        log.error(`api service exited unexpectedly with code ${code}`);
        this.restart();
      });
    });

    this.ready = started.then(() => child);
    this.ready.catch(() => {});
    child.postMessage({ type: 'init', config: this.opts.config } satisfies ToService);
    return started;
  }

  private restart(): void {
    const now = Date.now();
    const windowMs = this.opts.restartWindowMs ?? 60_000;
    this.restarts = this.restarts.filter((t) => now - t < windowMs);
    if (this.restarts.length >= (this.opts.maxRestarts ?? 3)) {
      log.error('api service restarted too often, giving up');
      this.ready = Promise.reject(new Error('api service unavailable'));
      this.ready.catch(() => {});
      return;
    }
    this.restarts.push(now);
    const delay = this.opts.restartDelayMs ?? 500;
    this.ready = new Promise<void>((r) => setTimeout(r, delay)).then(async () => {
      if (this.stopping) throw new Error('stopping');
      await this.spawn();
      return this.child!;
    });
    this.ready.then(
      () => log.info('api service restarted'),
      (e) => log.error('api service restart failed', e),
    );
  }

  private loggerFor(scope: string) {
    let l = this.loggers.get(scope);
    if (!l) this.loggers.set(scope, (l = createLogger(scope)));
    return l;
  }
}
