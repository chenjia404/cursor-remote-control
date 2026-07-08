# Cursor 远程控制台

一个运行在本机的 Web 控制台，用手机浏览器提交任务给 Cursor Agent，让它修改本机项目。

## 功能

- 管理员账号密码登录，默认用户名为 `admin`。
- 默认监听端口 `20267`。
- 默认扫描 `PROJECT_ROOTS` 下的本地项目，支持多个根目录，并按最近修改时间显示。
- 通过 Cursor SDK 的本地模式在项目目录中执行 Agent 任务。
- 保存任务历史、运行状态、Agent ID、Run ID 和日志。
- 支持 PWA，可在手机浏览器中安装到主屏幕。
- 不提供任意 Shell 输入框，网页不能直接执行系统命令。

## 初始化

```powershell
cd D:\code\cursor-remote-control
pnpm install
Copy-Item .env.example .env
pnpm init-admin
```

`pnpm init-admin` 会生成高强度随机密码，并写入 `.env` 中的密码哈希和 Session 密钥。密码只显示一次，请立即保存。

然后编辑 `.env`：

```env
CURSOR_API_KEY=cursor_xxx
PROJECT_ROOTS=D:\code;E:\work
COOKIE_SECURE=false
```

`PROJECT_ROOTS` 使用英文分号分隔多个目录。建议只配置项目根目录，不要配置整个系统盘。

如果通过 HTTPS 公网域名访问，请设置：

```env
COOKIE_SECURE=true
PUBLIC_BASE_URL=
```

## 启动

开发模式：

```powershell
pnpm dev
```

生产模式：

```powershell
pnpm build
pnpm start
```

访问：

```text
http://127.0.0.1:20267
```

公网反代时，把 HTTPS 域名转发到本机 `20267` 端口。

## 安装到手机

通过 HTTPS 域名打开控制台后，页面右上角会在浏览器满足安装条件时显示“安装”按钮。Chromium 会弹出系统安装提示；iOS Safari 不会触发该事件，点击后会提示用分享菜单“添加到主屏幕”。

PWA 安装依赖：

- HTTPS 或本机 `localhost`（普通 HTTP 公网地址通常无法安装）
- 有效的 Web App Manifest（含 192 与 512 的 PNG 图标）
- 已注册的 Service Worker

图标变更后可执行 `pnpm generate-icons` 重新从 SVG 生成 PNG。

## Docker

项目提供可选 `docker-compose.yml`，端口为 `20267:20267`，镜像基于 `node:alpine`。

本项目更推荐直接在 Windows 本机运行，因为 Cursor SDK 本地模式需要访问本机项目、凭据和开发环境。使用 Docker 时需要确认容器内的项目路径、Cursor SDK 运行环境和密钥都可用。

## 安全注意事项

- 不要把 `.env`、`data/jobs.json` 或管理员密码提交到 Git。
- 公网访问必须使用 HTTPS，并把 `COOKIE_SECURE` 设置为 `true`。
- `PROJECT_ROOTS` 不要设置为整个系统盘，建议设置为 `D:\code;E:\work` 这类项目根目录列表。
- 控制台只适合个人使用，不建议给多人共享管理员账号。
