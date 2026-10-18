// src/sdk/index.ts —— 插件唯一允许导入的内部模块
export { ApiError, Codes } from '@shared/api';

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  /** 客户端断开时中止 */
  readonly signal: AbortSignal;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
}

export interface SseSendOptions {
  event?: string;
  id?: string;
  retry?: number;
}

export interface SseStream {
  readonly isClosed: boolean;
  send(data: unknown, opts?: SseSendOptions): void;
  error(code: number, msg: string): void;
  onClose(cb: () => void): void;
  close(): void;
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type JsonHandler = (req: ApiRequest) => unknown;
export type SseHandler = (req: ApiRequest, sse: SseStream) => void | Promise<void>;

export interface RouteRegistrar {
  get(path: string, h: JsonHandler): void;
  post(path: string, h: JsonHandler): void;
  put(path: string, h: JsonHandler): void;
  patch(path: string, h: JsonHandler): void;
  delete(path: string, h: JsonHandler): void;
  sse(path: string, h: SseHandler, method?: Method): void;
}

export interface Logger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export interface PluginContext {
  readonly name: string;
  readonly logger: Logger;
  readonly app: { readonly version: string; readonly isPackaged: boolean };
}

export interface PluginDefinition {
  name: string;
  version: string;
  setup(router: RouteRegistrar, ctx: PluginContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export const definePlugin = (def: PluginDefinition): PluginDefinition => def;
