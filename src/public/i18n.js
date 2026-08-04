/** 前端界面文案：zh / en */

export const LOCALES = ["zh", "en"];
export const LOCALE_STORAGE_KEY = "cursor-rc-locale";

const messages = {
  zh: {
    "meta.title": "Cursor 远程控制台",
    "meta.appleTitle": "Cursor 控制台",
    "header.title": "远程控制台",
    "header.install": "安装",
    "header.logout": "退出",
    "header.lang": "语言",

    "login.title": "登录",
    "login.username": "用户名",
    "login.password": "密码",
    "login.submit": "登录",

    "submit.title": "提交任务",
    "submit.refresh": "刷新",
    "submit.project": "项目",
    "submit.browseOpen": "按目录打开",
    "submit.searchLabel": "搜索已选项目",
    "submit.searchPlaceholder": "输入项目名或路径过滤",
    "submit.selectedLabel": "已选项目",
    "submit.projectHint": "下拉列表只显示已确认过的项目。新项目请点「按目录打开」浏览并确认。",
    "submit.browseTitle": "按目录打开",
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
    "submit.prompt": "指令",
    "submit.promptPlaceholder": "例如：检查这个项目的登录页面问题并修复，完成后运行相关检查。",
    "submit.button": "让 Cursor 修改",
    "submit.shellHint": "控制台不会提供任意 Shell，仅把任务提交给 Cursor Agent。",

    "session.title": "会话详情",
    "session.stop": "停止",
    "session.stopping": "停止中…",
    "session.empty": "暂无任务",
    "session.followUpMode": "模式",
    "session.followUpPlaceholder": "继续安排这个任务…（Enter 发送，Shift+Enter 换行）",
    "session.followUpHint": "基于当前会话继续对话",
    "session.followUpHintBusy": "任务进行中，完成后可继续安排",
    "session.followUpHintNoAgent": "该任务没有可继续的会话",
    "session.followUpHintReady": "基于当前会话继续对话 · Enter 发送，Shift+Enter 换行",
    "session.followUpSend": "发送",
    "session.noChat": "暂无会话内容",
    "session.thinking": "思考过程",
    "session.me": "我",
    "session.ai": "AI",
    "session.aiTyping": "AI 正在回复…",

    "history.title": "历史任务",
    "history.empty": "暂无历史任务",

    "status.queued": "排队中",
    "status.running": "运行中",
    "status.finished": "已完成",
    "status.error": "失败",
    "status.cancelled": "已取消",

    "project.noneSelected": "暂无已选项目，请先按目录打开并确认",
    "project.noMatch": "没有匹配的已选项目",
    "project.unknownTime": "未知时间",
    "project.browseLoading": "正在加载目录…",
    "project.browseEmpty": "此目录下没有可进入的子文件夹",
    "project.confirmable": "可确认",
    "project.enterFirst": "请先进入要打开的项目目录",
    "project.confirmed": "已确认项目：{name}",

    "toast.requestFailed": "请求失败",
    "toast.selectProject": "请先选择或确认一个项目",
    "toast.enterPrompt": "请输入任务指令",
    "toast.selectJob": "请先选择一个任务",
    "toast.cannotFollowUp": "当前任务暂时无法继续安排",
    "toast.enterFollowUp": "请输入后续安排",
    "toast.cannotStop": "当前任务不能停止",
    "toast.stopRequested": "已请求停止任务",
    "toast.iosInstall": "请点分享按钮，再选择“添加到主屏幕”。",
    "toast.manualInstall": "请用浏览器菜单中的“安装应用 / 添加到主屏幕”。需 HTTPS 或 localhost。",
    "toast.installed": "已安装到设备。",

    "api.invalidCredentials": "用户名或密码错误",
    "api.unauthorized": "未登录",
    "api.csrfFailed": "CSRF 校验失败",
    "api.jobNotFound": "任务不存在",
    "api.confirmProjectFirst": "请先在「按目录打开」中确认该项目",
    "api.badRequest": "请求参数错误",
    "api.internalError": "服务器内部错误",
    "api.pathNotAllowed": "项目路径不在允许的本地项目根目录内",
    "api.pathOutOfRange": "项目路径不在允许范围内",
    "api.pathNotDirectory": "项目路径不是目录",
    "api.missingMarkers": "目标目录缺少项目标记，拒绝执行",
    "api.cannotReadDir": "无法读取该目录",
    "api.targetNotDirectory": "目标路径不是目录",
    "api.missingApiKey": "CURSOR_API_KEY 未配置",
  },
  en: {
    "meta.title": "Cursor Remote Control",
    "meta.appleTitle": "Cursor Remote",
    "header.title": "Remote Console",
    "header.install": "Install",
    "header.logout": "Log out",
    "header.lang": "Language",

    "login.title": "Sign in",
    "login.username": "Username",
    "login.password": "Password",
    "login.submit": "Sign in",

    "submit.title": "Submit task",
    "submit.refresh": "Refresh",
    "submit.project": "Project",
    "submit.browseOpen": "Browse folders",
    "submit.searchLabel": "Search selected projects",
    "submit.searchPlaceholder": "Filter by name or path",
    "submit.selectedLabel": "Selected project",
    "submit.projectHint": "The list only shows confirmed projects. Use “Browse folders” to confirm a new one.",
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
    "submit.prompt": "Prompt",
    "submit.promptPlaceholder": "Example: review the login page issues in this project, fix them, then run related checks.",
    "submit.button": "Ask Cursor to edit",
    "submit.shellHint": "This console does not offer an arbitrary shell. Tasks are submitted to the Cursor Agent only.",

    "session.title": "Session",
    "session.stop": "Stop",
    "session.stopping": "Stopping…",
    "session.empty": "No task selected",
    "session.followUpMode": "Mode",
    "session.followUpPlaceholder": "Continue this task… (Enter to send, Shift+Enter for a new line)",
    "session.followUpHint": "Continue the current session",
    "session.followUpHintBusy": "Task is running. You can continue after it finishes.",
    "session.followUpHintNoAgent": "This task has no resumable session",
    "session.followUpHintReady": "Continue the current session · Enter to send, Shift+Enter for a new line",
    "session.followUpSend": "Send",
    "session.noChat": "No conversation yet",
    "session.thinking": "Thinking",
    "session.me": "You",
    "session.ai": "AI",
    "session.aiTyping": "AI is responding…",

    "history.title": "History",
    "history.empty": "No past tasks",

    "status.queued": "Queued",
    "status.running": "Running",
    "status.finished": "Finished",
    "status.error": "Failed",
    "status.cancelled": "Cancelled",

    "project.noneSelected": "No selected projects yet. Browse and confirm a folder first.",
    "project.noMatch": "No matching selected projects",
    "project.unknownTime": "Unknown time",
    "project.browseLoading": "Loading folders…",
    "project.browseEmpty": "No subfolders in this directory",
    "project.confirmable": "Ready",
    "project.enterFirst": "Enter the project folder you want to open first",
    "project.confirmed": "Project confirmed: {name}",

    "toast.requestFailed": "Request failed",
    "toast.selectProject": "Select or confirm a project first",
    "toast.enterPrompt": "Enter a task prompt",
    "toast.selectJob": "Select a task first",
    "toast.cannotFollowUp": "This task cannot continue right now",
    "toast.enterFollowUp": "Enter a follow-up message",
    "toast.cannotStop": "This task cannot be stopped",
    "toast.stopRequested": "Stop requested",
    "toast.iosInstall": "Tap Share, then choose “Add to Home Screen”.",
    "toast.manualInstall": "Use your browser menu: Install app / Add to Home Screen. HTTPS or localhost required.",
    "toast.installed": "Installed on this device.",

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
  },
};

/** 服务端中文错误文案 → i18n key（任务日志仍按写入时语言保留） */
const apiErrorKeys = {
  用户名或密码错误: "api.invalidCredentials",
  未登录: "api.unauthorized",
  "CSRF 校验失败": "api.csrfFailed",
  任务不存在: "api.jobNotFound",
  "请先在「按目录打开」中确认该项目": "api.confirmProjectFirst",
  请求参数错误: "api.badRequest",
  服务器内部错误: "api.internalError",
  项目路径不在允许的本地项目根目录内: "api.pathNotAllowed",
  项目路径不在允许范围内: "api.pathOutOfRange",
  项目路径不是目录: "api.pathNotDirectory",
  目标目录缺少项目标记，拒绝执行: "api.missingMarkers",
  无法读取该目录: "api.cannotReadDir",
  目标路径不是目录: "api.targetNotDirectory",
  "CURSOR_API_KEY 未配置": "api.missingApiKey",
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

  // 英文界面下对带前缀的中文错误做有限映射，未知内容原样展示
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
