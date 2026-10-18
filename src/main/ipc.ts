import { app, ipcMain, nativeTheme, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { ORIGIN, type CloseAction, type InvokeChannels, type SendChannels } from '@shared/ipc';
import { isHttpUrl } from './security';
import { getMainWindow, markQuitting, setPageHandlesClose } from './window';
import { logDir } from './logger';

function assertTrusted(e: IpcMainEvent | IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? '';
  if (!url.startsWith(ORIGIN + '/')) throw new Error(`untrusted ipc sender: ${url}`);
}

function handle<C extends keyof InvokeChannels>(
  channel: C,
  fn: (...args: InvokeChannels[C]['args']) => InvokeChannels[C]['result'] | Promise<InvokeChannels[C]['result']>,
): void {
  ipcMain.handle(channel, (e, ...args) => {
    assertTrusted(e);
    return fn(...(args as InvokeChannels[C]['args']));
  });
}

function on<C extends keyof SendChannels>(channel: C, fn: (...args: SendChannels[C]) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    try {
      assertTrusted(e);
    } catch {
      return;
    }
    fn(...(args as SendChannels[C]));
  });
}

export function registerIpc(): void {
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    arch: process.arch,
    locale: app.getLocale(),
    isDark: nativeTheme.shouldUseDarkColors,
    isPackaged: app.isPackaged,
  }));
  handle('app:open-external', async (url) => {
    if (!isHttpUrl(url)) throw new Error('only http/https urls are allowed');
    await shell.openExternal(url);
  });
  handle('app:toggle-devtools', () => {
    if (!app.isPackaged) getMainWindow()?.webContents.toggleDevTools();
  });
  handle('app:open-logs', async () => {
    const err = await shell.openPath(logDir()); // 成功时返回空字符串
    if (err) throw new Error(err);
  });
  handle('window:minimize', () => {
    getMainWindow()?.minimize();
  });
  handle('window:toggle-maximize', () => {
    const w = getMainWindow();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  handle('window:close', () => {
    getMainWindow()?.close();
  });
  handle('window:close-action', (action: CloseAction) => {
    if (action === 'tray') getMainWindow()?.hide();
    else if (action === 'quit') {
      markQuitting();
      app.quit();
    } else throw new Error(`invalid close action: ${String(action)}`);
  });
  on('window:close-handler', (registered) => setPageHandlesClose(registered === true));
}
