import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { MakerInno } from './forge/maker-inno';
import { buildPlugins } from './scripts/build-plugins';

const signEnabled = Boolean(process.env.WIN_SIGN_BACKEND);

/** FR-BLD-5：只允许构建 win32 x64 */
function assertWin32X64(stage: string, platform: string, arch: string): void {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`[${stage}] only win32/x64 is supported, got ${platform}/${arch}`);
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'my-app',
    icon: 'assets/icon', // Windows 自动使用 icon.ico
    extraResource: ['assets/tray.ico'],
    ...(signEnabled ? { windowsSign: { hookModulePath: path.resolve(__dirname, 'scripts/sign-hook.cjs') } } : {}),
  },
  hooks: {
    prePackage: async (_config, platform, arch) => {
      assertWin32X64('package', platform, arch);
    },
    preMake: async () => {
      // make 必须在 Windows x64 上执行（Inno Setup 只能在 Windows 上运行）
      assertWin32X64('make', process.platform, process.arch);
    },
    // 把插件构建到待打包目录中，随后一起进入 app.asar
    packageAfterCopy: async (_config, buildPath) => {
      await buildPlugins(path.join(buildPath, 'plugins'));
    },
  },
  makers: [
    new MakerInno({
      script: path.resolve(__dirname, 'installer/app.iss'),
      exeName: 'my-app.exe',
      iconFile: path.resolve(__dirname, 'assets/icon.ico'),
      publisher: 'Your Company',
      signCommand: signEnabled ? `$qnode$q $q${path.resolve(__dirname, 'scripts/sign-cli.cjs')}$q $f` : undefined,
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

export default config;
