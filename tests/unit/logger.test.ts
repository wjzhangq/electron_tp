import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dirs: {} as Record<string, string>, isPackaged: false, crashStart: vi.fn() }));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
    getPath: (name: string) => state.dirs[name] ?? os.tmpdir(),
  },
  crashReporter: { start: state.crashStart },
}));

type LoggerModule = typeof import('../../src/main/logger');
let base: string;
let logs: string;

const load = async (): Promise<LoggerModule> => {
  vi.resetModules();
  return import('../../src/main/logger');
};

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
  logs = path.join(base, 'logs');
  state.dirs = { logs, crashDumps: path.join(base, 'crash') };
  state.isPackaged = false;
  for (const lvl of ['debug', 'info', 'warn', 'error'] as const) vi.spyOn(console, lvl).mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

const read = (name: string) => fs.readFileSync(path.join(logs, name), 'utf8');

describe('logger', () => {
  it('writes formatted lines to console and main.log (FR-LOG-1/3)', async () => {
    const m = await load();
    m.initFileLog();
    const log = m.createLogger('mod');
    log.info('hello', { a: 1 }, 42);
    log.error('failed', new Error('boom'));
    m.closeFileLog();
    const lines = read('main.log').trim().split('\n');
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[info\] \[mod\] hello \{ a: 1 \} 42$/);
    expect(lines[1]).toMatch(/\[error\] \[mod\] failed Error: boom/);
    expect(read('main.log')).toMatch(/at /); // Error 保留堆栈
    expect(console.info).toHaveBeenCalledWith('[info] [mod]', 'hello', { a: 1 }, 42);
  });

  it('uses debug level in development and info level when packaged', async () => {
    let m = await load();
    m.initFileLog();
    m.createLogger('dev').debug('visible');
    m.closeFileLog();
    expect(read('main.log')).toContain('[debug] [dev] visible');

    state.isPackaged = true;
    m = await load();
    m.initFileLog();
    m.createLogger('prod').debug('hidden');
    m.createLogger('prod').info('shown');
    m.closeFileLog();
    expect(read('main.log')).not.toContain('hidden');
    expect(read('main.log')).toContain('[info] [prod] shown');
  });

  it('appends to an existing main.log', async () => {
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'main.log'), 'old line\n');
    const m = await load();
    m.initFileLog();
    m.logger.info('new line');
    m.closeFileLog();
    expect(read('main.log')).toMatch(/^old line\n.*new line\n$/);
  });

  it('rotates at 5 MB into main.1.log and main.2.log, keeping at most 3 files (FR-LOG-2)', async () => {
    const m = await load();
    m.initFileLog();
    const log = m.createLogger('r');
    const chunk = 'x'.repeat(1024 * 1024); // 每行约 1 MB
    for (let gen = 0; gen < 4; gen++) {
      for (let i = 0; i < 5; i++) log.info(`gen${gen}`, chunk);
    }
    log.info('last');
    m.closeFileLog();
    expect(fs.readdirSync(logs).sort()).toEqual(['main.1.log', 'main.2.log', 'main.log']);
    for (const f of fs.readdirSync(logs))
      expect(fs.statSync(path.join(logs, f)).size).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(read('main.log')).toContain('last');
    expect(read('main.1.log')).toContain('gen3');
    expect(read('main.2.log')).toContain('gen2');
    // 最旧的一代已被覆盖
    const all = ['main.log', 'main.1.log', 'main.2.log'].map(read).join('');
    expect(all).not.toContain('gen0');
  });

  it('never rotates an empty file even if a single line exceeds the limit', async () => {
    const m = await load();
    m.initFileLog();
    m.logger.info('y'.repeat(6 * 1024 * 1024));
    m.closeFileLog();
    expect(fs.readdirSync(logs)).toEqual(['main.log']);
  });

  it('degrades to console only when the log directory cannot be created', async () => {
    fs.writeFileSync(logs, 'not a directory');
    const m = await load();
    expect(() => m.initFileLog()).not.toThrow();
    expect(() => m.logger.info('still works')).not.toThrow();
    expect(console.info).toHaveBeenCalledWith('[info] [main]', 'still works');
    expect(console.error).toHaveBeenCalledWith('[logger] file log disabled', expect.anything());
  });

  it('degrades to console only when a write fails', async () => {
    const m = await load();
    m.initFileLog();
    m.logger.info('first');
    const spy = vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => m.logger.info('second')).not.toThrow();
    spy.mockRestore();
    m.logger.info('third');
    m.closeFileLog();
    expect(read('main.log')).toContain('first');
    expect(read('main.log')).not.toContain('third');
    expect(console.info).toHaveBeenCalledWith('[info] [main]', 'third');
  });

  it('closeFileLog is safe to call twice', async () => {
    const m = await load();
    m.initFileLog();
    m.closeFileLog();
    expect(() => m.closeFileLog()).not.toThrow();
  });

  it('exposes the log directory', async () => {
    const m = await load();
    expect(m.logDir()).toBe(logs);
  });
});

describe('crash dumps (FR-LOG-5)', () => {
  it('starts the crash reporter without uploading', async () => {
    const m = await load();
    m.startCrashReporter();
    expect(state.crashStart).toHaveBeenCalledWith({ uploadToServer: false });
  });

  it('keeps only the newest 10 .dmp files, recursively', async () => {
    const crash = state.dirs.crashDumps!;
    fs.mkdirSync(path.join(crash, 'reports'), { recursive: true });
    const now = Date.now() / 1000;
    for (let i = 0; i < 14; i++) {
      const p = path.join(crash, i % 2 ? 'reports' : '', `d${i}.dmp`);
      fs.writeFileSync(p, 'x');
      fs.utimesSync(p, now - i * 60, now - i * 60); // d0 最新
    }
    fs.writeFileSync(path.join(crash, 'settings.dat'), 'keep');
    const m = await load();
    m.pruneCrashDumps();
    const left = [...fs.readdirSync(crash), ...fs.readdirSync(path.join(crash, 'reports'))].filter((f) =>
      f.endsWith('.dmp'),
    );
    expect(left.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `d${i}.dmp`).sort());
    expect(fs.existsSync(path.join(crash, 'settings.dat'))).toBe(true);
  });

  it('does nothing when the crash dump directory does not exist', async () => {
    const m = await load();
    expect(() => m.pruneCrashDumps()).not.toThrow();
  });

  it('logs a warning instead of throwing when pruning fails', async () => {
    fs.mkdirSync(state.dirs.crashDumps!, { recursive: true });
    const m = await load();
    vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
      throw new Error('denied');
    });
    expect(() => m.pruneCrashDumps()).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith('[warn] [main]', '[crash] prune failed', expect.any(Error));
  });
});
