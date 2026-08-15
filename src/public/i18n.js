/** 前端界面文案：zh / en */

export const LOCALES = ["zh", "en"];
export const LOCALE_STORAGE_KEY = "cursor-rc-locale";

const messages = {
  zh: {
    "meta.title": "Cursor 远程控制台",
    "meta.appleTitle": "Cursor 控制台",
    "header.title": "远程控制台",
    "header.install": "安装到主屏幕",
    "header.logout": "退出登录",
    "header.lang": "语言",

    "nav.main": "主导航",
    "nav.session": "会话",
    "nav.history": "历史",
    "nav.projects": "项目",
    "nav.back": "返回",

    "login.title": "登录",
    "login.username": "用户名",
    "login.password": "密码",
    "login.submit": "登录",

    "task.new": "新建任务",
    "task.start": "开始执行",
    "task.changeProject": "更换",

    "settings.title": "设置",
    "settings.version": "版本",
    "settings.notify": "任务完成时发送系统通知",
    "settings.account": "当前账号",
    "settings.changePassword": "修改密码",
    "settings.currentPassword": "当前密码",
    "settings.newPassword": "新密码",
    "settings.savePassword": "保存新密码",
    "settings.passwordChanged": "密码已更新",

    "users.manage": "用户管理",
    "users.create": "新建用户",
    "users.edit": "编辑用户",
    "users.role": "角色",
    "users.role.admin": "管理员",
    "users.role.operator": "操作员",
    "users.role.viewer": "观察者",
    "users.passwordOptional": "密码（留空则自动生成）",
    "users.permissions": "权限",
    "users.projects": "可使用的项目",
    "users.projectsHint": "有「使用全部已确认项目」权限时会忽略此项。",
    "users.disabled": "停用此账号",
    "users.resetForm": "新建",
    "users.resetPassword": "重置密码",
    "users.save": "保存",
    "users.saved": "用户已保存",
    "users.generatedPassword": "初始密码：{password}",
    "users.empty": "还没有其他用户",
    "users.noProjects": "请先确认项目后再分配",
    "users.perm.users.manage": "管理用户",
    "users.perm.projects.browse": "浏览目录",
    "users.perm.projects.select": "确认或移除项目",
    "users.perm.projects.useAll": "使用全部已确认项目",
    "users.perm.jobs.create": "新建任务",
    "users.perm.jobs.followUp": "追加指令",
    "users.perm.jobs.cancel": "停止任务",
    "users.perm.jobs.viewAll": "查看他人任务",
    "users.perm.jobs.operateOthers": "操作他人任务",

    "notify.taskDone": "{name} 任务已完成",
    "notify.taskFailed": "{name} 任务失败",
    "notify.permissionDenied": "未获得通知权限",

    "submit.title": "提交任务",
    "submit.refresh": "刷新",
    "submit.project": "项目",
    "submit.browseOpen": "浏览目录",
    "submit.searchLabel": "搜索项目",
    "submit.searchPlaceholder": "输入项目名或路径过滤",
    "submit.selectedLabel": "已选项目",
    "submit.projectHint": "列表显示已确认过的项目。点「选用」切换当前项目，新项目请点「浏览目录」添加。",
    "submit.projectHintAssigned": "列表只显示管理员分配给你的项目。",
    "submit.browseTitle": "浏览目录",
    "submit.browseClose": "关闭",
    "submit.browseRootHint": "选择允许的根目录开始浏览",
    "submit.browseUp": "上级目录",
    "submit.browseConfirm": "确认当前目录为项目",
    "submit.browseNotProject": "当前目录不是有效项目",
    "submit.parentLabel": "继续已有任务（可选）",
    "submit.newSession": "新建会话",
    "submit.mode": "模式",
    "submit.modeAgent": "Agent（执行）",
    "submit.modePlan": "Plan（规划）",
    "submit.model": "模型",
    "submit.modelHint": "思考强度、速度等选项会随所选模型变化。",
    "submit.modelVariant": "预设",
    "submit.modelCustom": "自定义",
    "submit.prompt": "指令",
    "submit.promptPlaceholder": "例如：检查这个项目的登录页面问题并修复，完成后运行相关检查。",
    "submit.button": "让 Cursor 修改",
    "submit.shellHint": "控制台不会提供任意 Shell，仅把任务提交给 Cursor Agent。",

    "session.title": "会话详情",
    "session.stop": "停止",
    "session.stopping": "停止中…",
    "session.switcher": "切换会话",
    "session.empty": "暂无任务",
    "session.emptyGuide": "选择历史任务，或新建任务开始对话。",
    "session.newMessages": "↓ 新消息",
    "session.followUpOptions": "发送选项",
    "session.followUpMode": "模式",
    "session.followUpPlaceholder": "继续安排这个任务…（Enter 发送，Shift+Enter 换行）",
    "session.followUpHint": "在同一任务中继续对话",
    "session.followUpHintBusy": "本轮进行中：默认排队发送，点「立即执行」会中断当前轮",
    "session.followUpHintNoAgent": "该任务没有可继续的会话",
    "session.followUpHintReady": "Enter 发送，Shift+Enter 换行",
    "session.followUpSend": "发送",
    "session.followUpQueue": "排队发送",
    "session.followUpInterrupt": "立即执行",
    "session.noChat": "暂无会话内容",
    "session.thinking": "思考过程",
    "session.me": "我",
    "session.ai": "AI",
    "session.aiTyping": "AI 正在回复…",

    "history.title": "历史任务",
    "history.empty": "暂无历史任务",
    "history.noMatch": "没有匹配的任务",
    "history.filterLabel": "筛选任务",
    "history.filterAll": "全部",
    "history.filterActive": "进行中",
    "history.filterFinished": "已完成",
    "history.filterFailed": "失败",
    "history.searchLabel": "搜索任务",
    "history.searchPlaceholder": "按项目名或摘要过滤",
    "history.showArchived": "显示已归档",
    "history.archive": "归档",
    "history.unarchive": "取消归档",
    "history.archived": "已归档",
    "history.submittedBy": "提交者：{name}",

    "pull.pull": "下拉刷新",
    "pull.release": "松开刷新",

    "onboarding.title": "快速开始",
    "onboarding.step1": "在「项目」页确认本地项目",
    "onboarding.step2": "点「新建任务」输入指令",
    "onboarding.step3": "在会话里继续对话与跟进",
    "onboarding.dismiss": "知道了",

    "submit.modelAdvanced": "高级模型选项",
    "submit.agentAdvanced": "Agent 选项",
    "submit.loadLocalSettings": "加载本机规则 / Skills / MCP",
    "submit.sandbox": "启用沙箱",
    "submit.autoReview": "启用 Auto-review",
    "submit.disallowedTools": "禁用工具",
    "submit.extraWorkspaces": "附加工作区",
    "submit.extraWorkspacesEmpty": "没有其他已确认项目可附加",
    "submit.agentHint": "默认会读取项目规则、本机 MCP 和 Skills。沙箱在部分 Windows 环境可能不可用。",
    "submit.attachImage": "附加图片",
    "submit.imageLimit": "最多 4 张图片，单张不超过 4MB。",

    "tool.shell": "Shell",
    "tool.mcp": "MCP",
    "tool.webSearch": "联网搜索",
    "tool.webFetch": "抓取网页",
    "tool.generateImage": "生成图片",
    "tool.task": "子 Agent",
    "tool.delete": "删除文件",
    "tool.edit": "编辑文件",

    "session.usage": "用量",
    "session.tool": "工具",
    "session.extraWorkspaces": "附加工作区：{names}",

    "panel.expand": "展开",
    "panel.collapse": "折叠",

    "model.param.fast": "速度",
    "model.param.fast.false": "标准",
    "model.param.fast.true": "快速",
    "model.param.optimize_for": "路由目标",
    "model.param.optimize_for.cost": "成本",
    "model.param.optimize_for.balanced": "均衡",
    "model.param.optimize_for.intelligence": "智能",
    "model.param.reasoning_effort": "思考强度",
    "model.param.effort": "思考强度",
    "model.param.reasoning": "思考强度",
    "model.param.context": "上下文",
    "model.param.xhigh": "很高",
    "model.param.extra-high": "很高",
    "model.param.minimal": "最低",
    "model.param.low": "低",
    "model.param.medium": "中",
    "model.param.high": "高",
    "model.param.max": "最高",
    "model.param.none": "关闭",

    "status.queued": "排队中",
    "status.running": "运行中",
    "status.finished": "已完成",
    "status.error": "失败",
    "status.cancelled": "已取消",

    "project.noneSelected": "暂无已选项目，请先浏览并确认",
    "project.noMatch": "没有匹配的项目",
    "project.unknownTime": "未知时间",
    "project.browseLoading": "正在加载目录…",
    "project.browseEmpty": "此目录下没有可进入的子文件夹",
    "project.confirmable": "可确认",
    "project.enterFirst": "请先进入要打开的项目目录",
    "project.confirmed": "已确认项目：{name}",
    "project.currentBadge": "当前",
    "project.use": "选用",
    "project.using": "已选用",
    "project.remove": "移除",
    "project.removed": "已从列表移除：{name}",
    "project.switched": "已切换到：{name}",

    "toast.requestFailed": "请求失败",
    "toast.selectProject": "请先选择或确认一个项目",
    "toast.enterPrompt": "请输入任务指令或附加图片",
    "toast.selectJob": "请先选择一个任务",
    "toast.cannotFollowUp": "当前任务暂时无法继续安排",
    "toast.enterFollowUp": "请输入后续安排或附加图片",
    "toast.imageTooMany": "最多附加 4 张图片",
    "toast.imageTooLarge": "图片过大，请压缩后再试",
    "toast.imageUnsupported": "仅支持 JPEG、PNG、GIF、WebP",
    "toast.cannotStop": "当前任务不能停止",
    "toast.stopRequested": "已请求停止任务",
    "toast.iosInstall": "请点分享按钮，再选择“添加到主屏幕”。",
    "toast.manualInstall": "请用浏览器菜单中的“安装应用 / 添加到主屏幕”。需 HTTPS 或 localhost。",
    "toast.installed": "已安装到设备。",
    "toast.modelsFailed": "无法加载模型列表，已使用本地备选。",

    "api.invalidCredentials": "用户名或密码错误",
    "api.unauthorized": "未登录",
    "api.csrfFailed": "CSRF 校验失败",
    "api.jobNotFound": "任务不存在",
    "api.confirmProjectFirst": "请先在「浏览目录」中确认该项目",
    "api.badRequest": "请求参数错误",
    "api.internalError": "服务器内部错误",
    "api.pathNotAllowed": "项目路径不在允许的本地项目根目录内",
    "api.pathOutOfRange": "项目路径不在允许范围内",
    "api.pathNotDirectory": "项目路径不是目录",
    "api.missingMarkers": "目标目录缺少项目标记，拒绝执行",
    "api.cannotReadDir": "无法读取该目录",
    "api.targetNotDirectory": "目标路径不是目录",
    "api.missingApiKey": "CURSOR_API_KEY 未配置",
    "api.extraWorkspace": "附加工作区必须是已确认的项目",
    "api.forbidden": "没有权限",
    "api.projectForbidden": "没有该项目的使用权限",
    "api.usernameTaken": "用户名已存在",
    "api.usernameInvalid": "用户名需为 2-32 位字母、数字、点、下划线或连字符",
    "api.lastAdmin": "不能停用或降级最后一名管理员",
    "api.userNotFound": "用户不存在",
    "api.passwordWeak": "密码至少 8 位",
    "api.currentPasswordWrong": "当前密码不正确",
  },
  en: {
    "meta.title": "Cursor Remote Control",
    "meta.appleTitle": "Cursor Remote",
    "header.title": "Remote Console",
    "header.install": "Add to Home Screen",
    "header.logout": "Log out",
    "header.lang": "Language",

    "nav.main": "Main navigation",
    "nav.session": "Session",
    "nav.history": "History",
    "nav.projects": "Projects",
    "nav.back": "Back",

    "login.title": "Sign in",
    "login.username": "Username",
    "login.password": "Password",
    "login.submit": "Sign in",

    "task.new": "New task",
    "task.start": "Start",
    "task.changeProject": "Change",

    "settings.title": "Settings",
    "settings.version": "Version",
    "settings.notify": "Notify when a task finishes",
    "settings.account": "Account",
    "settings.changePassword": "Change password",
    "settings.currentPassword": "Current password",
    "settings.newPassword": "New password",
    "settings.savePassword": "Save new password",
    "settings.passwordChanged": "Password updated",

    "users.manage": "Users",
    "users.create": "New user",
    "users.edit": "Edit user",
    "users.role": "Role",
    "users.role.admin": "Admin",
    "users.role.operator": "Operator",
    "users.role.viewer": "Viewer",
    "users.passwordOptional": "Password (leave blank to generate)",
    "users.permissions": "Permissions",
    "users.projects": "Allowed projects",
    "users.projectsHint": "Ignored when “Use all confirmed projects” is granted.",
    "users.disabled": "Disable this account",
    "users.resetForm": "New",
    "users.resetPassword": "Reset password",
    "users.save": "Save",
    "users.saved": "User saved",
    "users.generatedPassword": "Initial password: {password}",
    "users.empty": "No other users yet",
    "users.noProjects": "Confirm projects before assigning them",
    "users.perm.users.manage": "Manage users",
    "users.perm.projects.browse": "Browse folders",
    "users.perm.projects.select": "Confirm or remove projects",
    "users.perm.projects.useAll": "Use all confirmed projects",
    "users.perm.jobs.create": "Create tasks",
    "users.perm.jobs.followUp": "Send follow-ups",
    "users.perm.jobs.cancel": "Stop tasks",
    "users.perm.jobs.viewAll": "View others’ tasks",
    "users.perm.jobs.operateOthers": "Operate others’ tasks",

    "notify.taskDone": "{name} task finished",
    "notify.taskFailed": "{name} task failed",
    "notify.permissionDenied": "Notification permission denied",

    "submit.title": "Submit task",
    "submit.refresh": "Refresh",
    "submit.project": "Project",
    "submit.browseOpen": "Browse folders",
    "submit.searchLabel": "Search projects",
    "submit.searchPlaceholder": "Filter by name or path",
    "submit.selectedLabel": "Selected project",
    "submit.projectHint": "Only confirmed projects are listed. Tap “Use” to switch. Add a new one with “Browse folders”.",
    "submit.projectHintAssigned": "Only projects assigned to you are listed.",
    "submit.browseTitle": "Browse folders",
    "submit.browseClose": "Close",
    "submit.browseRootHint": "Choose an allowed root folder to start browsing",
    "submit.browseUp": "Parent folder",
    "submit.browseConfirm": "Confirm this folder as project",
    "submit.browseNotProject": "This folder is not a valid project",
    "submit.parentLabel": "Continue an existing task (optional)",
    "submit.newSession": "New session",
    "submit.mode": "Mode",
    "submit.modeAgent": "Agent (execute)",
    "submit.modePlan": "Plan (plan only)",
    "submit.model": "Model",
    "submit.modelHint": "Thinking effort, speed, and other options depend on the selected model.",
    "submit.modelVariant": "Preset",
    "submit.modelCustom": "Custom",
    "submit.prompt": "Prompt",
    "submit.promptPlaceholder": "Example: review the login page issues in this project, fix them, then run related checks.",
    "submit.button": "Ask Cursor to edit",
    "submit.shellHint": "This console does not offer an arbitrary shell. Tasks are submitted to the Cursor Agent only.",

    "session.title": "Session",
    "session.stop": "Stop",
    "session.stopping": "Stopping…",
    "session.switcher": "Switch session",
    "session.empty": "No task selected",
    "session.emptyGuide": "Pick a past task or start a new one.",
    "session.newMessages": "↓ New messages",
    "session.followUpOptions": "Send options",
    "session.followUpMode": "Mode",
    "session.followUpPlaceholder": "Continue this task… (Enter to send, Shift+Enter for a new line)",
    "session.followUpHint": "Continue this task",
    "session.followUpHintBusy": "This round is running. Queue by default, or tap Run now to interrupt.",
    "session.followUpHintNoAgent": "This task has no resumable session",
    "session.followUpHintReady": "Enter to send, Shift+Enter for a new line",
    "session.followUpSend": "Send",
    "session.followUpQueue": "Queue send",
    "session.followUpInterrupt": "Run now",
    "session.noChat": "No conversation yet",
    "session.thinking": "Thinking",
    "session.me": "You",
    "session.ai": "AI",
    "session.aiTyping": "AI is responding…",

    "history.title": "History",
    "history.empty": "No past tasks",
    "history.noMatch": "No matching tasks",
    "history.filterLabel": "Filter tasks",
    "history.filterAll": "All",
    "history.filterActive": "Active",
    "history.filterFinished": "Finished",
    "history.filterFailed": "Failed",
    "history.searchLabel": "Search tasks",
    "history.searchPlaceholder": "Filter by project or summary",
    "history.showArchived": "Show archived",
    "history.archive": "Archive",
    "history.unarchive": "Unarchive",
    "history.archived": "Archived",
    "history.submittedBy": "Submitted by {name}",

    "pull.pull": "Pull to refresh",
    "pull.release": "Release to refresh",

    "onboarding.title": "Quick start",
    "onboarding.step1": "Confirm a local project on the Projects tab",
    "onboarding.step2": "Tap New task and enter a prompt",
    "onboarding.step3": "Continue the conversation in Session",
    "onboarding.dismiss": "Got it",

    "submit.modelAdvanced": "Advanced model options",
    "submit.agentAdvanced": "Agent options",
    "submit.loadLocalSettings": "Load local rules / Skills / MCP",
    "submit.sandbox": "Enable sandbox",
    "submit.autoReview": "Enable Auto-review",
    "submit.disallowedTools": "Disable tools",
    "submit.extraWorkspaces": "Extra workspaces",
    "submit.extraWorkspacesEmpty": "No other confirmed projects to attach",
    "submit.agentHint": "Project rules, local MCP, and Skills load by default. Sandbox may be unavailable on some Windows hosts.",
    "submit.attachImage": "Attach images",
    "submit.imageLimit": "Up to 4 images, 4MB each.",

    "tool.shell": "Shell",
    "tool.mcp": "MCP",
    "tool.webSearch": "Web search",
    "tool.webFetch": "Fetch URL",
    "tool.generateImage": "Generate image",
    "tool.task": "Sub-agent",
    "tool.delete": "Delete file",
    "tool.edit": "Edit file",

    "session.usage": "Usage",
    "session.tool": "Tool",
    "session.extraWorkspaces": "Extra workspaces: {names}",

    "panel.expand": "Expand",
    "panel.collapse": "Collapse",

    "model.param.fast": "Speed",
    "model.param.fast.false": "Standard",
    "model.param.fast.true": "Fast",
    "model.param.optimize_for": "Router goal",
    "model.param.optimize_for.cost": "Cost",
    "model.param.optimize_for.balanced": "Balanced",
    "model.param.optimize_for.intelligence": "Intelligence",
    "model.param.reasoning_effort": "Thinking effort",
    "model.param.effort": "Thinking effort",
    "model.param.reasoning": "Thinking effort",
    "model.param.context": "Context",
    "model.param.xhigh": "Extra high",
    "model.param.extra-high": "Extra high",
    "model.param.minimal": "Minimal",
    "model.param.low": "Low",
    "model.param.medium": "Medium",
    "model.param.high": "High",
    "model.param.max": "Max",
    "model.param.none": "Off",

    "status.queued": "Queued",
    "status.running": "Running",
    "status.finished": "Finished",
    "status.error": "Failed",
    "status.cancelled": "Cancelled",

    "project.noneSelected": "No selected projects yet. Browse and confirm a folder first.",
    "project.noMatch": "No matching projects",
    "project.unknownTime": "Unknown time",
    "project.browseLoading": "Loading folders…",
    "project.browseEmpty": "No subfolders in this directory",
    "project.confirmable": "Ready",
    "project.enterFirst": "Enter the project folder you want to open first",
    "project.confirmed": "Project confirmed: {name}",
    "project.currentBadge": "Current",
    "project.use": "Use",
    "project.using": "Selected",
    "project.remove": "Remove",
    "project.removed": "Removed from list: {name}",
    "project.switched": "Switched to {name}",

    "toast.requestFailed": "Request failed",
    "toast.selectProject": "Select or confirm a project first",
    "toast.enterPrompt": "Enter a prompt or attach an image",
    "toast.selectJob": "Select a task first",
    "toast.cannotFollowUp": "This task cannot continue right now",
    "toast.enterFollowUp": "Enter a follow-up or attach an image",
    "toast.imageTooMany": "You can attach up to 4 images",
    "toast.imageTooLarge": "Image is too large; compress it and try again",
    "toast.imageUnsupported": "Only JPEG, PNG, GIF, and WebP are supported",
    "toast.cannotStop": "This task cannot be stopped",
    "toast.stopRequested": "Stop requested",
    "toast.iosInstall": "Tap Share, then choose “Add to Home Screen”.",
    "toast.manualInstall": "Use your browser menu: Install app / Add to Home Screen. HTTPS or localhost required.",
    "toast.installed": "Installed on this device.",
    "toast.modelsFailed": "Could not load the model catalog; using a local fallback.",

    "api.invalidCredentials": "Invalid username or password",
    "api.unauthorized": "Not signed in",
    "api.csrfFailed": "CSRF check failed",
    "api.jobNotFound": "Job not found",
    "api.confirmProjectFirst": "Confirm this project via “Browse folders” first",
    "api.badRequest": "Invalid request parameters",
    "api.internalError": "Internal server error",
    "api.pathNotAllowed": "Project path is outside the allowed local project roots",
    "api.pathOutOfRange": "Project path is outside the allowed range",
    "api.pathNotDirectory": "Project path is not a directory",
    "api.missingMarkers": "Directory has no project markers; rejected",
    "api.cannotReadDir": "Unable to read this directory",
    "api.targetNotDirectory": "Target path is not a directory",
    "api.missingApiKey": "CURSOR_API_KEY is not configured",
    "api.extraWorkspace": "Extra workspaces must be confirmed projects",
    "api.forbidden": "Permission denied",
    "api.projectForbidden": "You cannot use this project",
    "api.usernameTaken": "Username already exists",
    "api.usernameInvalid": "Username must be 2-32 letters, numbers, dots, underscores, or hyphens",
    "api.lastAdmin": "You cannot disable or demote the last admin",
    "api.userNotFound": "User not found",
    "api.passwordWeak": "Password must be at least 8 characters",
    "api.currentPasswordWrong": "Current password is incorrect",
  },
};

