// 示例用法（约束等级：示意）
import './style.css';
import type { Unsubscribe } from '@shared/ipc';
import { request, stream } from './api';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const output = $('output');
const print = (v: unknown): void => {
  output.textContent += (typeof v === 'string' ? v : JSON.stringify(v)) + '\n';
};
const run = (fn: () => Promise<void>) => () => {
  output.textContent = '';
  fn().catch((e: unknown) => print(`error: ${String(e)}`));
};

// 主题
const applyTheme = (isDark: boolean): void => {
  document.documentElement.classList.toggle('dark', isDark);
};
window.app.onThemeChanged(applyTheme);
void window.app.info().then((info) => {
  applyTheme(info.isDark);
  $('info').textContent = JSON.stringify(info, null, 2);
});

// 自绘标题栏
$('btn-min').addEventListener('click', () => void window.app.window.minimize());
$('btn-max').addEventListener('click', () => void window.app.window.toggleMaximize());
$('btn-close').addEventListener('click', () => void window.app.window.close());
window.app.window.onMaximizeChanged((maximized) => {
  $('btn-max').innerHTML = maximized ? '&#x2750;' : '&#x25A1;';
  document.body.dataset.maximized = String(maximized);
});

$('btn-logs').addEventListener('click', () => void window.app.openLogs());
$('btn-devtools').addEventListener('click', () => void window.app.toggleDevTools());

// 接口示例
$('btn-ping').addEventListener(
  'click',
  run(async () => print(await request<{ pong: boolean; time: number }>('/ping'))),
);
$('btn-greet').addEventListener(
  'click',
  run(async () => print(await request<{ message: string }>('/plugins/hello/greet', { query: { name: 'Tom' } }))),
);
$('btn-count').addEventListener(
  'click',
  run(async () => {
    const ac = new AbortController();
    for await (const e of stream<{ i: number; total: number }>('/plugins/hello/count', {
      query: { n: 5 },
      signal: ac.signal,
    })) {
      if (e.event === 'progress') print(`progress ${e.data.i}/${e.data.total}`);
      if (e.event === 'complete') {
        print('complete');
        break;
      }
      if (e.event === 'error') throw new Error(JSON.stringify(e.data));
    }
  }),
);
$('btn-tasks').addEventListener(
  'click',
  run(async () => {
    print(
      await request('/tasks', {
        method: 'PUT',
        body: { tasks: [{ id: 'sync', intervalSec: 10, data: { src: 'a' } }] },
      }),
    );
  }),
);
window.app.onAutoImport((tick) => print({ autoImport: tick }));

// 接管关闭：每次都询问，不记住选择
const dialog = $('close-dialog');
const showCloseDialog = (): Promise<'tray' | 'quit' | 'cancel'> =>
  new Promise((resolve) => {
    dialog.hidden = false;
    const pick = (choice: 'tray' | 'quit' | 'cancel') => () => {
      dialog.hidden = true;
      resolve(choice);
    };
    $('close-tray').onclick = pick('tray');
    $('close-quit').onclick = pick('quit');
    $('close-cancel').onclick = pick('cancel');
  });

let offClose: Unsubscribe | null = null;
const setCloseHandling = (enabled: boolean): void => {
  offClose?.();
  offClose = null;
  if (enabled) {
    offClose = window.app.window.onCloseRequested(async () => {
      const choice = await showCloseDialog();
      if (choice !== 'cancel') await window.app.window.closeAction(choice);
    });
  }
};
const chk = $<HTMLInputElement>('chk-close');
chk.addEventListener('change', () => setCloseHandling(chk.checked));
setCloseHandling(chk.checked);
