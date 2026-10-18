import path from 'node:path';
import {
  app,
  BrowserWindow,
  Menu,
  nativeTheme,
  screen,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from 'electron';
import { ORIGIN } from '@shared/ipc';
import { createLogger } from './logger';

const log = createLogger('window');

/** 页面注册了关闭接管后，preload 必须在这段时间内回执，否则视为页面卡死，直接关闭 */
export const CLOSE_ACK_TIMEOUT_MS = 1500;

interface WindowState {
  /** 页面通过 onCloseRequested 接管了关闭 */
  handlesClose: boolean;
  /** Chromium 报告页面无响应（unresponsive / responsive 事件） */
  unresponsive: boolean;
  /** 已决定不再接管，下一次 close 直接放行 */
  forceClose: boolean;
  ackTimer?: NodeJS.Timeout;
}

const states = new WeakMap<BrowserWindow, WindowState>();
let mainWindow: BrowserWindow | null = null;
let quitting = false;

export const getMainWindow = (): BrowserWindow | null => mainWindow;
export const windowOf = (wc: WebContents): BrowserWindow | null => BrowserWindow.fromWebContents(wc);
export const markQuitting = (): void => {
  quitting = true;
};

export function setHandlesClose(w: BrowserWindow, handles: boolean): void {
  const s = states.get(w);
  if (s) s.handlesClose = handles;
}

export function acknowledgeClose(w: BrowserWindow): void {
  const s = states.get(w);
  if (s?.ackTimer) {
    clearTimeout(s.ackTimer);
    s.ackTimer = undefined;
  }
}

function forceClose(w: BrowserWindow, reason: string): void {
  const s = states.get(w);
  if (!s || w.isDestroyed()) return;
  log.warn(`closing window ${w.id} without page handling: ${reason}`);
  s.forceClose = true;
  w.close();
}

function resetPage(s: WindowState): void {
  s.handlesClose = false;
  s.unresponsive = false;
  if (s.ackTimer) clearTimeout(s.ackTimer);
  s.ackTimer = undefined;
}

export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 所有窗口都经由这里创建：统一的安全选项、关闭流程、右键菜单与最大化事件 */
export function createWindow(opts: { path?: string; options?: BrowserWindowConstructorOptions } = {}): BrowserWindow {
  const w = new BrowserWindow({
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    ...opts.options,
    webPreferences: {
      // Forge Vite 插件把 preload 输出为 .vite/build/preload.cjs（见 vite.preload.config.ts）
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const s: WindowState = { handlesClose: false, unresponsive: false, forceClose: false };
  states.set(w, s);

  // FR-WIN-4：ready-to-show 之后才显示
  w.once('ready-to-show', () => w.show());

  // 3.6 关闭流程：页面卡死（无响应或没有及时回执）时不接管，直接关闭
  w.on('close', (e) => {
    if (quitting || s.forceClose || !s.handlesClose || s.unresponsive || w.webContents.isCrashed()) return;
    e.preventDefault();
    if (s.ackTimer) return; // 上一次请求还在等回执
    s.ackTimer = setTimeout(() => {
      s.ackTimer = undefined;
      forceClose(w, `no close acknowledgement within ${CLOSE_ACK_TIMEOUT_MS}ms`);
    }, CLOSE_ACK_TIMEOUT_MS);
    w.webContents.send('window:close-requested');
  });
  w.on('closed', () => {
    if (s.ackTimer) clearTimeout(s.ackTimer);
    if (mainWindow === w) mainWindow = null;
  });

  w.on('unresponsive', () => {
    s.unresponsive = true;
  });
  w.on('responsive', () => {
    s.unresponsive = false;
  });

  // 页面重新加载、导航或崩溃后，必须重新注册关闭监听，避免窗口无法关闭
  w.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) resetPage(s);
  });
  w.webContents.on('render-process-gone', () => resetPage(s));

  w.on('maximize', () => w.webContents.send('window:maximize-changed', true));
  w.on('unmaximize', () => w.webContents.send('window:maximize-changed', false));

  // FR-WIN-8：复制、全选；可编辑区域额外提供剪切、粘贴
  w.webContents.on('context-menu', (_e, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [{ role: 'copy' }, { role: 'selectAll' }];
    if (params.isEditable) items.unshift({ role: 'cut' }, { role: 'paste' });
    Menu.buildFromTemplate(items).popup({ window: w });
  });

  void w.loadURL(`${ORIGIN}${opts.path ?? '/'}`);
  return w;
}

export function createMainWindow(): BrowserWindow {
  // FR-WIN-3：初始尺寸；不记住尺寸和位置
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const [width, height] = sw > 1800 ? [Math.round(sw * 0.5), Math.round(sh * 0.8)] : [1080, 720];
  mainWindow = createWindow({ options: { width, height, minWidth: 960, minHeight: 640, center: true } });
  return mainWindow;
}

nativeTheme.on('updated', () => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors);
  }
});

app.on('before-quit', () => {
  quitting = true;
});
