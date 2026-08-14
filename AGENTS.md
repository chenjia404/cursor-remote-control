# AGENTS.md

## 项目概述

这是一个运行在 Windows 本机的 Cursor 远程控制台。用户通过手机浏览器访问 Web 页面，登录后选择本机项目，把任务提交给 Cursor SDK 本地 Agent 执行。

项目目标是“远程让 Cursor 修改本机项目”，不是远程 Shell。任何修改都必须继续维护这个安全边界。

## 技术栈

- 运行时：Node.js
- 语言：TypeScript，ESM
- 包管理器：pnpm
- Web 框架：Fastify
- Agent 调用：`@cursor/sdk`
- 前端：原生 HTML/CSS/JS，静态托管
- PWA：`manifest.webmanifest` + `sw.js`

## 常用命令

```powershell
cd D:\code\cursor-remote-control
pnpm install
pnpm typecheck
pnpm build
pnpm start
```

开发模式：

```powershell
pnpm dev
```

初始化管理员配置：

```powershell
pnpm init-admin
```

重新生成 PWA 图标：

```powershell
pnpm generate-icons
```

## 关键目录和文件

- `src/server.ts`：Fastify 服务入口、路由注册、静态文件托管。
- `src/auth.ts`：管理员登录、密码哈希、Session Cookie、CSRF 校验。
- `src/config.ts`：环境变量读取和配置校验。
- `src/projects.ts`：已选项目持久化、目录浏览、路径安全校验与项目标记检测。
- `src/jobs.ts`：任务历史、多轮对话、任务状态、日志持久化。
- `src/cursorAgent.ts`：Cursor SDK 本地 Agent 执行封装。
- `src/public/`：移动端 Web 页面和 PWA 静态资源。
- `src/public/i18n.js`：前端中英文文案与语言切换（偏好保存在 localStorage）。
- `README.en.md`：英文说明文档，与 `README.md` 互链。
- `scripts/init-admin.ts`：生成管理员随机密码、密码哈希和 Session 密钥。
- `scripts/generate-icons.ts`：从 SVG 生成 PWA PNG 图标。
- `.env.example`：配置模板，不包含真实密钥。
- `data/`：运行时数据目录，不要提交其中的真实数据。

## 安全约束

- 不要添加任意 Shell 输入框。
- 不要允许网页直接执行系统命令。
- 不要把 `.env`、管理员密码、`CURSOR_API_KEY`、Session 密钥或 `data/` 下的运行时数据写入 Git。
- 提交说明、代码注释、文档和示例中不要写入真实域名、IP、隧道地址、机器名、邮箱、密钥或个人云服务实例名；用泛称（CDN、反代）或占位符（`https://your.example.com`）。详见 `.cursor/rules/no-private-info.mdc`。
- `PROJECT_ROOTS` 只应配置本机 Windows 项目根目录，例如 `E:\code;D:\code;C:\code`，不要配置整个系统盘，也不要使用 Docker 容器内路径。

- 项目路径必须经过 `src/projects.ts` 的根目录校验后才能传给 Cursor SDK。
- 公网访问时必须使用 HTTPS 反代；本服务仍只监听 HTTP。把 `COOKIE_SECURE=true`，并设置 `PUBLIC_BASE_URL=https://...`；反代需转发 `X-Forwarded-Proto`。
- 新增接口如果会改变状态，必须经过登录和 CSRF 校验。
- 任务日志、错误输出和审计信息中不要输出敏感环境变量。

## 开发约定

- 所有回复、注释和文档使用简体中文。
- Node 项目使用 pnpm，不要切换到 npm 或 yarn。
- 保持实现简单，优先沿用当前 Fastify + 原生前端结构。
- 修改后至少运行 `pnpm typecheck` 和 `pnpm build`。
- 如果改动 PWA 缓存资源，记得更新 `src/public/sw.js` 的 `CACHE_NAME` 或确认缓存更新策略不会让旧资源长期留存。
- 如果新增前端静态资源，确认它能被 `@fastify/static` 从 `src/public` 正确托管。
- 如果改动生产启动路径，确认 `pnpm build` 后 `pnpm start` 使用的文件路径仍然正确。

## 运行和重启提示

默认端口是 `20267`。如果需要重启服务，可以先检查端口：

```powershell
Get-NetTCPConnection -LocalPort 20267 -State Listen -ErrorAction SilentlyContinue
```

如果服务由独立 PowerShell 进程启动，日志通常写入：

```text
D:\code\cursor-remote-control\data\server.log
```

健康检查：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:20267/health" | ConvertTo-Json -Compress
```

## 开机自启（Windows）

登录后延迟启动（默认 60 秒），不依赖 Cursor IDE：

```powershell
pnpm autostart:install
# 或自定义延迟秒数：
pwsh -File scripts/install-autostart.ps1 -DelaySeconds 120
```

立即后台启动一次：

```powershell
pnpm autostart:start
```

取消自启：

```powershell
pnpm autostart:uninstall
```

计划任务名：`CursorRemoteControl`。登录后跑的是 `scripts/watchdog.ps1`：发现 20267 没人听才调用 `start-server.ps1`，不会杀掉已在运行的服务。日志：`data/watchdog.log`、`data/server.log`。

立即挂上守护（前台循环，适合用新窗口）：`pnpm autostart:watch`。停止守护不停 Node：`pnpm autostart:watch:stop`。重新注册任务：`pnpm autostart:install`。

## Cursor SDK 注意事项

- 当前使用本地模式执行 Agent，`cwd` 必须是经过校验的项目目录。
- `CURSOR_API_KEY` 必须在 `.env` 中配置真实值。
- `CURSOR_MODEL` 默认可使用 `auto`。
- `CURSOR_DEFAULT_MODE` 可选 `agent` 或 `plan`，作为未指定模式时的默认值。
- Cursor SDK 当前仅支持 `agent` 与 `plan` 两种对话模式；可通过 `Agent.create({ mode })` 与 `agent.send(prompt, { mode })` 切换。
- Agent 输出是流式分片，写日志时需要合并连续 assistant 内容，避免界面出现一行一个词。
- 追加指令写入同一任务的 `turns`，通过 `Agent.resume` 继续同一会话，不要再拆成新的子任务。
- 后续指令默认 `delivery: "queue"`（等当前轮结束）；`interrupt` 会取消当前 Run 并把新轮次插到队首立刻执行。Cursor SDK 本地模式没有真正的「注入当前 Run」接口，追加只能通过中断当前轮实现。

## Docker 注意事项

仓库保留可选 `Dockerfile` / `docker-compose.yml`（Alpine），仅作备用，**日常不要用 Docker 跑本服务**。Cursor SDK 本地模式依赖 Windows 本机项目、凭据和开发环境，容器里通常缺这些组件。

默认运行方式是 Windows 本机 `pnpm dev` 或 `pnpm build && pnpm start`。若有人改了 compose，切回宿主机前必须把 `.env` 的 `PROJECT_ROOTS` 改回 Windows 路径，并停止容器以免占用 `20267`。

