import path from 'node:path';
import { app, BrowserWindow, Menu, nativeTheme, screen } from 'electron';
import { ORIGIN } from '@shared/ipc';

let win: BrowserWindow | null = null;
let quitting = false;
let pageHandlesClose = false;

export const getMainWindow = () => win;
export const markQuitting = () => {
  quitting = true;
};
export const setPageHandlesClose = (v: boolean) => {
  pageHandlesClose = v;
};

export function showMainWindow(): void {
  if (!win || win.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function createMainWindow(): BrowserWindow {
  // FR-WIN-3：初始尺寸；不记住尺寸和位置
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const [width, height] = sw > 1800 ? [Math.round(sw * 0.5), Math.round(sh * 0.8)] : [1080, 720];

  const w = new BrowserWindow({
    width,
    height,
    minWidth: 960,
    minHeight: 640,
    center: true,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
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
  win = w;

  // FR-WIN-4：ready-to-show 之后才显示
  w.once('ready-to-show', () => w.show());

  // 3.6 关闭流程
  w.on('close', (e) => {
    if (quitting || !pageHandlesClose) {
      quitting = true;
      return;
    }
    e.preventDefault();
    w.webContents.send('window:close-requested');
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });

  // 页面重新加载或崩溃后，必须重新注册关闭监听，避免窗口无法关闭
  w.webContents.on('did-start-loading', () => setPageHandlesClose(false));
  w.webContents.on('render-process-gone', () => setPageHandlesClose(false));

  w.on('maximize', () => w.webContents.send('window:maximize-changed', true));
  w.on('unmaximize', () => w.webContents.send('window:maximize-changed', false));

  // FR-WIN-8：复制、全选；可编辑区域额外提供剪切、粘贴
  w.webContents.on('context-menu', (_e, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [{ role: 'copy' }, { role: 'selectAll' }];
    if (params.isEditable) items.unshift({ role: 'cut' }, { role: 'paste' });
    Menu.buildFromTemplate(items).popup({ window: w });
  });

  void w.loadURL(`${ORIGIN}/`);
  return w;
}

nativeTheme.on('updated', () => {
  if (win && !win.isDestroyed()) win.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors);
});

app.on('before-quit', () => {
  quitting = true;
});