/** 服务端中文错误文案 → i18n key（任务日志仍按写入时语言保留） */
const apiErrorKeys = {
  用户名或密码错误: "api.invalidCredentials",
  未登录: "api.unauthorized",
  "CSRF 校验失败": "api.csrfFailed",
  任务不存在: "api.jobNotFound",
  "请先在「按目录打开」中确认该项目": "api.confirmProjectFirst",
  "请先在「浏览目录」中确认该项目": "api.confirmProjectFirst",
  请求参数错误: "api.badRequest",
  服务器内部错误: "api.internalError",
  项目路径不在允许的本地项目根目录内: "api.pathNotAllowed",
  项目路径不在允许范围内: "api.pathOutOfRange",
  项目路径不是目录: "api.pathNotDirectory",
  "目标目录缺少项目标记，拒绝执行": "api.missingMarkers",
  无法读取该目录: "api.cannotReadDir",
  目标路径不是目录: "api.targetNotDirectory",
  "CURSOR_API_KEY 未配置": "api.missingApiKey",
  "请输入任务指令或附加图片": "toast.enterPrompt",
  附加工作区必须是已确认的项目: "api.extraWorkspace",
  没有权限: "api.forbidden",
  没有该项目的使用权限: "api.projectForbidden",
  用户名已存在: "api.usernameTaken",
  "用户名需为 2-32 位字母、数字、点、下划线或连字符": "api.usernameInvalid",
  不能停用或降级最后一名管理员: "api.lastAdmin",
  用户不存在: "api.userNotFound",
  "密码至少 8 位": "api.passwordWeak",
  当前密码不正确: "api.currentPasswordWrong",
  "图片内容过大或无效": "toast.imageTooLarge",
  "图片内容无效": "toast.imageUnsupported",
  "仅支持 JPEG、PNG、GIF、WebP 图片": "toast.imageUnsupported",
  "单张图片不能超过 4MB": "toast.imageTooLarge",
  "最多附加 4 张图片": "toast.imageTooMany",
};

