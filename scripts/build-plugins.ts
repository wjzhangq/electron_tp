// 构建插件并检查隔离（禁止导入其他插件和 src 内部模块）
import fs from 'node:fs/promises';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { build } from 'esbuild';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'plugins');
const SDK_DIR = path.join(ROOT, 'src', 'sdk');
const SHARED_DIR = path.join(ROOT, 'src', 'shared'); // SDK 重新导出 shared，属于允许范围

/**
 * @param outRoot 输出目录，每个插件输出到 `<outRoot>/<name>/index.js`
 * @param srcRoot 插件源码目录，默认 `plugins/`；单元测试用它指向临时构造的插件
 */
export async function buildPlugins(outRoot = path.join(ROOT, '.plugins'), srcRoot = SRC): Promise<void> {
  await fs.rm(outRoot, { recursive: true, force: true });
  const dirs = (await fs.readdir(srcRoot, { withFileTypes: true })).filter((d) => d.isDirectory());

  for (const { name } of dirs) {
    const self = path.join(srcRoot, name) + path.sep;
    const result = await build({
      entryPoints: [path.join(srcRoot, name, 'index.ts')],
      outfile: path.join(outRoot, name, 'index.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24', // 与所用 Electron（44.9.0，内置 Node 24）的 Node 主版本保持一致
      minify: true,
      metafile: true,
      tsconfig: path.join(ROOT, 'tsconfig.json'),
      external: ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    });

    for (const input of Object.keys(result.metafile.inputs)) {
      const abs = path.resolve(ROOT, input);
      const inOtherPlugin =
        (abs.startsWith(srcRoot + path.sep) || abs.startsWith(SRC + path.sep)) && !abs.startsWith(self);
      const inSrcInternal =
        abs.startsWith(path.join(ROOT, 'src') + path.sep) &&
        !abs.startsWith(SDK_DIR + path.sep) &&
        !abs.startsWith(SHARED_DIR + path.sep);
      if (inOtherPlugin || inSrcInternal) {
        throw new Error(`plugin "${name}" must not import ${input} (only @app/sdk is allowed)`);
      }
    }
    console.log(`[plugins] built ${name}`);
  }
}

if (require.main === module) {
  buildPlugins().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
