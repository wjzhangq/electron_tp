# My App —— Windows 桌面壳（Electron + TypeScript + chttp 虚拟 HTTP 服务）

只运行在 **Windows x64** 的 Electron 桌面壳：前端页面与后端接口都通过自定义协议 `chttp://localhost` 提供，主进程充当“虚拟 HTTP Server”（**不监听任何端口**），支持 JSON 接口与 SSE 流式接口，业务能力可以内置路由或插件的形式扩展。

## 版本

| 组件 | 版本（精确锁定） | 说明 |
|------|------------------|------|
| Electron | **44.9.0** | 立项时 `npm view electron version` 的结果；内置 Chrome 152、Node 24.22 |
| Electron Forge（cli / plugin-vite / plugin-fuses / maker-base / shared-types） | 8.0.1 | 由 `create-electron-app@8.0.1` 模板生成 |
| @electron/fuses | 2.1.3 | 模板生成 |
| Vite | 8.3.4 | 模板生成 |
| TypeScript | 6.0.3 | 模板生成 |

asar 完整性校验：Electron 官方文档（*Tutorial › ASAR Integrity*）说明 `EnableEmbeddedAsarIntegrityValidation` 在 Windows 上自 Electron 30 起受支持，44.9.0 满足要求。打包后用 `npx @electron/fuses read --app "out/My App-win32-x64/my-app.exe"` 读回的熔断配置与 SEC-6 一致。

`dependencies` 为空，所有代码在构建时打包。

## 目录

```
forge.config.ts            Forge 配置：Vite、Fuses、签名钩子、Inno maker、win32/x64 限制
forge/maker-inno.ts        自定义 Inno Setup maker
installer/app.iss          Inno 脚本（AppId 固定，永不修改）
scripts/build-plugins.ts   插件构建与隔离检查
scripts/sign-hook.cjs      统一签名钩子（后端待定）
scripts/sign-cli.cjs       给 Inno SignTool 调用的命令行入口
scripts/tamper-check.ts    篡改 app.asar 后断言应用拒绝启动
src/main/                  主进程（协议层、路由、插件加载、窗口、托盘、IPC、日志、定时任务）
src/preload/index.ts       contextBridge → window.app
src/renderer/              示例前端 + api 客户端（request / stream）
src/shared/                main / preload / renderer 共享的类型与常量
src/sdk/index.ts           插件 SDK（插件唯一可导入的内部模块）
plugins/hello/             示例插件
tests/unit/                Vitest 单元测试
tests/e2e/                 Playwright（Electron 模式）E2E
```

## 开发

前提：Windows 10/11 x64，Node.js 22 LTS 或更高，Git。

```bash
npm ci
npm start            # 构建插件到 .plugins/，再 electron-forge start
```

- 页面 origin 始终是 `chttp://localhost`。开发模式下 Static 把请求转发到 Vite dev server（端口固定 5173，`strictPort`），HMR 通过 `ws://localhost:5173` 直连 dev server。
- 开发模式同样下发 CSP，只在 `connect-src` 中额外允许 `ws://localhost:5173`（SEC-8）。
- `window.app.toggleDevTools()` 只在未打包时生效。

常用命令：

| 命令 | 作用 |
|------|------|
| `npm run lint` | ESLint（typescript-eslint）+ Prettier 检查 |
| `npm run format` | Prettier 格式化 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest 单元测试 + 覆盖率（阈值 80%） |
| `npm run test:e2e` | `package` → `build:plugins` → Playwright E2E（运行在未打包构建上） |
| `npm run check:tamper` | 篡改检查（需先 `package`/`make`，只能在 Windows 上运行） |

## 打包

```bash
npm run package      # out/My App-win32-x64/
npm run make         # out/make/inno/x64/My App_x64_<version>_setup.exe
```

- 只允许构建 win32 x64：`package` 的目标平台/架构不是 win32/x64，或在非 Windows x64 主机上执行 `make` 时报错（FR-BLD-5）。
- `make` 需要 Inno Setup 6，默认路径 `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`，可用环境变量 `ISCC_PATH` 覆盖。
- 安装包按用户安装（`PrivilegesRequired=lowest`），默认目录 `%LOCALAPPDATA%\Programs\My App`；卸载时删除安装目录和 `%APPDATA%\My App`。
- 代码签名：设置 `WIN_SIGN_BACKEND` 时启用（exe/dll 经 Forge `windowsSign.hookModulePath`，安装/卸载程序经 Inno `SignTool` → `scripts/sign-cli.cjs`），统一实现在 `scripts/sign-hook.cjs`。签名后端待定，目前产出未签名安装包。

