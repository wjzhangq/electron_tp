// 主进程 ↔ API 服务进程（utilityProcess）之间的消息格式
import type { MessagePortMain } from 'electron';
import type { PluginStatus } from './api';

export type HeaderList = Array<[string, string]>;

export interface ApiServiceConfig {
  pluginRoot: string;
  exposeErrors: boolean;
  app: { version: string; isPackaged: boolean };
}

export interface RequestHead {
  method: string;
  url: string;
  headers: HeaderList;
  hasBody: boolean;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 主进程 → 服务进程（parentPort） */
export type ToService =
  { type: 'init'; config: ApiServiceConfig } | { type: 'request'; head: RequestHead } | { type: 'dispose' };

/** 服务进程 → 主进程（parentPort） */
export type FromService =
  | { type: 'ready'; plugins: PluginStatus[] }
  | { type: 'fatal'; error: string }
  | { type: 'log'; level: LogLevel; scope: string; text: string };

/**
 * 单个请求独占一对 MessagePort。响应体按拉取传输：主进程每要一块发一次 pull，
 * 服务进程才从 Response.body 读一块，慢消费者的积压留在服务进程的 SSE 缓冲里（FR-SSE-8 照常生效）。
 */
export type ToServicePort =
  { t: 'body'; chunk: Uint8Array } | { t: 'body-end' } | { t: 'body-error' } | { t: 'pull' } | { t: 'cancel' };

export type FromServicePort =
  | { t: 'head'; status: number; headers: HeaderList }
  | { t: 'chunk'; chunk: Uint8Array }
  | { t: 'end' }
  | { t: 'error'; message: string };

/** 与具体 MessagePort 实现无关的最小接口，便于单元测试 */
export interface WirePort {
  postMessage(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  /** 本端 close() 或对端断开（包括对端进程退出）时触发一次 */
  onClose(cb: () => void): void;
  close(): void;
}

export function wrapPort(port: MessagePortMain): WirePort & { disconnect(): void } {
  const closeCbs: Array<() => void> = [];
  let closed = false;
  const fire = (): void => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs.splice(0)) cb();
  };
  port.on('close', fire);
  return {
    postMessage: (msg) => {
      if (!closed) port.postMessage(msg);
    },
    onMessage: (cb) => {
      port.on('message', (e) => cb(e.data));
      port.start();
    },
    onClose: (cb) => {
      if (closed) cb();
      else closeCbs.push(cb);
    },
    close: () => {
      port.close();
      fire();
    },
    disconnect: fire,
  };
}
