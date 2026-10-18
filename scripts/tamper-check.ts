// M4：篡改 app.asar 后断言应用拒绝启动（Fuses EnableEmbeddedAsarIntegrityValidation）
// 用法：先 npm run package（或 make），再 npm run check:tamper
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const EXE_NAME = 'my-app.exe';
const TAMPERED_EXIT_WITHIN_MS = 10_000;
const HEALTHY_ALIVE_AFTER_MS = 5_000;
/** 启动时必定读取的文件；篡改它的内容，确保完整性校验一定会被触发 */
const TARGET_ENTRY = ['.vite', 'build', 'main.cjs'];

function findPackagedDir(): string {
  if (!fs.existsSync(OUT)) throw new Error(`${OUT} not found, run "npm run package" first`);
  const dir = fs
    .readdirSync(OUT, { withFileTypes: true })
    .find((d) => d.isDirectory() && d.name.endsWith('-win32-x64') && fs.existsSync(path.join(OUT, d.name, EXE_NAME)));
  if (!dir) throw new Error(`no *-win32-x64 build containing ${EXE_NAME} under ${OUT}`);
  return path.join(OUT, dir.name);
}

interface AsarFileEntry {
  offset?: string;
  size?: number;
  files?: Record<string, AsarFileEntry>;
}

/** 解析 asar 头部，返回目标文件内容在 app.asar 中的绝对偏移 */
export function locateEntry(asar: Buffer, entry: string[]): { offset: number; size: number } {
  // 布局：[uint32 4][uint32 headerSize][uint32 payloadSize][uint32 jsonLength][json…]，内容从 8 + headerSize 开始
  const headerSize = asar.readUInt32LE(4);
  const jsonLength = asar.readUInt32LE(12);
  const header = JSON.parse(asar.subarray(16, 16 + jsonLength).toString('utf8')) as AsarFileEntry;
  let node: AsarFileEntry | undefined = header;
  for (const part of entry) node = node?.files?.[part];
  if (!node || node.offset === undefined || !node.size) throw new Error(`${entry.join('/')} not found in app.asar`);
  return { offset: 8 + headerSize + Number(node.offset), size: node.size };
}

function copyBuild(src: string, label: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `tamper-${label}-`));
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

function launch(dir: string): ChildProcess {
  return spawn(path.join(dir, EXE_NAME), [], { stdio: 'ignore', windowsHide: true });
}

/** 结束整个进程树（Electron 会派生 GPU / 渲染子进程） */
function killTree(p: ChildProcess): void {
  if (p.pid === undefined || p.exitCode !== null) return;
  spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

function waitExit(p: ChildProcess, ms: number): Promise<number | null | 'timeout'> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    p.once('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('check:tamper must run on Windows');
  const src = findPackagedDir();
  const tampered = copyBuild(src, 'bad');
  const healthy = copyBuild(src, 'good');
  const failures: string[] = [];

  try {
    // 1) 修改篡改版 app.asar 中的一个字节
    const asarPath = path.join(tampered, 'resources', 'app.asar');
    const buf = fs.readFileSync(asarPath);
    const { offset, size } = locateEntry(buf, TARGET_ENTRY);
    const at = offset + Math.floor(size / 2);
    buf[at] = buf[at]! ^ 0xff;
    fs.writeFileSync(asarPath, buf);
    console.log(`[tamper] flipped byte at ${at} of ${asarPath}`);

    // 2) 篡改版必须在 10 秒内退出（两份依次启动，避免单实例锁干扰判定）
    const bad = launch(tampered);
    const badResult = await waitExit(bad, TAMPERED_EXIT_WITHIN_MS);
    if (badResult === 'timeout') {
      killTree(bad);
      failures.push(`tampered build still running after ${TAMPERED_EXIT_WITHIN_MS}ms`);
    } else {
      console.log(`[tamper] tampered build exited with code ${String(badResult)}`);
    }

    // 3) 未篡改版 5 秒后仍在运行
    const good = launch(healthy);
    const goodResult = await waitExit(good, HEALTHY_ALIVE_AFTER_MS);
    if (goodResult === 'timeout') {
      console.log(`[tamper] healthy build still running after ${HEALTHY_ALIVE_AFTER_MS}ms`);
      killTree(good);
      await waitExit(good, 5_000);
    } else {
      failures.push(`healthy build exited early with code ${String(goodResult)}`);
    }
  } finally {
    for (const d of [tampered, healthy]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }

  if (failures.length) {
    for (const f of failures) console.error(`[tamper] FAIL: ${f}`);
    process.exit(1);
  }
  console.log('[tamper] PASS');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