## 新增插件

1. 新建 `plugins/<name>/index.ts`，`<name>` 必须匹配 `^[a-z][a-z0-9-]*$`。
2. 只能导入 `@app/sdk`、`electron`、Node 内置模块和可被 esbuild 打进单文件的 npm 包；**禁止导入其他插件或 `src/` 下的内部模块**，不支持原生模块（`.node`），违反时构建失败。
3. 默认导出 `definePlugin`，`name` 与目录名一致：

```ts
import { ApiError, Codes, definePlugin } from '@app/sdk';

export default definePlugin({
  name: 'my-plugin',
  version: '1.0.0',
  setup(router, ctx) {
    // 实际路径：/api/plugins/my-plugin/items/:id
    router.get('/items/:id', (req) => {
      if (!req.params.id) throw new ApiError(Codes.PARAM_INVALID, 'id is required');
      return { id: req.params.id };
    });
    router.sse('/progress', async (req, sse) => {
      sse.send({ i: 1 }, { event: 'progress' });
      sse.send({ done: true }, { event: 'complete' });
      sse.close();
    });
    ctx.logger.info('ready');
  },
  async dispose() {
    /* 应用退出前调用，超时 3 秒 */
  },
});
```

- 路由只能在 `setup` 执行期间注册；`setup` 超时（3 秒）或抛错视为加载失败，已注册的路由会被删除，其他插件不受影响。
- 插件自定义错误码使用 40000–49999，在插件自己的 README 中说明（示例见 `plugins/hello/README.md`）。
- `GET /api/plugins` 返回各插件的加载状态。
- **插件与主进程同进程运行，拥有完整的 Electron/Node 能力，代码必须按主进程代码的标准审查。**

## 新增路由

内置路由放在 `src/main/routes/`，在 `src/main/index.ts` 中注册：

```ts
// src/main/routes/example.ts
import { ApiError, Codes } from '@shared/api';
import type { Router } from '../chttp/router';

export function registerExampleRoutes(router: Router): void {
  router.post('/api/example', async (req) => {
    const body = await req.json<{ name?: string }>();
    if (!body?.name) throw new ApiError(Codes.PARAM_INVALID, 'name is required');
    return { hello: body.name }; // → { code: 0, msg: 'success', data: { hello } }
  });
}
```

- 返回值包装为 `{code:0,msg:"success",data}`，`undefined` 变为 `null`；直接返回 `Response` 则原样透传。
- 业务错误 `throw new ApiError(code, msg)`；其他异常统一为 30004（打包后不含堆栈）。
- `/api` 下 JSON 响应的 HTTP 状态码固定为 200，成败只看 `code`。
- 同一方法 + 同一路径重复注册会抛错，内置路由重复会导致启动失败。
- 前端统一使用 `src/renderer/api.ts` 的 `request()` / `stream()`；由于 CSP `connect-src 'self'` 且不放开 CORS，访问外部服务需在主进程路由或插件中实现。

## 日志与崩溃转储

| 内容 | 位置 |
|------|------|
| 日志 | `app.getPath('logs')`，Windows 上为 `%APPDATA%\My App\logs\main.log`；超过 5 MB 滚动为 `main.1.log`、`main.2.log`，最多 3 个文件 |
| 崩溃转储 | `app.getPath('crashDumps')`（默认 `%APPDATA%\My App\Crashpad`），只保存在本地、不上传；启动时只保留最新 10 个 `.dmp` |

- 日志行格式：`<ISO 时间> [<级别>] [<模块>] <内容>`；打包后默认 `info`，开发时 `debug`。
- 不记录请求体、凭据头和 IPC 参数原文；插件日志同样写入文件，插件自行脱敏。
- 页面可调用 `window.app.openLogs()` 用系统文件管理器打开日志目录，供反馈问题时取用。
- 应用不做任何遥测，不上传日志或崩溃转储。

---

## 实施记录

> 环境说明：本次实施在 **Linux 容器**（无 Windows、无 Inno Setup）中完成。所有自动检查都在该环境中实际执行；只能在 Windows 上运行的步骤（`make`、`check:tamper`、在 Windows 上跑 E2E）未能执行，记为“未执行（环境）”，需在 Windows / CI（`windows-latest`）上完成。E2E 在 Linux 上以非 root 用户 + Xvfb + openbox 运行，仅作为 Windows E2E 的替身验证。

