import path from 'node:path';
import { spawn } from 'node:child_process';
import { MakerBase, type MakerOptions } from '@electron-forge/maker-base';
import type { ForgePlatform } from '@electron-forge/shared-types';

export interface MakerInnoConfig {
  script: string;
  exeName: string;
  iconFile: string;
  publisher: string;
  /** Inno SignTool 命令，$f 会被替换为带引号的文件路径；为空时不签名 */
  signCommand?: string;
  isccPath?: string;
}

export class MakerInno extends MakerBase<MakerInnoConfig> {
  name = 'inno';
  defaultPlatforms: ForgePlatform[] = ['win32'];

  isSupportedOnCurrentPlatform(): boolean {
    return process.platform === 'win32';
  }

  async make({ dir, makeDir, appName, packageJSON, targetArch }: MakerOptions): Promise<string[]> {
    if (targetArch !== 'x64') throw new Error(`MakerInno only supports x64, got ${targetArch}`);
    const version = String(packageJSON.version);
    const outputDir = path.join(makeDir, 'inno', targetArch);
    const baseName = `${appName}_x64_${version}_setup`;
    const iscc = this.config.isccPath ?? process.env.ISCC_PATH ?? 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe';

    const args = [
      `/DAppName=${appName}`,
      `/DAppVersion=${version}`,
      `/DAppPublisher=${this.config.publisher}`,
      `/DExeName=${this.config.exeName}`,
      `/DIconFile=${this.config.iconFile}`,
      `/DSourceDir=${dir}`,
      `/DOutputDir=${outputDir}`,
      `/DOutputBaseFilename=${baseName}`,
    ];
    if (this.config.signCommand) {
      args.push('/DSignEnabled', `/Sappsign=${this.config.signCommand}`);
    }
    args.push(this.config.script);

    await new Promise<void>((resolve, reject) => {
      const p = spawn(iscc, args, { stdio: 'inherit', windowsHide: true });
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ISCC exited with ${code}`))));
    });
    return [path.join(outputDir, `${baseName}.exe`)];
  }
}
