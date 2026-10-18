// API 服务进程入口（utilityProcess）：Router、插件与业务处理都在这里，阻塞不会波及主进程的窗口、托盘和 IPC
import { inspect } from 'node:util';
import type { ApiServiceConfig, FromService, ToService } from '@shared/wire';
import { wrapPort } from '@shared/wire';
import { Router } from './router';
import { registerSystemRoutes } from './routes/system';
import { disposePlugins, loadPlugins } from './plugins/loader';
import { serve } from './serve';
import { createLogger as createLoggerFor } from './log';

const parent = process.parentPort;
const post = (m: FromService): void => parent.postMessage(m);
const createLogger = (scope: string) => createLoggerFor(scope, post);
const log = createLogger('api');

let router: Router | undefined;

async function init(config: ApiServiceConfig): Promise<void> {
  try {
    const r = new Router({ exposeErrors: config.exposeErrors, logger: log });
    registerSystemRoutes(r);
    const plugins = await loadPlugins(r, { root: config.pluginRoot, app: config.app, createLogger });
    r.get('/api/plugins', () => plugins);
    router = r;
    post({ type: 'ready', plugins });
  } catch (e) {
    // 例如内置路由重复注册（FR-RTE-7）
    post({ type: 'fatal', error: inspect(e) });
  }
}

parent.on('message', (e) => {
  const msg = e.data as ToService;
  switch (msg.type) {
    case 'init':
      void init(msg.config);
      break;
    case 'request': {
      const port = e.ports[0];
      if (!port) return;
      if (!router) {
        port.close();
        return;
      }
      serve(msg.head, wrapPort(port), router, (err) => log.error('[api] unhandled error', err));
      break;
    }
    case 'dispose':
      void disposePlugins().finally(() => process.exit(0));
      break;
  }
});

process.on('unhandledRejection', (reason) => log.error('unhandled rejection', reason));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception, exiting', err);
  // 给日志消息留出发送时间；主进程会按策略重启服务
  setTimeout(() => process.exit(1), 100);
});
