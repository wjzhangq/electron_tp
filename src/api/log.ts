// 服务进程不直接写文件：格式化后交给主进程的 logger（与主进程共用同一个滚动日志文件）
import { inspect } from 'node:util';
import type { Logger } from '@app/sdk';
import type { FromService, LogLevel } from '@shared/wire';

const fmt = (a: unknown): string => (typeof a === 'string' ? a : inspect(a, { breakLength: Infinity, depth: 4 }));

export function createLogger(scope: string, post: (m: FromService) => void): Logger {
  const at =
    (level: LogLevel) =>
    (...a: unknown[]) =>
      post({ type: 'log', level, scope, text: a.map(fmt).join(' ') });
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
