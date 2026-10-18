# My App —— Windows 桌面壳（Electron + TypeScript + chttp 虚拟 HTTP 服务）

[![CI](https://github.com/wjzhangq/electron_tp/actions/workflows/ci.yml/badge.svg?branch=claude/eloquent-fermat-tw888z)](https://github.com/wjzhangq/electron_tp/actions/workflows/ci.yml)

只运行在 **Windows x64** 的 Electron 桌面壳：前端页面与后端接口都通过自定义协议 `chttp://localhost` 提供，“虚拟 HTTP Server”**不监听任何端口**，支持 JSON 接口与 SSE 流式接口，业务能力可以内置路由或插件的形式扩展。

接口处理（Router、插件、内置路由）运行在独立的 **API 服务进程**（Electron `utilityProcess`）中：主进程只负责协议入口的主机名 / Origin 校验、静态资源、窗口、托盘与 IPC，并把 `/api` 请求经每请求一对 `MessagePort` 转发给服务进程。接口里的耗时计算或大文件处理不会卡住窗口拖动、托盘和 IPC；服务进程崩溃后会自动重启（60 秒内最多 3 次，期间接口返回 503）。

## 快速开始

**直接使用安装包**

1. 打开 [Actions › CI](https://github.com/wjzhangq/electron_tp/actions/workflows/ci.yml)，进入最近一次成功的运行，在 Artifacts 中下载 `installer`，解压得到 `My App_x64_<version>_setup.exe`。
2. 双击安装（按用户安装，不需要管理员权限）。安装包未签名，SmartScreen 提示时选择“更多信息 → 仍要运行”。
3. 从开始菜单启动 **My App**。卸载：“设置 → 应用 → 已安装的应用 → My App → 卸载”，会同时删除 `%APPDATA%\My App`。

**从源码运行**

```bash
git clone https://github.com/wjzhangq/electron_tp.git
cd electron_tp
npm ci
npm start          # 开发模式（Vite HMR）
npm run make       # 生成安装包 out/make/inno/x64/My App_x64_<version>_setup.exe（需 Inno Setup 6）
```

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
src/main/                  主进程（协议入口与转发、静态资源、API 服务进程管理、窗口、托盘、IPC、日志、定时器）
src/api/                   API 服务进程（utilityProcess）：Router、SSE、插件加载、内置路由
src/preload/index.ts       contextBridge → window.app
src/renderer/              示例前端 + api 客户端（request / stream）
src/shared/                main / api / preload / renderer 共享的类型与常量（含主进程 ↔ 服务进程的消息格式 wire.ts）
src/sdk/index.ts           插件 SDK（插件唯一可导入的内部模块）
plugins/hello/             示例插件
tests/unit/                Vitest 单元测试
tests/e2e/                 Playwright（Electron 模式）E2E
```

## 开发

前提：Windows 10/11 x64，Node.js 22 LTS 或更高（推荐 24，与 CI 及 Electron 内置的 Node 主版本一致），Git。

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

## 持续集成

`.github/workflows/ci.yml` 在每次 push 和 pull request 时运行于 GitHub Actions `windows-latest`：

| 项 | 配置 |
|----|------|
| Node.js | 24（`actions/setup-node@v7`，启用 npm 缓存） |
| Actions | `actions/checkout@v7`、`actions/setup-node@v7`、`actions/upload-artifact@v7`（均为 Node 24 运行时） |
| Inno Setup | runner 上没有 `ISCC.exe` 时执行 `choco install innosetup -y` |
| 步骤 | `npm ci` → `npm audit --omit=dev --audit-level=high` → lint → typecheck → test → make → test:e2e → check:tamper |
| 构件 | `installer`：`out/make/inno/x64/*.exe`；失败时额外上传 `playwright-report`（`test-results/`、`playwright-report/`） |

安装包可在对应 Actions 运行页面的 Artifacts 中下载（未签名）。

## 使用说明

### 示例页面

启动后主窗口加载 `chttp://localhost/`（`index.html` + `src/renderer/main.ts`），用来演示壳的全部能力，业务前端替换这两个文件即可：

| 区域 | 功能 |
|------|------|
| 自绘标题栏 | 可拖动；右侧按钮依次为最小化、最大化/还原、关闭 |
| 应用信息 | 显示 `window.app.info()` 的结果；“打开日志目录”；“切换 DevTools”（仅开发模式） |
| 接口 | `GET /api/ping`、hello 插件的 JSON 接口与 SSE 计数、设置主进程定时器（每 10 秒在输出区显示一次 tick） |
| 关闭行为 | 勾选“页面接管关闭”时，点关闭 / Alt+F4 会弹出询问：最小化到托盘、退出、取消（每次都问，不记住选择）；不勾选则直接退出 |
| 托盘 | 单击显示主窗口；右键菜单“显示主窗口”“退出”（托盘退出不再询问） |
| 右键菜单 | 复制、全选；输入框内额外提供剪切、粘贴 |

应用为单实例：再次启动时会恢复并聚焦已打开的窗口。

### 前端调用接口

页面与接口同源，直接用相对路径；推荐使用 `src/renderer/api.ts` 封装的客户端：

```ts
import { request, stream } from './api';
import { ApiError } from '@shared/api';

// JSON 接口：2xx 时返回响应数据（204 为 undefined），否则抛出 ApiError
const { pong } = await request<{ pong: boolean; time: number }>('/ping');
const greet = await request<{ message: string }>('/plugins/hello/greet', { query: { name: 'Tom' } });
const echo = await request('/plugins/hello/echo', { body: { text: 'hi' } }); // 有 body 时默认 POST

try {
  await request('/plugins/hello/greet');
} catch (e) {
  if (e instanceof ApiError) console.log(e.status, e.code, e.message); // 400 BAD_REQUEST name is required
}

// SSE 接口：逐个产出 { event, data, id }；abort() 或提前 break 即断开连接
const ac = new AbortController();
for await (const e of stream<{ i: number; total: number }>('/plugins/hello/count', { query: { n: 5 }, signal: ac.signal })) {
  if (e.event === 'progress') console.log(`${e.data.i}/${e.data.total}`);
  if (e.event === 'complete') break;
  if (e.event === 'error') throw new Error(JSON.stringify(e.data)); // data 为 { code, message }
}
// 建立连接失败（非 2xx）时 stream() 直接抛出 ApiError；响应不是 text/event-stream 时也会抛错，不会静默结束
```

- **成败只看 HTTP 状态码**：成功为 200（JSON 响应体就是数据本身）或 204（处理函数返回 `undefined`，无响应体）；失败为 4xx/5xx，响应体统一为 `{ code, message }`。`fetch` 的 `res.ok`、缓存和网关都能正确识别失败。
- `code` 是唯一的一套机器可读码（大写下划线字符串），默认由状态码推导；只有需要区分同一状态下的不同原因时才自定义（例如 hello 插件的 `HELLO_TEXT_INVALID`），自定义码建议带插件名前缀。
- 原生 `EventSource` 也能连接，但只支持 GET、无法携带请求体，统一使用 `stream()`。
- CSP 为 `connect-src 'self'`，页面不能直接请求外部地址；需要时在内置路由或插件中实现，再通过 `/api` 提供。

| HTTP 状态 | code | 含义 |
|-----------|------|------|
| 400 | `BAD_REQUEST` | 参数缺失或校验失败、路径参数编码错误 |
| 400 | `INVALID_JSON` | 请求体 JSON 解析失败 |
| 404 | `NOT_FOUND` | 接口不存在 |
| 405 | `METHOD_NOT_ALLOWED` | 请求方法不允许（响应带 `Allow` 头） |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体过大（默认上限 10 MB，边读边计数，超限立即中止） |
| 500 | `INTERNAL` | 服务内部异常（打包后不含细节） |
| 503 | `UNAVAILABLE` | API 服务进程不可用（重启中或重启次数超限） |
| 其他 4xx/5xx | 由状态码推导，或插件自定义 | 见 `ErrorCodes`（`src/shared/api.ts`） |

内置接口：

| 方法 | 路径 | 请求 | 响应体 |
|------|------|------|-------------|
| GET | `/api/ping` | — | `{ pong: true, time }` |
| GET | `/api/plugins` | — | `[{ name, version, status: 'loaded' \| 'failed', error? }]` |

### `window.app` 桥接

只用于窗口控制、应用信息等 HTTP 无法表达的能力（类型见 `src/shared/ipc.ts`）。窗口相关方法都作用于**调用方所在的窗口**（主进程用 `BrowserWindow.fromWebContents(sender)` 定位），多窗口时互不影响：

| 方法 / 事件 | 说明 |
|-------------|------|
| `info()` | `{ name, version, electron, chrome, node, arch, locale, isDark, isPackaged }` |
| `openExternal(url)` | 用系统浏览器打开，只接受 http/https |
| `openLogs()` | 用文件管理器打开日志目录 |
| `toggleDevTools()` | 切换 DevTools，仅开发模式生效 |
| `window.minimize()` / `window.toggleMaximize()` / `window.close()` | 窗口控制；`close()` 进入关闭流程 |
| `window.onCloseRequested(cb)` → 取消函数 | 注册即接管关闭，调用取消函数后不再接管 |
| `window.closeAction('tray' \| 'quit')` | 响应关闭询问 |
| `window.onMaximizeChanged(cb)` | 最大化状态变化 |
| `onThemeChanged(cb)` | 系统深色模式变化，参数为 `isDark` |
| `timers.set({ id, intervalSec, data? })` / `timers.clear(id)` / `timers.list()` | 主进程定时器，归属当前页面 |
| `timers.onTick(cb)` | 定时器到点，参数为 `{ id, data, nextRunAt }` |

所有 `on*` 方法都返回取消订阅函数。

**接管关闭**：

```ts
const off = window.app.window.onCloseRequested(async () => {
  const choice = await showMyDialog(); // 'tray' | 'quit' | 'cancel'，由业务 UI 实现
  if (choice !== 'cancel') await window.app.window.closeAction(choice); // 取消时什么都不调用
});
// 不再需要接管时调用 off()；页面刷新或渲染进程崩溃后接管自动失效，需要重新注册
```

页面卡死时壳不接管关闭：preload 收到关闭请求后会立即回执；如果页面已被报告无响应，或 1.5 秒内没有回执（主线程被同步代码占住），窗口直接关闭，不会出现“点关闭没反应”。

**主进程定时器**：

壳只提供“主进程计时、到点通知页面”这一机制（不受后台页面节流影响），名称、最小间隔和存储策略留给具体业务决定。

```ts
const off = window.app.timers.onTick(({ id, data }) => {
  /* 到点处理 */
});
// 新建或更新；同一 id 间隔不变时只替换 data，不重新计时；intervalSec 为正整数秒
await window.app.timers.set({ id: 'sync', intervalSec: 60, data: { src: 'a' } });
await window.app.timers.clear('sync');
```

定时器只保存在内存中，归属调用它的页面：页面刷新、导航、崩溃或窗口关闭后自动清除，需要时由页面重新设置；系统睡眠期间暂停，恢复后从当前时刻重新计时，不补发。

### 自定义应用

| 要改的 | 位置 |
|--------|------|
| 应用名（窗口、托盘提示、安装包、`%APPDATA%` 目录名） | `package.json` 的 `productName` |
| 版本号（安装包文件名、`info().version`） | `package.json` 的 `version` |
| exe 文件名 | `forge.config.ts` 的 `packagerConfig.executableName` 与 `MakerInno` 的 `exeName`（两处保持一致） |
| 发布者 | `forge.config.ts` 中 `MakerInno` 的 `publisher` |
| 图标 | `assets/icon.ico`（exe 与安装包）、`assets/tray.ico`（托盘） |
| 页面标题与内容 | `index.html`、`src/renderer/` |

注意：`installer/app.iss` 中的 `AppId` 决定覆盖升级的识别，**发布后永不修改**；修改 `productName` 会改变用户数据目录。

## 新增插件

1. 新建 `plugins/<name>/index.ts`，`<name>` 必须匹配 `^[a-z][a-z0-9-]*$`。
2. 只能导入 `@app/sdk`、`electron`、Node 内置模块和可被 esbuild 打进单文件的 npm 包；**禁止导入其他插件或 `src/` 下的内部模块**，不支持原生模块（`.node`），违反时构建失败。
3. 默认导出 `definePlugin`，`name` 与目录名一致：

```ts
import { ApiError, definePlugin } from '@app/sdk';

export default definePlugin({
  name: 'my-plugin',
  version: '1.0.0',
  setup(router, ctx) {
    // 实际路径：/api/plugins/my-plugin/items/:id
    router.get('/items/:id', (req) => {
      if (!req.params.id) throw new ApiError(400, 'id is required'); // → 400 { code: 'BAD_REQUEST', message }
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
- 业务错误 `throw new ApiError(status, message, code?)`；需要自定义 `code` 时使用带插件名前缀的大写字符串，并在插件自己的 README 中说明（示例见 `plugins/hello/README.md`）。SSE 中途出错用 `sse.error(code, message)`。
- `GET /api/plugins` 返回各插件的加载状态。
- 插件运行在 API 服务进程（`utilityProcess`）中：可以使用 Node 能力，但不能使用 `BrowserWindow`、`app` 等主进程专属 API；插件里的阻塞不会卡住窗口，但会阻塞同进程的其他接口，耗时任务仍应异步化或放进 worker。
- 插件之间以及插件与内置路由共享同一个服务进程，代码仍需按可信代码的标准审查。

## 新增路由

内置路由放在 `src/api/routes/`，在 `src/api/index.ts` 中注册（运行在 API 服务进程中）：

```ts
// src/api/routes/example.ts
import { ApiError } from '@shared/api';
import type { Router } from '../router';

export function registerExampleRoutes(router: Router): void {
  router.post('/api/example', async (req) => {
    const body = await req.json<{ name?: string }>();
    if (!body?.name) throw new ApiError(400, 'name is required');
    return { hello: body.name }; // → 200 { hello }
  });
}
```

- 返回值直接作为 200 JSON 响应体；返回 `undefined` 时为 204；直接返回 `Response` 则原样透传。
- 业务错误 `throw new ApiError(status, message, code?)`；其他异常统一为 500 `INTERNAL`（打包后不含细节）。
- 同一方法 + 同一路径重复注册会抛错，内置路由重复会导致启动失败。
- 前端统一使用 `src/renderer/api.ts` 的 `request()` / `stream()`；由于 CSP `connect-src 'self'` 且不放开 CORS，访问外部服务需在内置路由或插件中实现。

## 日志与崩溃转储

| 内容 | 位置 |
|------|------|
| 日志 | `app.getPath('logs')`，Windows 上为 `%APPDATA%\My App\logs\main.log`；超过 5 MB 滚动为 `main.1.log`、`main.2.log`，最多 3 个文件 |
| 崩溃转储 | `app.getPath('crashDumps')`（默认 `%APPDATA%\My App\Crashpad`），只保存在本地、不上传；启动时只保留最新 10 个 `.dmp` |

- 日志行格式：`<ISO 时间> [<级别>] [<模块>] <内容>`；打包后默认 `info`，开发时 `debug`。
- 不记录请求体、凭据头和 IPC 参数原文；API 服务进程（含插件）的日志经消息转交主进程，写入同一个日志文件，插件自行脱敏。
- 页面可调用 `window.app.openLogs()` 用系统文件管理器打开日志目录，供反馈问题时取用。
- 应用不做任何遥测，不上传日志或崩溃转储。

---

## 实施记录

> 环境说明：代码在 Linux 容器中开发，并在 Linux 上以非 root 用户 + Xvfb + openbox 跑过 E2E 作为替身验证。全部自动检查（含 `make`、`test:e2e`、`check:tamper`）已在 GitHub Actions `windows-latest` 上实际执行并通过：[CI run #5](https://github.com/wjzhangq/electron_tp/actions/runs/39100754341)（提交 `23d7a66`，Node 24 + actions v7）。

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

**技术验证项结论**（Linux 实测，并由 Windows CI 的 E2E 用例再次验证通过）：

1. **（Linux 与 Windows CI 均通过）渲染进程中止 `fetch` 时，`protocol.handle` 返回的 `ReadableStream` 会触发 `cancel`。** 用例 `M2 verification 1`（独立 session 中注册探针处理函数，记录 `cancel` 调用）通过，因此 FR-SSE-5 采用流的 `cancel` 回调，无需“写入失败 + 心跳检测”的备用方案。
2. **原生 `EventSource` 可以连接 `chttp://localhost/api/...`。** 用例 `M2 verification 2` 收到了 `progress` ×2 与 `complete` 事件。前端仍统一使用 `stream()` 客户端。
3. **`npm run package` 后可以在项目根目录用 `electron .` 启动未打包构建并正常加载页面。** `package` 在根目录生成 `.vite/build/main.cjs`、`.vite/build/preload.cjs`、`.vite/renderer/main_window/`，E2E 以 `electron .` 启动成功，`app.isPackaged === false`，静态资源走生产分支。

### M3 插件与任务

> 本节为 M3 当时的记录。其中 AutoImport（`auto-import.test.ts`、`PUT /api/tasks`）已在后续“架构调整”中被通用定时器取代，当前测试见“需求与测试对应关系”。

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
| `npm run test:e2e` | ✅ Windows（[CI run #5](https://github.com/wjzhangq/electron_tp/actions/runs/39100754341)）14/14 通过；Linux 替身环境同样 14/14 |
| `npm run make` | ✅ Windows 通过（[CI run #5](https://github.com/wjzhangq/electron_tp/actions/runs/39100754341)），产出 `My App_x64_1.0.0_setup.exe`，作为 CI 构件 `installer` 上传（zip 约 109 MiB）。在 Linux 上执行时按 FR-BLD-5 明确报错 |
| `npm run check:tamper` | ✅ Windows 通过（[CI run #5](https://github.com/wjzhangq/electron_tp/actions/runs/39100754341)）：篡改 `app.asar` 中 `main.cjs` 的一个字节后应用约 2 秒内以退出码 1 退出；未篡改版 5 秒后仍在运行 |
| 待人工验收 | 见下方清单 |

**M4 人工验收清单**（状态均为“待人工验收”）：

1. 安装：双击 `My App_x64_1.0.0_setup.exe`，确认**不弹 UAC**，默认安装到 `%LOCALAPPDATA%\Programs\My App`，开始菜单有快捷方式，“创建桌面快捷方式”默认不勾选。
2. 覆盖升级：应用运行时修改 `package.json` 版本号重新 `make` 并安装，确认安装程序先关闭正在运行的应用，覆盖安装成功，“应用和功能”中只有一项。
3. 卸载：卸载后确认安装目录与 `%APPDATA%\My App`（缓存、日志、崩溃转储）均被删除。
4. SEC 清单逐项核对：SEC-1（DevTools 中 `typeof require === 'undefined'`）、SEC-2（不注入 CORS 头）、SEC-3（页面请求摄像头/通知被拒绝）、SEC-4（导航到外部地址被阻止，`window.open` 的 http 链接在系统浏览器打开，`<webview>` 无法挂载）、SEC-5（打包后响应头 CSP）、SEC-6（`npx @electron/fuses read --app <exe>`）、SEC-7（CI audit）、SEC-8（开发模式 CSP）。
5. PERF 实测并记录：PERF-1 冷启动到窗口显示 ≤ 2 秒（先确定基准机器）；PERF-2 `GET /api/ping` P95 ≤ 5 ms；PERF-3 单条 SSE 每秒 10 条连续 10 分钟，主进程内存无持续增长；PERF-4 安装包 ≤ 120 MB（CI 构件 zip 约 109 MiB，需以安装包 exe 实际大小为准，余量不大）。
   - 参考数据（Linux 容器 + Xvfb，**不是基准机器**）：`electron .` 启动到窗口可见约 0.3 s；`/api/ping` 500 次往返 P50 1.8 ms、P95 2.8 ms。

### 需求与测试对应关系

| 需求 | 测试或验收方式 | 状态 |
|------|----------------|------|
| FR-BLD | CI 流水线（`.github/workflows/ci.yml`） | 通过（Windows CI） |
| FR-PRT-2/3、FR-RTE-10 协议层部分 | E2E `rejects other hosts (404) and cross-origin requests (403)` | 通过（Windows CI） |
| 主进程 ↔ API 服务进程转发 | `forward.test.ts`（真实 `MessageChannel`：流式请求体、413、204、SSE、背压、取消、断连 503）；E2E `API runs in a separate utility process and is restarted after a crash` | 单测通过；E2E Linux 通过，待 Windows CI |
| FR-PRT-5~8 | `static.test.ts` | 通过 |
| FR-PRT-9 | `static.test.ts`（开发分支）+ 人工 | 单测通过；HMR 待 Windows 人工验收 |
| FR-RTE、错误模型 | `router.test.ts`、`shared-api.test.ts`、`renderer-api.test.ts` | 通过 |
| FR-SSE | `sse.test.ts` | 通过 |
| FR-PLG | `loader.test.ts`、`build-plugins.test.ts` | 通过 |
| 定时器（取代 FR-TSK） | `timers.test.ts`；E2E `main-process timers notify the owning page and are cleared on reload` | 单测通过；E2E Linux 通过，待 Windows CI |
| FR-LOG-2/3 | `logger.test.ts` | 通过 |
| FR-LOG-5/6 | 人工验收（`logger.test.ts` 另覆盖了转储清理） | 待人工验收 |
| FR-WIN、FR-IPC | E2E（最小化/最大化、关闭流程、刷新重置、页面卡死时关闭、IPC 作用于调用方窗口、openExternal 协议限制、导航/弹窗限制）+ 人工 | 原有用例 Windows CI 通过；新增用例 Linux 通过，待 Windows CI；其余待人工验收 |
| SEC | `check:tamper` + M4 人工核对 | `check:tamper` 通过（Windows CI）；人工核对待验收 |
| PERF | M4 人工实测 | 待人工验收 |

### 待定事项

- 代码签名后端（自建远程服务 / Azure Trusted Signing / 云 HSM 证书）未定，只影响 `scripts/sign-hook.cjs` 与 CI 密钥配置；确定前产出未签名安装包。

### 架构调整（API 服务进程、多窗口、关闭兜底、定时器、错误模型）

| 调整 | 说明 |
|------|------|
| API 服务进程 | Router、SSE、插件加载与内置路由移到 `src/api/`，以 `utilityProcess` 运行（构建产物 `.vite/build/api.cjs`）。主进程 `protocol.handle` 只做校验与转发（`src/main/chttp/forward.ts` ↔ `src/api/serve.ts`）：请求体流式上送；响应体按拉取传输，主进程每要一块才从服务进程读一块，SSE 的慢消费者保护（FR-SSE-8）在服务进程照常生效。`src/main/chttp/api-host.ts` 负责启动、崩溃重启（60 秒内最多 3 次）和退出前调用插件 `dispose`。 |
| 关闭兜底 | preload 对每次 `close-requested` 立即回执；页面无响应或 1.5 秒内无回执时不再接管关闭。E2E `close flow: a hung page does not block closing` 覆盖。 |
| 多窗口 | 窗口状态按 `BrowserWindow` 存放；所有窗口经 `createWindow()` 创建；IPC 按 sender 定位窗口；主题变化广播到所有窗口。 |
| 定时器 | 删除 AutoImport 与 `/api/tasks`，改为页面私有的 `window.app.timers`（`src/main/timers.ts`）。 |
| 错误模型 | HTTP 状态码表达成败，失败体 `{ code, message }`，`code` 为单一字符串命名空间；删除 `{ code, msg, data }` 包装与数字业务码。 |

验证情况（Linux 容器 + Xvfb + openbox）：

| 检查 | 结果 |
|------|------|
| `npm run lint`、`npm run typecheck` | ✅ 通过 |
| `npm test` | ✅ 119/119 通过，覆盖率高于 80% 阈值 |
| `npm run test:e2e` | ✅ 17/17 通过（新增：定时器、API 服务进程崩溃重启、多窗口 IPC、页面卡死关闭） |
| 打包布局 | ✅ 用 Linux Electron 运行打包出的 `app.asar`（`isPackaged === true`）：服务进程从 asar 内加载 `api.cjs`，并从 `app.asar/plugins` 加载 `hello` 插件 |
| Windows（`make`、E2E、`check:tamper`） | 待 CI 运行 |

