import path from 'node:path';
import { app, powerMonitor } from 'electron';
import { handleChttp, registerChttpScheme } from './chttp/scheme';
import { Router } from './chttp/router';
import { createStaticHandler } from './chttp/static';
import { applySecurityPolicy } from './security';
import { getMainWindow, createMainWindow, showMainWindow } from './window';
import { createTray } from './tray';
import { registerIpc } from './ipc';
import { disposePlugins, loadPlugins } from './plugins/loader';
import { registerSystemRoutes } from './routes/system';
import { registerTaskRoutes } from './routes/tasks';
import { AutoImportScheduler } from './tasks/auto-import';
import { closeFileLog, initFileLog, logger, pruneCrashDumps, startCrashReporter } from './logger';

// 由 Forge Vite 插件注入
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

registerChttpScheme();
app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  startCrashReporter();

  // FR-WIN-1：ready 之前的第二次启动直接忽略，不得在 ready 之前创建窗口
  app.on('second-instance', () => {
    if (app.isReady()) showMainWindow();
  });

  const scheduler = new AutoImportScheduler((tick) => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('auto-import:tick', tick);
  });

  app
    .whenReady()
    .then(async () => {
      initFileLog();
      pruneCrashDumps();
      applySecurityPolicy();

      const router = new Router({ exposeErrors: !app.isPackaged, logger });
      registerSystemRoutes(router);
      registerTaskRoutes(router, scheduler);
      const pluginStatuses = await loadPlugins(router);
      router.get('/api/plugins', () => pluginStatuses);

      handleChttp(
        router,
        createStaticHandler({
          root: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`),
          devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
        }),
      );

      registerIpc();
      createMainWindow();
      createTray();

      powerMonitor.on('suspend', () => scheduler.pauseAll());
      powerMonitor.on('resume', () => scheduler.restartAll());

      logger.info(`started, plugins: ${pluginStatuses.map((p) => `${p.name}(${p.status})`).join(', ') || 'none'}`);
    })
    .catch((e) => {
      // 例如内置路由重复注册（FR-RTE-7）
      logger.error('startup failed', e);
      closeFileLog();
      app.exit(1);
    });

  app.on('window-all-closed', () => app.quit());

  let disposed = false;
  app.on('will-quit', (e) => {
    if (disposed) return;
    e.preventDefault();
    disposed = true;
    scheduler.dispose();
    void disposePlugins().finally(() => {
      closeFileLog();
      // 放到下一个宏任务再退出：在 will-quit 派发过程中（微任务里）同步调用 app.quit() 会被 Electron 忽略
      setImmediate(() => app.quit());
    });
  });
}