### 与文档的差异（需确认）

| # | 差异 | 原因 / 处理 |
|---|------|-------------|
| D1 | 初始化命令改为 `npx create-electron-app@latest my-app --template vite --typescript` | `create-electron-app@8` 已移除 `vite-typescript` 模板名，报错提示改用 `--template vite --typescript`（等价模板） |
| D2 | 模板为 Forge 8 / Vite 8 / TypeScript 6，产物为 `.vite/build/main.cjs`、`preload.cjs` | 模板生成的版本即锁定版本，未升级主版本。`package.json` 的 `main`、`window.ts` 的 preload 路径相应改为 `.cjs`；`vite.main.config.ts` / `vite.preload.config.ts` 固定输出文件名（两个入口都叫 `index.ts`，否则会重名） |
| D3 | 移除模板自带的 `oxlint`/`oxfmt`、`electron-squirrel-startup` 与 squirrel/zip/deb/rpm maker、`plugin-auto-unpack-natives` | 第 2 节要求 ESLint + Prettier、Inno maker、`dependencies` 为空 |
| D4 | TS 6 中 `baseUrl` 已弃用，`paths` 改为相对 tsconfig 的 `./src/...` 写法，未写 `baseUrl` | 行为等价 |
| D5 | `scripts/build-plugins.ts` 的 esbuild `target` 为 `node24` | 文档要求与 Electron 内置 Node 主版本一致（44.9.0 内置 Node 24） |
| D6 | `scripts/build-plugins.ts` 的 `buildPlugins()` 增加可选参数 `srcRoot`（默认 `plugins/`），并且无论 `srcRoot` 为何都把仓库 `plugins/` 下的其他插件视为越界 | 供单元测试构造临时插件；默认调用行为不变，校验只增不减 |
| D7 | **`src/main/chttp/static.ts` 开发分支转发请求时去掉 `Origin` 头**（规范级文件） | 实测：把页面请求的 `Origin: chttp://localhost` 原样交给 `net.fetch` 转发到 `http://localhost:5173` 会以 `net::ERR_FAILED` 失败，而 `<script type="module">` 必带 Origin，导致参考实现的开发模式无法加载页面。Origin 已在协议入口 `handleChttp` 校验，去掉它不放松任何安全项；其余请求头原样转发。**请确认此调整** |
| D8 | `src/main/index.ts` 的 `will-quit` 中，插件 dispose 完成后用 `setImmediate(() => app.quit())` 再次退出 | 实测：在 will-quit 派发期间的微任务里同步调用 `app.quit()` 会被 Electron 忽略，应用永远不退出（E2E 发现）。改为下一个宏任务后正常退出 |
| D9 | `src/main/tray.ts` 托盘创建失败只记录错误、不中断启动 | 托盘图标加载失败（例如 Linux 不支持 `.ico`）时，参考实现会让整个启动失败。Windows 上 `.ico` 正常 |
| D10 | `src/renderer/api.ts` 的 `stream()` 在调用方提前 `break` 时 `reader.cancel()` 断开连接；`parseFrame` 导出供测试 | 否则提前结束迭代后底层连接不会关闭 |
| D11 | 签名未启用时（未设置 `WIN_SIGN_BACKEND`）不会对每个文件输出跳过警告 | 第 7.2 节 / 0.4 节要求“未设置时跳过并对每个文件输出警告”，但规范级参考 `forge.config.ts` 只在 `signEnabled` 时才挂签名钩子，两处矛盾。按规范级参考实现保留，**请确认期望行为** |
| D12 | Vite / Vitest 对 `.ts` 配置文件输出 “ESM syntax in a file loaded as CommonJS” 警告 | 文件名按文档使用 `.ts`（模板为 `.mts`），警告不影响构建 |

新增的 devDependencies（均为文档第 2 节选型所需）：`vitest`、`@vitest/coverage-v8`（覆盖率 QA-1）、`esbuild`（插件构建）、`tsx`（运行脚本）、`@playwright/test`（E2E）、`eslint`、`@eslint/js`、`typescript-eslint`、`globals`（ESLint flat config）、`prettier`、`@types/node@24`（与 Electron 内置 Node 24 对应）、`@electron-forge/maker-base`、`@electron-forge/shared-types`（自定义 maker 与配置类型）。