let currentLocale = "zh";

function interpolate(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => {
    return params[key] != null ? String(params[key]) : `{${key}}`;
  });
}

export function detectLocale() {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // localStorage 不可用时忽略
  }

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const item of languages) {
    const lower = String(item || "").toLowerCase();
    if (lower.startsWith("zh")) return "zh";
    if (lower.startsWith("en")) return "en";
  }
  return "zh";
}

export function getLocale() {
  return currentLocale;
}

export function localeTag() {
  return currentLocale === "en" ? "en-US" : "zh-CN";
}

export function t(key, params) {
  const table = messages[currentLocale] || messages.zh;
  const fallback = messages.zh[key] ?? key;
  return interpolate(table[key] ?? fallback, params);
}

export function setLocale(locale) {
  const next = locale === "en" ? "en" : "zh";
  currentLocale = next;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    // localStorage 不可用时忽略
  }
  return next;
}

export function translateApiError(message) {
  const text = String(message || "").trim();
  if (!text) return t("toast.requestFailed");

  const key = apiErrorKeys[text];
  if (key) return t(key);

  if (currentLocale === "en") {
    if (text.startsWith("停止任务失败：")) {
      return `Failed to stop task: ${text.slice("停止任务失败：".length)}`;
    }
    if (text.startsWith("Cursor Agent 启动失败：")) {
      return `Failed to start Cursor Agent: ${text.slice("Cursor Agent 启动失败：".length)}`;
    }
    if (text.startsWith("Cursor Agent 返回状态：")) {
      return `Cursor Agent status: ${text.slice("Cursor Agent 返回状态：".length)}`;
    }
  }

  return text;
}

export function applyDomI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key);
  });

  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key) el.setAttribute("placeholder", t(key));
  });

  root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const key = el.getAttribute("data-i18n-aria");
    if (key) el.setAttribute("aria-label", t(key));
  });

  document.documentElement.lang = localeTag();
  document.title = t("meta.title");

  const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (appleTitle) appleTitle.setAttribute("content", t("meta.appleTitle"));
}

export function initLocale() {
  currentLocale = detectLocale();
  return currentLocale;
}
