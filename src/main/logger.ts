// 控制台 + 滚动日志文件 + 本地崩溃转储（FR-LOG-1~5）
import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { app, crashReporter } from 'electron';
import type { Logger } from '@app/sdk';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];
const min = LEVELS.indexOf(app.isPackaged ? 'info' : 'debug');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3; // main.log、main.1.log、main.2.log
const fileName = (i: number): string => (i === 0 ? 'main.log' : `main.${i}.log`);

interface LogFile {
  dir: string;
  fd: number;
  size: number;
}
let file: LogFile | null = null;

export const logDir = (): string => app.getPath('logs');

/** app ready 之后调用；失败时降级为只输出控制台 */
export function initFileLog(): void {
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, fileName(0));
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
    file = { dir, fd: fs.openSync(p, 'a'), size };
  } catch (e) {
    file = null;
    console.error('[logger] file log disabled', e);
  }
}

export function closeFileLog(): void {
  if (!file) return;
  try {
    fs.closeSync(file.fd);
  } catch {
    /* 忽略 */
  }
  file = null;
}

function rotate(f: LogFile): void {
  fs.closeSync(f.fd);
  for (let i = MAX_FILES - 1; i > 0; i--) {
    const from = path.join(f.dir, fileName(i - 1));
    if (fs.existsSync(from)) fs.renameSync(from, path.join(f.dir, fileName(i))); // 覆盖最旧的文件
  }
  f.fd = fs.openSync(path.join(f.dir, fileName(0)), 'a');
  f.size = 0;
}

function writeFile(line: string): void {
  const f = file;
  if (!f) return;
  try {
    const buf = Buffer.from(line + '\n');
    if (f.size > 0 && f.size + buf.byteLength > MAX_BYTES) rotate(f);
    fs.writeSync(f.fd, buf);
    f.size += buf.byteLength;
  } catch (e) {
    file = null; // FR-LOG-3：写失败后降级为只输出控制台
    console.error('[logger] file log disabled', e);
  }
}

const fmt = (a: unknown): string => (typeof a === 'string' ? a : inspect(a, { breakLength: Infinity, depth: 4 }));

export function createLogger(scope: string): Logger {
  const at =
    (lvl: Level) =>
    (...a: unknown[]) => {
      if (LEVELS.indexOf(lvl) < min) return;
      console[lvl](`[${lvl}] [${scope}]`, ...a);
      writeFile(`${new Date().toISOString()} [${lvl}] [${scope}] ${a.map(fmt).join(' ')}`);
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
export const logger = createLogger('main');

/** FR-LOG-5：本地保存崩溃转储，不上传；尽早调用 */
export function startCrashReporter(): void {
  crashReporter.start({ uploadToServer: false });
}

/** FR-LOG-5：只保留最新的 keep 个 .dmp 文件 */
export function pruneCrashDumps(keep = 10): void {
  try {
    const root = app.getPath('crashDumps');
    const dumps: Array<{ p: string; t: number }> = [];
    const walk = (dir: string): void => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else if (d.name.endsWith('.dmp')) dumps.push({ p, t: fs.statSync(p).mtimeMs });
      }
    };
    if (fs.existsSync(root)) walk(root);
    dumps
      .sort((a, b) => b.t - a.t)
      .slice(keep)
      .forEach(({ p }) => fs.rmSync(p, { force: true }));
  } catch (e) {
    logger.warn('[crash] prune failed', e);
  }
}
