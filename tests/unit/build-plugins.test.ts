import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlugins } from '../../scripts/build-plugins';

const ROOT = path.resolve(__dirname, '../..');
let src: string;
let out: string;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'build-plugins-test-'));
  src = path.join(base, 'plugins');
  out = path.join(base, 'out');
  fs.mkdirSync(src);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(path.dirname(src), { recursive: true, force: true });
});

const write = (rel: string, code: string) => {
  const p = path.join(src, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, code);
};

const okPlugin = (name: string, extra = '') => `
import { definePlugin, ApiError, Codes } from '@app/sdk';
import os from 'node:os';
import { join } from 'path';
${extra}
export const helper = () => join(os.tmpdir(), 'x');
export default definePlugin({ name: '${name}', version: '1.0.0', setup(r) {
  r.get('/x', () => { throw new ApiError(Codes.PARAM_INVALID, 'x'); });
} });
`;

describe('buildPlugins', () => {
  it('bundles each plugin into a single CJS file that exports default', async () => {
    write('alpha/index.ts', okPlugin('alpha'));
    write('alpha/util.ts', 'export const v = 1;'); // 插件自己目录内的模块允许导入
    write('beta/index.ts', okPlugin('beta', "import { v } from './util'; console.debug(v);"));
    write('beta/util.ts', 'export const v = 2;');
    await buildPlugins(out, src);
    expect(fs.readdirSync(out).sort()).toEqual(['alpha', 'beta']);
    expect(fs.readdirSync(path.join(out, 'alpha'))).toEqual(['index.js']);
    const mod = createRequire(__filename)(path.join(out, 'alpha', 'index.js')) as {
      default: { name: string; version: string; setup: unknown };
    };
    expect(mod.default.name).toBe('alpha');
    expect(typeof mod.default.setup).toBe('function');
    // electron 与 Node 内置模块保持 external，不打进产物
    const code = fs.readFileSync(path.join(out, 'alpha', 'index.js'), 'utf8');
    expect(code).toMatch(/require\("node:os"\)/);
  });

  it('cleans the output directory before building', async () => {
    fs.mkdirSync(path.join(out, 'stale'), { recursive: true });
    write('alpha/index.ts', okPlugin('alpha'));
    await buildPlugins(out, src);
    expect(fs.readdirSync(out)).toEqual(['alpha']);
  });

  it('keeps electron external', async () => {
    write('alpha/index.ts', okPlugin('alpha', "import { app } from 'electron'; console.debug(app);"));
    await buildPlugins(out, src);
    expect(fs.readFileSync(path.join(out, 'alpha', 'index.js'), 'utf8')).toMatch(/require\("electron"\)/);
  });

  it('fails when a plugin imports another plugin', async () => {
    write('alpha/index.ts', okPlugin('alpha'));
    write('beta/index.ts', okPlugin('beta', "import { helper as other } from '../alpha/index'; console.debug(other);"));
    await expect(buildPlugins(out, src)).rejects.toThrow(/plugin "beta" must not import .*alpha/);
  });

  it('fails when a plugin imports a plugin from the repository plugins/ directory', async () => {
    const hello = path
      .relative(path.join(src, 'alpha'), path.join(ROOT, 'plugins', 'hello', 'index'))
      .split(path.sep)
      .join('/');
    write('alpha/index.ts', okPlugin('alpha', `import h from '${hello}'; console.debug(h);`));
    await expect(buildPlugins(out, src)).rejects.toThrow(/plugin "alpha" must not import/);
  });

  it('fails when a plugin imports internal modules under src/', async () => {
    const internal = path
      .relative(path.join(src, 'alpha'), path.join(ROOT, 'src', 'main', 'tasks', 'auto-import'))
      .split(path.sep)
      .join('/');
    write(
      'alpha/index.ts',
      okPlugin('alpha', `import { AutoImportScheduler } from '${internal}'; console.debug(AutoImportScheduler);`),
    );
    await expect(buildPlugins(out, src)).rejects.toThrow(/plugin "alpha" must not import .*auto-import/);
  });

  it('allows @shared re-exported through the SDK', async () => {
    write('alpha/index.ts', okPlugin('alpha', "import { isApiError } from '@shared/api'; console.debug(isApiError);"));
    await expect(buildPlugins(out, src)).resolves.toBeUndefined();
  });

  it('fails on native modules (.node) that cannot be bundled', async () => {
    write('alpha/native.node', 'binary');
    write('alpha/index.ts', okPlugin('alpha', "import n from './native.node'; console.debug(n);"));
    await expect(buildPlugins(out, src)).rejects.toThrow(/\.node/);
  });

  it('fails on unresolvable packages', async () => {
    write('alpha/index.ts', okPlugin('alpha', "import x from 'definitely-not-installed-pkg'; console.debug(x);"));
    await expect(buildPlugins(out, src)).rejects.toThrow(/definitely-not-installed-pkg/);
  });

  it('builds the bundled hello example from the repository', async () => {
    await buildPlugins(out);
    expect(fs.existsSync(path.join(out, 'hello', 'index.js'))).toBe(true);
  });
});
