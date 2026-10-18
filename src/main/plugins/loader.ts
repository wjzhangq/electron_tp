import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { app } from 'electron';
import type { PluginDefinition, RouteRegistrar } from '@app/sdk';
import type { PluginStatus } from '@shared/api';
import type { Router } from '../chttp/router';
import { createLogger } from '../logger';

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const loaded: PluginDefinition[] = [];
const log = createLogger('plugins');

export function pluginRoot(): string {
  return app.isPackaged
    ? path.join(app.getAppPath(), 'plugins') // …\resources\app.asar\plugins
    : path.join(app.getAppPath(), '.plugins');
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** FR-PLG-10：只在 setup 执行期间允许注册路由 */
function sealableScope(router: Router, prefix: string): { registrar: RouteRegistrar; seal(): void } {
  const scoped = router.scope(prefix);
  let open = true;
  const check = (): void => {
    if (!open) throw new Error(`routes under ${prefix} can only be registered during setup`);
  };
  return {
    registrar: {
      get: (p, h) => {
        check();
        scoped.get(p, h);
      },
      post: (p, h) => {
        check();
        scoped.post(p, h);
      },
      put: (p, h) => {
        check();
        scoped.put(p, h);
      },
      patch: (p, h) => {
        check();
        scoped.patch(p, h);
      },
      delete: (p, h) => {
        check();
        scoped.delete(p, h);
      },
      sse: (p, h, m) => {
        check();
        scoped.sse(p, h, m);
      },
    },
    seal: () => {
      open = false;
    },
  };
}

export async function loadPlugins(router: Router, root = pluginRoot(), setupTimeoutMs = 3000): Promise<PluginStatus[]> {
  const statuses: PluginStatus[] = [];
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const load = createRequire(__filename);

  for (const name of names) {
    const prefix = `/api/plugins/${name}`;
    const scope = sealableScope(router, prefix);
    try {
      if (!NAME_RE.test(name)) throw new Error(`invalid plugin name: ${name}`);
      const mod = load(path.join(root, name, 'index.js')) as { default?: PluginDefinition };
      const def = mod.default;
      if (!def || def.name !== name || typeof def.setup !== 'function') {
        throw new Error('plugin must default-export definePlugin({ name: <dir name>, ... })');
      }
      const ctx = {
        name,
        logger: createLogger(`plugin:${name}`),
        app: { version: app.getVersion(), isPackaged: app.isPackaged },
      };
      await withTimeout(
        Promise.resolve().then(() => def.setup(scope.registrar, ctx)),
        setupTimeoutMs,
        `plugin ${name} setup`,
      );
      scope.seal();
      loaded.push(def);
      statuses.push({ name, version: def.version, status: 'loaded' });
    } catch (e) {
      scope.seal();
      router.removeScope(prefix);
      statuses.push({ name, status: 'failed', error: String(e) });
      log.error(`load ${name} failed`, e);
    }
  }
  return statuses;
}

export async function disposePlugins(timeoutMs = 3000): Promise<void> {
  await Promise.all(
    loaded.map((p) =>
      withTimeout(
        Promise.resolve().then(() => p.dispose?.()),
        timeoutMs,
        `plugin ${p.name} dispose`,
      ).catch((e) => log.warn(String(e))),
    ),
  );
}
