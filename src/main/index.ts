import path from 'node:path';
import { app, powerMonitor } from 'electron';
import { handleChttp, registerChttpScheme } from './chttp/scheme';
import { createStaticHandler } from './chttp/static';
import { ApiHost } from './chttp/api-host';
import { applySecurityPolicy } from './security';
import { createMainWindow, showMainWindow } from './window';
import { createTray } from './tray';
import { createTimers, registerIpc } from './ipc';
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

  const timers = createTimers();
  let api: ApiHost | undefined;

  app
    .whenReady()
    .then(async () => {
      initFileLog();
      pruneCrashDumps();
      applySecurityPolicy();

      api = new ApiHost({
        // Forge Vite 插件把 src/api/index.ts 输出为 .vite/build/api.cjs（见 vite.api.config.ts）
        entry: path.join(__dirname, 'api.cjs'),
        config: {
          pluginRoot: app.isPackaged
            ? path.join(app.getAppPath(), 'plugins') // …\resources\app.asar\plugins
            : path.join(app.getAppPath(), '.plugins'),
          exposeErrors: !app.isPackaged,
          app: { version: app.getVersion(), isPackaged: app.isPackaged },
        },
      });
      const started = api.start();
      const host = api;
      handleChttp(
        (req) => host.handle(req),
        createStaticHandler({
          root: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`),
          devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
        }),
      );

      registerIpc(timers);
      createMainWindow();
      createTray();

      powerMonitor.on('suspend', () => timers.pauseAll());
      powerMonitor.on('resume', () => timers.resumeAll());

      const plugins = await started;
      logger.info(`started, plugins: ${plugins.map((p) => `${p.name}(${p.status})`).join(', ') || 'none'}`);
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
    timers.dispose();
    void (api?.stop() ?? Promise.resolve()).finally(() => {
      closeFileLog();
      // 放到下一个宏任务再退出：在 will-quit 派发过程中（微任务里）同步调用 app.quit() 会被 Electron 忽略
      setImmediate(() => app.quit());
    });
  });
}
