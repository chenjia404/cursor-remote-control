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
- `src/projects.ts`：本地项目发现、多个项目根目录扫描、路径安全校验。
- `src/jobs.ts`：任务历史、任务状态、日志持久化。
- `src/cursorAgent.ts`：Cursor SDK 本地 Agent 执行封装。
- `src/public/`：移动端 Web 页面和 PWA 静态资源。
- `scripts/init-admin.ts`：生成管理员随机密码、密码哈希和 Session 密钥。
- `scripts/generate-icons.ts`：从 SVG 生成 PWA PNG 图标。
- `.env.example`：配置模板，不包含真实密钥。
- `data/`：运行时数据目录，不要提交其中的真实数据。

## 安全约束

- 不要添加任意 Shell 输入框。
- 不要允许网页直接执行系统命令。
- 不要把 `.env`、管理员密码、`CURSOR_API_KEY`、Session 密钥或 `data/jobs.json` 写入 Git。
- `PROJECT_ROOTS` 只应配置项目根目录，例如 `D:\code;C:\code`，不要配置整个系统盘。
- 项目路径必须经过 `src/projects.ts` 的根目录校验后才能传给 Cursor SDK。
- 公网访问时必须使用 HTTPS，并把 `COOKIE_SECURE=true`。
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

## Cursor SDK 注意事项

- 当前使用本地模式执行 Agent，`cwd` 必须是经过校验的项目目录。
- `CURSOR_API_KEY` 必须在 `.env` 中配置真实值。
- `CURSOR_MODEL` 默认可使用 `auto`。
- Agent 输出是流式分片，写日志时需要合并连续 assistant 内容，避免界面出现一行一个词。

## Docker 注意事项

项目提供可选 `docker-compose.yml`，镜像应继续使用 Alpine 版本。由于本项目依赖 Cursor SDK 本地模式访问 Windows 本机项目和凭据，默认更推荐直接在 Windows 本机运行。
