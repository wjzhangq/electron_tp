export const Codes = {
  OK: 0,
  BUSINESS: 10001,
  PARAM_INVALID: 3006,
  NOT_FOUND: 3007,
  METHOD_NOT_ALLOWED: 3008,
  PAYLOAD_TOO_LARGE: 3009,
  INTERNAL: 30004,
  JSON_PARSE: 30005,
} as const;

export interface ApiResult<T = unknown> {
  code: number;
  msg: string;
  data: T | '';
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** 插件是独立打包的，各自带一份 ApiError，因此不能用 instanceof 判断，改按字段识别 */
export function isApiError(e: unknown): e is ApiError {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'ApiError' &&
    typeof (e as { code?: unknown }).code === 'number'
  );
}

export const ok = <T>(data: T): ApiResult<T> => ({ code: Codes.OK, msg: 'success', data });
export const fail = (code: number, msg: string): ApiResult<never> => ({ code, msg, data: '' });

export interface TaskInput {
  id: string;
  intervalSec: number;
  data: unknown;
}
export interface TaskState {
  id: string;
  intervalSec: number;
  nextRunAt: number;
}
export interface TaskTick {
  id: string;
  data: unknown;
  nextRunAt: number;
}
export interface PluginStatus {
  name: string;
  version?: string;
  status: 'loaded' | 'failed';
  error?: string;
}
