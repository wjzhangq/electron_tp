/**
 * 错误模型：成败只由 HTTP 状态码表达（2xx 成功，4xx/5xx 失败）。
 * 失败响应体统一为 { code, message }；code 是唯一的一套机器可读码（大写下划线字符串），
 * 不传时由状态码推导，插件只在需要区分同一状态下的不同原因时才自定义。
 */
export const ErrorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  INVALID_JSON: 'INVALID_JSON',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNPROCESSABLE: 'UNPROCESSABLE',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  INTERNAL: 'INTERNAL',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

const STATUS_CODES: Record<number, string> = {
  400: ErrorCodes.BAD_REQUEST,
  401: ErrorCodes.UNAUTHORIZED,
  403: ErrorCodes.FORBIDDEN,
  404: ErrorCodes.NOT_FOUND,
  405: ErrorCodes.METHOD_NOT_ALLOWED,
  409: ErrorCodes.CONFLICT,
  413: ErrorCodes.PAYLOAD_TOO_LARGE,
  422: ErrorCodes.UNPROCESSABLE,
  429: ErrorCodes.TOO_MANY_REQUESTS,
  500: ErrorCodes.INTERNAL,
  503: ErrorCodes.UNAVAILABLE,
};

export const codeForStatus = (status: number): string =>
  STATUS_CODES[status] ?? (status >= 500 ? ErrorCodes.INTERNAL : ErrorCodes.BAD_REQUEST);

export interface ApiErrorBody {
  code: string;
  message: string;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: string;

  /** @param status 4xx/5xx */
  constructor(
    readonly status: number,
    message: string,
    code?: string,
  ) {
    super(message);
    this.code = code ?? codeForStatus(status);
  }
}

/** 插件是独立打包的，各自带一份 ApiError，因此不能用 instanceof 判断，改按字段识别 */
export function isApiError(e: unknown): e is ApiError {
  if (typeof e !== 'object' || e === null) return false;
  const { name, status, code } = e as { name?: unknown; status?: unknown; code?: unknown };
  return (
    name === 'ApiError' &&
    typeof code === 'string' &&
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 599
  );
}

export interface PluginStatus {
  name: string;
  version?: string;
  status: 'loaded' | 'failed';
  error?: string;
}