红线检查：协议主机名 / origin 字面量由 ESLint `no-restricted-syntax` 规则拦截（`src/shared/ipc.ts`、`src/main/chttp/scheme.ts`、测试与 Vite 配置除外）。`installer/app.iss` 的 `AppId` 已生成为 `{A7C56DA0-8034-4694-AC44-D118E730B14F}`，此后禁止修改。

### M1 工程骨架

| 项 | 状态 |
|----|------|
| 需求 | FR-BLD-1~5、FR-WIN-1~8、FR-IPC-1~5、FR-LOG-1~6、SEC-1/3/4、CI（QA-3） |
| 测试 | `tests/unit/logger.test.ts`（日志格式、级别、滚动、写失败降级、崩溃转储清理）；E2E 覆盖窗口/关闭流程/IPC |
| 基础检查 | lint ✅ 通过，typecheck ✅ 通过，test ✅ 通过 |
| 未通过 | 无 |
| 待人工验收 | Windows 上 `npm start` 显示示例页；单实例（二次启动聚焦已有窗口）；托盘单击显示、右键“显示主窗口/退出”；3.6 关闭流程（Alt+F4 / 任务栏关闭、取消 / 最小化到托盘 / 退出、托盘退出不再询问、刷新后能正常关闭）；`openLogs()` 打开日志目录；右键菜单（复制/全选，输入框内剪切/粘贴）；系统深色模式切换时页面跟随 |

### M2 chttp 核心

| 项 | 状态 |
|----|------|
| 需求 | FR-PRT-1~9、FR-RTE-1~11、FR-SSE-1~8、`/api/ping`、SEC-5/8 |
| 测试 | `tests/unit/router.test.ts`、`tests/unit/sse.test.ts`、`tests/unit/static.test.ts`；E2E：主机名 404、跨源 Origin 403、CSP、`/api/ping` |
| 基础检查 | ✅ 通过 |
| 未通过 | 无 |
| 待人工验收 | Windows 上开发模式 HMR 与开发 CSP（Linux 下已通过 CDP 验证：页面 origin 为 `chttp://localhost`，CSP 的 `connect-src` 为 `'self' ws://localhost:5173`，修改 CSS 后无需刷新即生效） |

**技术验证项结论**（Linux 实测，E2E 中保留了对应用例，Windows CI 会再次验证）：

1. **渲染进程中止 `fetch` 时，`protocol.handle` 返回的 `ReadableStream` 会触发 `cancel`。** 用例 `M2 verification 1`（独立 session 中注册探针处理函数，记录 `cancel` 调用）通过，因此 FR-SSE-5 采用流的 `cancel` 回调，无需“写入失败 + 心跳检测”的备用方案。
2. **原生 `EventSource` 可以连接 `chttp://localhost/api/...`。** 用例 `M2 verification 2` 收到了 `progress` ×2 与 `complete` 事件。前端仍统一使用 `stream()` 客户端。
3. **`npm run package` 后可以在项目根目录用 `electron .` 启动未打包构建并正常加载页面。** `package` 在根目录生成 `.vite/build/main.cjs`、`.vite/build/preload.cjs`、`.vite/renderer/main_window/`，E2E 以 `electron .` 启动成功，`app.isPackaged === false`，静态资源走生产分支。

### M3 插件与任务

| 项 | 状态 |
|----|------|
| 需求 | FR-PLG-1~10、FR-TSK-1~7、SDK、示例插件 `hello` |
| 测试 | `tests/unit/loader.test.ts`（成功、setup 抛错、模块加载失败、名称不一致、非法目录名、setup 超时、setup 结束后注册路由、重复路由、dispose 及超时）、`tests/unit/build-plugins.test.ts`（临时插件：导入其他插件失败、导入 `src/` 内部模块失败、`.node` 原生模块失败、单文件 CJS 产物）、`tests/unit/auto-import.test.ts`（假定时器，含 pauseAll / restartAll）；E2E：`/api/plugins`、hello 的 JSON 与 SSE、`PUT /api/tasks` |
| 基础检查 | ✅ 通过；单元测试覆盖率：语句 98.4%、分支 96.4%、函数 99.0%、行 98.5% |
| 未通过 | 无 |
| 待人工验收 | — |

### M4 发布

