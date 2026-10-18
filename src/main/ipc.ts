import {
  app,
  ipcMain,
  nativeTheme,
  shell,
  webContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { ORIGIN, type CloseAction, type InvokeChannels, type SendChannels } from '@shared/ipc';
import { isHttpUrl } from './security';
import { acknowledgeClose, markQuitting, setHandlesClose, windowOf } from './window';
import { logDir } from './logger';
import { Timers } from './timers';

type AnyEvent = IpcMainEvent | IpcMainInvokeEvent;

function assertTrusted(e: AnyEvent): void {
  const url = e.senderFrame?.url ?? '';
  if (!url.startsWith(ORIGIN + '/')) throw new Error(`untrusted ipc sender: ${url}`);
}

function handle<C extends keyof InvokeChannels>(
  channel: C,
  fn: (
    e: IpcMainInvokeEvent,
    ...args: InvokeChannels[C]['args']
  ) => InvokeChannels[C]['result'] | Promise<InvokeChannels[C]['result']>,
): void {
  ipcMain.handle(channel, (e, ...args) => {
    assertTrusted(e);
    return fn(e, ...(args as InvokeChannels[C]['args']));
  });
}

function on<C extends keyof SendChannels>(channel: C, fn: (e: IpcMainEvent, ...args: SendChannels[C]) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    try {
      assertTrusted(e);
    } catch {
      return;
    }
    fn(e, ...(args as SendChannels[C]));
  });
}

/** 定时器归属于发起调用的页面：页面导航、崩溃或销毁时清除 */
function trackTimerOwner(timers: Timers, wc: WebContents, tracked: WeakSet<WebContents>): void {
  if (tracked.has(wc)) return;
  tracked.add(wc);
  const clear = () => timers.clearOwner(wc.id);
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) clear();
  });
  wc.on('render-process-gone', clear);
  wc.once('destroyed', clear);
}

export function createTimers(): Timers {
  return new Timers((owner, tick) => {
    const wc = webContents.fromId(owner);
    if (wc && !wc.isDestroyed()) wc.send('timers:tick', tick);
  });
}

export function registerIpc(timers: Timers): void {
  const tracked = new WeakSet<WebContents>();

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
  handle('app:open-external', async (_e, url) => {
    if (!isHttpUrl(url)) throw new Error('only http/https urls are allowed');
    await shell.openExternal(url);
  });
  handle('app:toggle-devtools', (e) => {
    if (!app.isPackaged) e.sender.toggleDevTools();
  });
  handle('app:open-logs', async () => {
    const err = await shell.openPath(logDir()); // 成功时返回空字符串
    if (err) throw new Error(err);
  });

  handle('window:minimize', (e) => {
    windowOf(e.sender)?.minimize();
  });
  handle('window:toggle-maximize', (e) => {
    const w = windowOf(e.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  handle('window:close', (e) => {
    windowOf(e.sender)?.close();
  });
  handle('window:close-action', (e, action: CloseAction) => {
    if (action === 'tray') windowOf(e.sender)?.hide();
    else if (action === 'quit') {
      markQuitting();
      app.quit();
    } else throw new Error(`invalid close action: ${String(action)}`);
  });
  on('window:close-handler', (e, registered) => {
    const w = windowOf(e.sender);
    if (w) setHandlesClose(w, registered === true);
  });
  on('window:close-ack', (e) => {
    const w = windowOf(e.sender);
    if (w) acknowledgeClose(w);
  });

  handle('timers:set', (e, timer) => {
    trackTimerOwner(timers, e.sender, tracked);
    return timers.set(e.sender.id, timer);
  });
  handle('timers:clear', (e, id) => timers.clear(e.sender.id, id));
  handle('timers:list', (e) => timers.list(e.sender.id));
}
