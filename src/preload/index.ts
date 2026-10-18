import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppBridge, EventChannels, InvokeChannels, SendChannels, Unsubscribe } from '@shared/ipc';

const invoke = <C extends keyof InvokeChannels>(c: C, ...args: InvokeChannels[C]['args']) =>
  ipcRenderer.invoke(c, ...args) as Promise<InvokeChannels[C]['result']>;

const send = <C extends keyof SendChannels>(c: C, ...args: SendChannels[C]) => ipcRenderer.send(c, ...args);

const on = <C extends keyof EventChannels>(c: C, cb: (...args: EventChannels[C]) => void): Unsubscribe => {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as EventChannels[C]));
  ipcRenderer.on(c, listener);
  return () => {
    ipcRenderer.removeListener(c, listener);
  };
};

let closeHandlers = 0;

const bridge: AppBridge = {
  info: () => invoke('app:info'),
  openExternal: (url) => invoke('app:open-external', url),
  toggleDevTools: () => invoke('app:toggle-devtools'),
  openLogs: () => invoke('app:open-logs'),
  window: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggle-maximize'),
    close: () => invoke('window:close'),
    closeAction: (action) => invoke('window:close-action', action),
    onCloseRequested: (cb) => {
      const off = on('window:close-requested', cb);
      if (++closeHandlers === 1) send('window:close-handler', true);
      let active = true;
      return () => {
        if (!active) return; // 同一个取消函数重复调用无效（见 3.6）
        active = false;
        off();
        if (--closeHandlers === 0) send('window:close-handler', false);
      };
    },
    onMaximizeChanged: (cb) => on('window:maximize-changed', cb),
  },
  onThemeChanged: (cb) => on('theme:changed', cb),
  onAutoImport: (cb) => on('auto-import:tick', cb),
};

contextBridge.exposeInMainWorld('app', bridge);