| 项 | 状态 |
|----|------|
| 需求 | SEC-2/6/7、Fuses、CSP、Inno maker、签名接入点、篡改检查脚本、E2E、7.1 安装包规格 |
| 基础检查 | ✅ 通过 |
| `npm audit --omit=dev --audit-level=high` | ✅ 通过（0 vulnerabilities） |
| `npm run package` | ✅ 通过（Linux 交叉打包 win32/x64；Fuses 读回与 SEC-6 一致；`app.asar` 内含 `.vite/` 与 `plugins/hello/index.js`） |
| `npm run test:e2e` | ✅ 14/14 通过（**Linux 替身环境**；Windows 上待 CI 验证） |
| `npm run make` | ⛔ 未执行（环境）：需要 Windows + Inno Setup 6。在 Linux 上执行时按 FR-BLD-5 明确报错 |
| `npm run check:tamper` | ⛔ 未执行（环境）：需要在 Windows 上启动 exe。脚本中定位 `app.asar` 内 `main.cjs` 偏移的逻辑已对实际打包产物验证 |
| 待人工验收 | 见下方清单 |

**M4 人工验收清单**（状态均为“待人工验收”）：

1. 安装：双击 `My App_x64_1.0.0_setup.exe`，确认**不弹 UAC**，默认安装到 `%LOCALAPPDATA%\Programs\My App`，开始菜单有快捷方式，“创建桌面快捷方式”默认不勾选。
2. 覆盖升级：应用运行时修改 `package.json` 版本号重新 `make` 并安装，确认安装程序先关闭正在运行的应用，覆盖安装成功，“应用和功能”中只有一项。
3. 卸载：卸载后确认安装目录与 `%APPDATA%\My App`（缓存、日志、崩溃转储）均被删除。
4. SEC 清单逐项核对：SEC-1（DevTools 中 `typeof require === 'undefined'`）、SEC-2（不注入 CORS 头）、SEC-3（页面请求摄像头/通知被拒绝）、SEC-4（导航到外部地址被阻止，`window.open` 的 http 链接在系统浏览器打开，`<webview>` 无法挂载）、SEC-5（打包后响应头 CSP）、SEC-6（`npx @electron/fuses read --app <exe>`）、SEC-7（CI audit）、SEC-8（开发模式 CSP）。
5. PERF 实测并记录：PERF-1 冷启动到窗口显示 ≤ 2 秒（先确定基准机器）；PERF-2 `GET /api/ping` P95 ≤ 5 ms；PERF-3 单条 SSE 每秒 10 条连续 10 分钟，主进程内存无持续增长；PERF-4 安装包 ≤ 120 MB。
   - 参考数据（Linux 容器 + Xvfb，**不是基准机器**）：`electron .` 启动到窗口可见约 0.3 s；`/api/ping` 500 次往返 P50 1.8 ms、P95 2.8 ms。

### 需求与测试对应关系

| 需求 | 测试或验收方式 | 状态 |
|------|----------------|------|
| FR-BLD | CI 流水线（`.github/workflows/ci.yml`） | lint/typecheck/test/package 本地通过；make 待 Windows |
| FR-PRT-2/3、FR-RTE-10 协议层部分 | E2E `rejects other hosts (404) and cross-origin requests (403)` | 通过（Linux 替身） |
| FR-PRT-5~8 | `static.test.ts` | 通过 |
| FR-PRT-9 | `static.test.ts`（开发分支）+ 人工 | 单测通过；HMR 待 Windows 人工验收 |
| FR-RTE | `router.test.ts` | 通过 |
| FR-SSE | `sse.test.ts` | 通过 |
| FR-PLG | `loader.test.ts`、`build-plugins.test.ts` | 通过 |
| FR-TSK | `auto-import.test.ts` | 通过 |
| FR-LOG-2/3 | `logger.test.ts` | 通过 |
| FR-LOG-5/6 | 人工验收（`logger.test.ts` 另覆盖了转储清理） | 待人工验收 |
| FR-WIN、FR-IPC | E2E（最小化/最大化、关闭流程、刷新重置、openExternal 协议限制、导航/弹窗限制）+ 人工 | E2E 通过（Linux 替身）；其余待人工验收 |
| SEC | `check:tamper` + M4 人工核对 | 待 Windows |
| PERF | M4 人工实测 | 待人工验收 |

### 待定事项

- 代码签名后端（自建远程服务 / Azure Trusted Signing / 云 HSM 证书）未定，只影响 `scripts/sign-hook.cjs` 与 CI 密钥配置；确定前产出未签名安装包。
