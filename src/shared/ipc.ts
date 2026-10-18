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

export interface TimerInput {
  id: string;
  /** 正整数秒 */
  intervalSec: number;
  data?: unknown;
}
export interface TimerState {
  id: string;
  intervalSec: number;
  nextRunAt: number;
}
export interface TimerTick {
  id: string;
  data: unknown;
  nextRunAt: number;
}

/** renderer → main（invoke）；窗口相关操作都作用于调用方所在的窗口 */
export interface InvokeChannels {
  'app:info': { args: []; result: AppInfo };
  'app:open-external': { args: [url: string]; result: void };
  'app:toggle-devtools': { args: []; result: void };
  'app:open-logs': { args: []; result: void };
  'window:minimize': { args: []; result: void };
  'window:toggle-maximize': { args: []; result: void };
  'window:close': { args: []; result: void };
  'window:close-action': { args: [action: CloseAction]; result: void };
  'timers:set': { args: [timer: TimerInput]; result: TimerState };
  'timers:clear': { args: [id: string]; result: void };
  'timers:list': { args: []; result: TimerState[] };
}

/** renderer → main（send，无返回值） */
export interface SendChannels {
  'window:close-handler': [registered: boolean];
  /** preload 收到关闭请求后立即回执，用于判断页面 JS 是否还能响应 */
  'window:close-ack': [];
}

/** main → renderer（事件） */
export interface EventChannels {
  'window:close-requested': [];
  'window:maximize-changed': [maximized: boolean];
  'theme:changed': [isDark: boolean];
  'timers:tick': [tick: TimerTick];
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
  /** 主进程定时器：只在内存中、归属当前页面，页面刷新 / 导航 / 关闭后自动清除 */
  timers: {
    set(timer: TimerInput): Promise<TimerState>;
    clear(id: string): Promise<void>;
    list(): Promise<TimerState[]>;
    onTick(cb: (tick: TimerTick) => void): Unsubscribe;
  };
  onThemeChanged(cb: (isDark: boolean) => void): Unsubscribe;
}
