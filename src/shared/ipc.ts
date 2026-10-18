import type { TaskTick } from './api';

export const ORIGIN = 'chttp://localhost'; // 必须等于 `${SCHEME}://${HOST}`
export type CloseAction = 'tray' | 'quit';

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  arch: string;
  locale: string;
  isDark: boolean;
  isPackaged: boolean;
}

/** renderer → main（invoke） */
export interface InvokeChannels {
  'app:info': { args: []; result: AppInfo };
  'app:open-external': { args: [url: string]; result: void };
  'app:toggle-devtools': { args: []; result: void };
  'app:open-logs': { args: []; result: void };
  'window:minimize': { args: []; result: void };
  'window:toggle-maximize': { args: []; result: void };
  'window:close': { args: []; result: void };
  'window:close-action': { args: [action: CloseAction]; result: void };
}

/** renderer → main（send，无返回值） */
export interface SendChannels {
  'window:close-handler': [registered: boolean];
}

/** main → renderer（事件） */
export interface EventChannels {
  'window:close-requested': [];
  'window:maximize-changed': [maximized: boolean];
  'theme:changed': [isDark: boolean];
  'auto-import:tick': [tick: TaskTick];
}

export type Unsubscribe = () => void;

export interface AppBridge {
  info(): Promise<AppInfo>;
  openExternal(url: string): Promise<void>;
  toggleDevTools(): Promise<void>;
  openLogs(): Promise<void>;
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    closeAction(action: CloseAction): Promise<void>;
    onCloseRequested(cb: () => void): Unsubscribe;
    onMaximizeChanged(cb: (maximized: boolean) => void): Unsubscribe;
  };
  onThemeChanged(cb: (isDark: boolean) => void): Unsubscribe;
  onAutoImport(cb: (tick: TaskTick) => void): Unsubscribe;
}
