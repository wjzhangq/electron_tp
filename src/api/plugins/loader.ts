import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Logger, PluginDefinition, RouteRegistrar } from '@app/sdk';
import type { PluginStatus } from '@shared/api';
import type { Router } from '../router';

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface LoadOptions {
  root: string;
  app: { version: string; isPackaged: boolean };
  createLogger: (scope: string) => Logger;
  setupTimeoutMs?: number;
}

const loaded: PluginDefinition[] = [];
let log: Logger = console;

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
  const guard =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A): void => {
      if (!open) throw new Error(`routes under ${prefix} can only be registered during setup`);
      fn(...a);
    };
  return {
    registrar: {
      get: guard((p, h) => scoped.get(p, h)),
      post: guard((p, h) => scoped.post(p, h)),
      put: guard((p, h) => scoped.put(p, h)),
      patch: guard((p, h) => scoped.patch(p, h)),
      delete: guard((p, h) => scoped.delete(p, h)),
      sse: guard((p, h, m) => scoped.sse(p, h, m)),
    },
    seal: () => {
      open = false;
    },
  };
}

export async function loadPlugins(router: Router, opts: LoadOptions): Promise<PluginStatus[]> {
  const { root, setupTimeoutMs = 3000 } = opts;
  log = opts.createLogger('plugins');
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
      const ctx = { name, logger: opts.createLogger(`plugin:${name}`), app: { ...opts.app } };
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
    loaded.splice(0).map((p) =>
      withTimeout(
        Promise.resolve().then(() => p.dispose?.()),
        timeoutMs,
        `plugin ${p.name} dispose`,
      ).catch((e) => log.warn(String(e))),
    ),
  );
}
