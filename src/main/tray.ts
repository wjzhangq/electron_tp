import path from 'node:path';
import { app, Menu, Tray } from 'electron';
import { showMainWindow } from './window';
import { createLogger } from './logger';

const log = createLogger('tray');

let tray: Tray | null = null;

/** 托盘创建失败（例如图标无法加载）只记录错误，不中断启动 */
export function createTray(): void {
  const icon = app.isPackaged
    ? path.join(process.resourcesPath, 'tray.ico')
    : path.join(app.getAppPath(), 'assets', 'tray.ico');
  try {
    tray = new Tray(icon);
  } catch (e) {
    log.error('create tray failed', e);
    return;
  }
  tray.setToolTip(app.getName());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMainWindow },
      { label: '退出', click: () => app.quit() },
    ]),
  );
  tray.on('click', showMainWindow);
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
