import { APP_VERSION } from "./version.js";
import {
  applyDomI18n,
  getLocale,
  initLocale,
  localeTag,
  setLocale,
  t,
  translateApiError,
} from "./i18n.js?v=0.2.13";

let markedRef = null;
let purifyRef = null;
let markdownLoading = null;

async function ensureMarkdownLibs() {
  if (markedRef && purifyRef) return;
  if (markdownLoading) {
    await markdownLoading;
    return;
  }

  markdownLoading = Promise.all([
    import("./vendor/marked.esm.js"),
    import("./vendor/purify.es.mjs"),
  ]).then(([markedMod, purifyMod]) => {
    markedRef = markedMod.marked;
    purifyRef = purifyMod.default;
    markedRef.setOptions({ gfm: true, breaks: true });
    if (purifyRef && typeof purifyRef.addHook === "function") {
      purifyRef.addHook("afterSanitizeAttributes", (node) => {
        if (node.tagName === "A" && node.hasAttribute("href")) {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer");
        }
      });
    }
  });

  try {
    await markdownLoading;
  } finally {
    markdownLoading = null;
  }
}

const MODE_LABELS = {
  agent: "Agent",
  plan: "Plan",
};

const MODE_STORAGE_KEY = "cursor-rc-mode";

const state = {
  csrfToken: "",
  jobs: [],
  projects: [],
  currentJobId: "",
  currentJob: null,
  pollingTimer: null,
  installPromptEvent: null,
  followUpDrafts: new Map(),
  stoppingJobIds: new Set(),
  browse: {
    open: false,
    currentPath: null,
    parentPath: null,
    currentIsProject: false,
    entries: [],
    loading: false,
  },
};

initLocale();

const versionEl = document.querySelector("#appVersion");
if (versionEl) {
  versionEl.textContent = `v${APP_VERSION}`;
}

const $ = (selector) => document.querySelector(selector);

function on(selector, eventName, handler, options) {
  const element = $(selector);
  if (!element) return;
  element.addEventListener(eventName, handler, options);
}

function formatDateTime(value) {
  return new Date(value).toLocaleString(localeTag());
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString(localeTag());
}

function updateLangSwitch() {
  const locale = getLocale();
  document.querySelectorAll("#langSwitch .lang-option").forEach((button) => {
    button.classList.toggle("active", button.dataset.lang === locale);
  });
}

function applyLocale(locale) {
  setLocale(locale);
  applyDomI18n();
  updateLangSwitch();
  renderProjects();
  renderJobs();
  renderBrowsePanel();
  renderCurrentJob(state.currentJob);
}

function loadSavedMode() {
  try {
    const saved = localStorage.getItem(MODE_STORAGE_KEY);
    if (saved === "agent" || saved === "plan") return saved;
  } catch {
    // localStorage 不可用时忽略
  }
  return "agent";
}

function saveMode(mode) {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage 不可用时忽略
  }
}

function getModeFromSelect(select) {
  const value = select?.value;
  return value === "plan" ? "plan" : "agent";
}

function setModeSelect(select, mode) {
  if (!select) return;
  select.value = mode === "plan" ? "plan" : "agent";
}

function modeText(mode) {
  return MODE_LABELS[mode] || MODE_LABELS.agent;
}

function modeBadge(mode) {
  const safeMode = mode === "plan" ? "plan" : "agent";
  return `<span class="mode-badge mode-${safeMode}">${escapeHtml(modeText(safeMode))}</span>`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.setTimeout(() => toast.classList.add("hidden"), 3200);
}

function getSessionToken() {
  if (window.__crcSession?.sessionToken) return window.__crcSession.sessionToken;
  try {
    return sessionStorage.getItem("crc_session_token") || "";
  } catch {
    return "";
  }
}

async function api(path, options = {}) {
  const { headers: extraHeaders, ...rest } = options;
  const sessionToken = getSessionToken();
  const response = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(state.csrfToken ? { "x-csrf-token": state.csrfToken } : {}),
      ...(sessionToken
        ? {
            Authorization: `Bearer ${sessionToken}`,
            "x-crc-session": sessionToken,
          }
        : {}),
      ...(extraHeaders || {}),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(translateApiError(data.error || t("toast.requestFailed")));
  }

  return data;
}

/** 清除误用 GET 提交残留在地址栏的账号密码，避免泄露与干扰 */
function stripCredentialsFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("username") && !url.searchParams.has("password")) return;
    url.searchParams.delete("username");
    url.searchParams.delete("password");
    const clean = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, "", clean || "/");
  } catch {
    // ignore
  }
}

function setLoggedIn(loggedIn) {
  $("#loginView").classList.toggle("hidden", loggedIn);
  $("#appView").classList.toggle("hidden", !loggedIn);
  $("#logoutButton").classList.toggle("hidden", !loggedIn);
}

function renderProjects() {
  const select = $("#projectSelect");
  const hint = $("#projectSelectHint");
  const previousValue = select.value;
  const keyword = $("#projectSearchInput").value.trim().toLowerCase();
  const projects = state.projects.filter((project) => {
    if (!keyword) return true;
    return `${project.name} ${project.path}`.toLowerCase().includes(keyword);
  });

  if (state.projects.length === 0) {
    select.innerHTML = `<option value="">${escapeHtml(t("project.noneSelected"))}</option>`;
    if (hint) hint.textContent = t("submit.projectHint");
    return;
  }

  if (projects.length === 0) {
    select.innerHTML = `<option value="">${escapeHtml(t("project.noMatch"))}</option>`;
    return;
  }

  select.innerHTML = projects
    .map((project) => {
      const modifiedAt = project.modifiedAt ? formatDateTime(project.modifiedAt) : t("project.unknownTime");
      return `<option value="${project.id}">${escapeHtml(project.name)} · ${escapeHtml(modifiedAt)} · ${escapeHtml(project.path)}</option>`;
    })
    .join("");

  if (projects.some((project) => project.id === previousValue)) {
    select.value = previousValue;
  }
}

function setBrowsePanelOpen(open) {
  state.browse.open = open;
  $("#browsePanel").classList.toggle("hidden", !open);
  $("#browseOpenButton").classList.toggle("hidden", open);
}

function renderBrowsePanel() {
  const pathEl = $("#browsePath");
  const listEl = $("#browseList");
  const upButton = $("#browseUpButton");
  const selectButton = $("#browseSelectButton");
  const { currentPath, currentIsProject, entries, loading } = state.browse;

  pathEl.textContent = currentPath || t("submit.browseRootHint");
  // 已进入具体目录时允许返回；在某个 PROJECT_ROOT 顶层时回到根列表
  upButton.disabled = loading || !currentPath;
  selectButton.disabled = loading || !currentPath || !currentIsProject;
  selectButton.textContent = currentIsProject ? t("submit.browseConfirm") : t("submit.browseNotProject");

  if (loading) {
    listEl.innerHTML = `<p class="browse-empty">${escapeHtml(t("project.browseLoading"))}</p>`;
    return;
  }

  if (entries.length === 0) {
    listEl.innerHTML = `<p class="browse-empty">${escapeHtml(t("project.browseEmpty"))}</p>`;
    return;
  }

  listEl.innerHTML = entries
    .map((entry) => {
      const badge = entry.isProject ? `<span class="browse-badge">${escapeHtml(t("project.confirmable"))}</span>` : "";
      return `
        <button type="button" class="browse-item" data-browse-path="${escapeHtml(entry.path)}" data-is-project="${entry.isProject ? "1" : "0"}">
          <span class="browse-item-main">
            <span class="browse-item-name">${escapeHtml(entry.name)}</span>
            <span class="browse-item-path">${escapeHtml(entry.path)}</span>
          </span>
          ${badge}
        </button>
      `;
    })
    .join("");
}

async function loadBrowse(targetPath) {
  state.browse.loading = true;
  renderBrowsePanel();

  try {
    const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : "";
    const data = await api(`/api/projects/browse${query}`);
    state.browse.currentPath = data.currentPath;
    state.browse.parentPath = data.parentPath;
    state.browse.currentIsProject = Boolean(data.currentIsProject);
    state.browse.entries = data.entries || [];
  } catch (error) {
    showToast(error.message);
  } finally {
    state.browse.loading = false;
    renderBrowsePanel();
  }
}

async function confirmBrowseSelection(projectPath) {
  if (!projectPath) {
    showToast(t("project.enterFirst"));
    return;
  }

  const selectButton = $("#browseSelectButton");
  selectButton.disabled = true;
  try {
    const { project } = await api("/api/projects/select", {
      method: "POST",
      body: JSON.stringify({ path: projectPath }),
    });
    await refreshData();
    $("#projectSelect").value = project.id;
    setBrowsePanelOpen(false);
    showToast(t("project.confirmed", { name: project.name }));
  } catch (error) {
    showToast(error.message);
  } finally {
    renderBrowsePanel();
  }
}

function statusText(status) {
  const key = `status.${status}`;
  const translated = t(key);
  return translated === key ? status : translated;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMarkdown(value) {
  if (!markedRef || !purifyRef) {
    ensureMarkdownLibs()
      .then(() => {
        if (state.currentJob) renderCurrentJob(state.currentJob);
      })
      .catch(() => {});
    return escapeHtml(String(value || "")).replaceAll("\n", "<br>");
  }

  const html = markedRef.parse(String(value || ""), { async: false });
  return purifyRef.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target"],
  });
}

function formatChatBody(role, text) {
  if (role === "assistant" || role === "thinking") {
    return `<div class="chat-text chat-markdown">${renderMarkdown(text)}</div>`;
  }
  return `<div class="chat-text">${escapeHtml(text)}</div>`;
}

function rememberFollowUpDraft() {
  const currentInput = $("#followUpInput");
  if (state.currentJobId && currentInput && !currentInput.disabled) {
    const value = currentInput.value;
    if (value.trim()) {
      state.followUpDrafts.set(state.currentJobId, value);
    } else {
      state.followUpDrafts.delete(state.currentJobId);
    }
  }
}

function autosizeTextarea(input) {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function renderJobs() {
  const list = $("#jobList");
  const parentSelect = $("#parentJobSelect");
  rememberFollowUpDraft();

  parentSelect.innerHTML =
    `<option value="">${escapeHtml(t("submit.newSession"))}</option>` +
    state.jobs
      .filter((job) => job.agentId)
      .map((job) => `<option value="${job.id}">${escapeHtml(job.project.name)} - ${escapeHtml(job.promptSummary)}</option>`)
      .join("");

  if (state.jobs.length === 0) {
    list.innerHTML = `<p class="empty">${escapeHtml(t("history.empty"))}</p>`;
    return;
  }

  list.innerHTML = state.jobs
    .map((job) => {
      const activeClass = job.id === state.currentJobId ? " active" : "";
      return `
        <article class="job-item${activeClass}" data-job-id="${job.id}">
          <div class="job-item-summary">
            <strong>${escapeHtml(job.project.name)}<span class="status status-${job.status}">${statusText(job.status)}</span>${modeBadge(job.mode)}</strong>
            <div>${escapeHtml(job.promptSummary)}</div>
            <div class="meta">${escapeHtml(formatDateTime(job.createdAt))} · ${job.id}</div>
          </div>
        </article>
      `;
    })
    .join("");
}

function canFollowUp(job) {
  return Boolean(job?.agentId) && !["queued", "running"].includes(job.status);
}

function canStopJob(job) {
  return Boolean(job) && ["queued", "running"].includes(job.status);
}

function findJob(jobId) {
  if (!jobId) return null;
  if (state.currentJob?.id === jobId) return state.currentJob;
  return state.jobs.find((job) => job.id === jobId) || null;
}

function updateFollowUpComposer(job) {
  const form = $("#followUpForm");
  const button = $("#followUpButton");
  const hint = $("#followUpHint");
  const input = $("#followUpInput");
  const modeSelect = $("#followUpModeSelect");

  if (!job) {
    form.classList.add("hidden");
    input.value = "";
    return;
  }

  form.classList.remove("hidden");
  setModeSelect(modeSelect, job.mode || loadSavedMode());

  const draft = state.followUpDrafts.get(job.id) || "";
  if (document.activeElement !== input) {
    input.value = draft;
    autosizeTextarea(input);
  }

  if (["queued", "running"].includes(job.status)) {
    button.disabled = true;
    input.disabled = true;
    hint.textContent = t("session.followUpHintBusy");
    return;
  }

  if (!job.agentId) {
    button.disabled = true;
    input.disabled = true;
    hint.textContent = t("session.followUpHintNoAgent");
    return;
  }

  button.disabled = false;
  input.disabled = false;
  hint.textContent = t("session.followUpHintReady");
}

function updateStopButton(job) {
  const button = $("#stopJobButton");
  if (!button) return;

  const canStop = canStopJob(job);
  const isStopping = Boolean(job) && state.stoppingJobIds.has(job.id);
  button.classList.toggle("hidden", !canStop);
  button.disabled = !canStop || isStopping;
  button.textContent = isStopping ? t("session.stopping") : t("session.stop");
}

function getConversationRootId(jobId) {
  const seen = new Set();
  let current = findJob(jobId);

  while (current?.parentJobId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = findJob(current.parentJobId);
    if (!parent) break;
    current = parent;
  }

  return current?.id || jobId;
}

function getConversationChain(jobId) {
  const rootId = getConversationRootId(jobId);
  const related = [];
  const byParent = new Map();

  for (const job of state.jobs) {
    if (job.parentJobId) {
      const siblings = byParent.get(job.parentJobId) || [];
      siblings.push(job);
      byParent.set(job.parentJobId, siblings);
    }
  }

  const queue = [];
  const root = findJob(rootId);
  if (root) queue.push(root);

  const seen = new Set();
  while (queue.length > 0) {
    const job = queue.shift();
    if (!job || seen.has(job.id)) continue;
    seen.add(job.id);
    related.push(job);
    const children = (byParent.get(job.id) || []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    queue.push(...children);
  }

  // 详情接口刚返回的当前任务可能比列表更新（尤其是 logs），用最新副本覆盖
  if (state.currentJob && seen.has(state.currentJob.id)) {
    const index = related.findIndex((job) => job.id === state.currentJob.id);
    if (index >= 0) related[index] = state.currentJob;
  }

  return related.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function appendChatMessage(messages, role, text, time) {
  const content = String(text || "");
  if (!content.trim()) return;

  const previous = messages.at(-1);
  if (previous?.role === role) {
    previous.text += content;
    previous.time = time || previous.time;
    return;
  }

  messages.push({
    role,
    time: time || new Date().toISOString(),
    text: content.trimStart(),
  });
}

function buildChatMessages(jobs) {
  const messages = [];

  for (const job of jobs) {
    messages.push({
      role: "user",
      time: job.createdAt,
      text: job.prompt,
    });

    let sawAssistant = false;
    let sawThinking = false;
    for (const log of job.logs || []) {
      if (log.level === "thinking") {
        sawThinking = true;
        appendChatMessage(messages, "thinking", log.message, log.time);
        continue;
      }

      if (log.level === "assistant") {
        sawAssistant = true;
        appendChatMessage(messages, "assistant", log.message, log.time);
        continue;
      }

      if (log.level === "error") {
        messages.push({
          role: "system",
          level: "error",
          time: log.time,
          text: log.message,
        });
      }
      // info 日志（任务创建/启动等）不混入对话气泡
    }

    // 兼容旧任务：流日志缺失时，用最终 result 兜底展示 AI 回复
    if (!sawAssistant && typeof job.result === "string" && job.result.trim()) {
      appendChatMessage(messages, "assistant", job.result, job.finishedAt || job.updatedAt);
    }

    if (!sawAssistant && !sawThinking && !job.result && ["queued", "running"].includes(job.status)) {
      messages.push({
        role: "system",
        level: "info",
        time: job.updatedAt || job.startedAt || job.createdAt,
        text: t("session.aiTyping"),
      });
    }
  }

  return messages;
}

function renderChatMessages(job) {
  const output = $("#chatOutput");
  if (!job) {
    output.innerHTML = "";
    return;
  }

  const messages = buildChatMessages(getConversationChain(job.id));
  if (messages.length === 0) {
    output.innerHTML = `<p class="empty">${escapeHtml(t("session.noChat"))}</p>`;
    return;
  }

  const wasNearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 80;

  output.innerHTML = messages
    .map((message) => {
      const time = formatTime(message.time);
      if (message.role === "system") {
        return `
          <div class="chat-system chat-system-${message.level}">
            <span>${escapeHtml(message.text)}</span>
            <time>${escapeHtml(time)}</time>
          </div>
        `;
      }

      if (message.role === "thinking") {
        return `
          <div class="chat-row chat-left">
            <details class="chat-thinking" open>
              <summary>
                <span>${escapeHtml(t("session.thinking"))}</span>
                <time>${escapeHtml(time)}</time>
              </summary>
              ${formatChatBody("thinking", message.text)}
            </details>
          </div>
        `;
      }

      const side = message.role === "user" ? "right" : "left";
      const label = message.role === "user" ? t("session.me") : t("session.ai");
      return `
        <div class="chat-row chat-${side}">
          <div class="chat-bubble chat-bubble-${message.role}">
            <div class="chat-meta">
              <span>${escapeHtml(label)}</span>
              <time>${escapeHtml(time)}</time>
            </div>
            ${formatChatBody(message.role, message.text)}
          </div>
        </div>
      `;
    })
    .join("");

  if (wasNearBottom || !output.dataset.ready) {
    output.scrollTop = output.scrollHeight;
    output.dataset.ready = "1";
  }
}

function renderCurrentJob(job) {
  state.currentJob = job || null;

  if (!job) {
    $("#currentJob").textContent = t("session.empty");
    renderChatMessages(null);
    updateFollowUpComposer(null);
    updateStopButton(null);
    return;
  }

  $("#currentJob").innerHTML = `
    <strong>${escapeHtml(job.project.name)}</strong>
    <span class="status status-${job.status}">${statusText(job.status)}</span>
    ${modeBadge(job.mode)}
    <p class="meta">${escapeHtml(job.promptSummary)}</p>
  `;
  renderChatMessages(job);
  updateFollowUpComposer(job);
  updateStopButton(job);
}

function startPollingCurrentJob() {
  if (state.pollingTimer) {
    window.clearInterval(state.pollingTimer);
  }
  state.pollingTimer = window.setInterval(() => {
    refreshCurrentJob().catch((error) => showToast(error.message));
  }, 2000);
}

async function submitFollowUp(prompt, parentJobId) {
  const job = findJob(parentJobId);
  if (!job) {
    showToast(t("toast.selectJob"));
    return;
  }
  if (!canFollowUp(job)) {
    showToast(t("toast.cannotFollowUp"));
    return;
  }

  const mode = getModeFromSelect($("#followUpModeSelect"));
  saveMode(mode);

  const { job: created } = await api("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      projectId: job.project.id,
      prompt,
      parentJobId: job.id,
      mode,
    }),
  });

  state.followUpDrafts.delete(job.id);
  state.currentJobId = created.id;
  const chatOutput = $("#chatOutput");
  if (chatOutput) delete chatOutput.dataset.ready;
  renderCurrentJob(created);
  $("#followUpInput").value = "";
  await refreshData();
  startPollingCurrentJob();
}

async function refreshData() {
  const [projectsData, jobsData] = await Promise.all([api("/api/projects"), api("/api/jobs")]);
  state.projects = projectsData.projects;
  state.jobs = jobsData.jobs;
  renderProjects();
  renderJobs();

  if (state.currentJobId) {
    await refreshCurrentJob();
  }
}

async function refreshCurrentJob() {
  if (!state.currentJobId) return;
  const { job } = await api(`/api/jobs/${state.currentJobId}`);
  renderCurrentJob(job);

  if (!["queued", "running"].includes(job.status) && state.pollingTimer) {
    window.clearInterval(state.pollingTimer);
    state.pollingTimer = null;
    await refreshData();
  }
}

async function stopCurrentJob() {
  const job = state.currentJob;
  if (!canStopJob(job)) {
    showToast(t("toast.cannotStop"));
    return;
  }

  state.stoppingJobIds.add(job.id);
  updateStopButton(job);
  try {
    const { job: updatedJob } = await api(`/api/jobs/${job.id}/cancel`, {
      method: "POST",
      body: "{}",
    });
    state.currentJob = updatedJob;
    renderCurrentJob(updatedJob);
    await refreshData();
    showToast(t("toast.stopRequested"));
  } catch (error) {
    showToast(error.message);
  } finally {
    state.stoppingJobIds.delete(job.id);
    updateStopButton(state.currentJob);
  }
}

async function bootstrap() {
  if (window.__crcSession?.csrfToken) {
    state.csrfToken = window.__crcSession.csrfToken;
    setLoggedIn(true);
    await refreshData();
    return;
  }

  try {
    const session = await api("/api/session");
    state.csrfToken = session.csrfToken;
    setLoggedIn(true);
    await refreshData();
  } catch {
    setLoggedIn(false);
  }
}

/** 供 boot.js 在登录成功后调用 */
export async function onBootAuthenticated(session) {
  state.csrfToken = session?.csrfToken || "";
  if (!session?.sessionToken) {
    throw new Error("缺少会话令牌，无法加载项目与历史");
  }

  window.__crcSession = {
    csrfToken: state.csrfToken,
    sessionToken: session.sessionToken,
    username: session.username || "admin",
  };
  try {
    sessionStorage.setItem("crc_session_token", session.sessionToken);
    sessionStorage.setItem("crc_csrf_token", state.csrfToken);
  } catch {
    // ignore
  }

  stripCredentialsFromUrl();
  setLoggedIn(true);
  await ensureMarkdownLibs().catch(() => {});
  await refreshData();
}

window.__crcApp = {
  onBootAuthenticated,
  refreshData: () => refreshData(),
};

// 登录由 boot.js 负责；这里仅作模块单独打开时的备用
on("#loginForm", "submit", async (event) => {
  if (event.defaultPrevented) return;
  event.preventDefault();
  event.stopPropagation();
  const form = new FormData(event.currentTarget);
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  if (submitButton) submitButton.disabled = true;

  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
      }),
    });
    await onBootAuthenticated(data);
  } catch (error) {
    showToast(error.message);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

// logout 已由 boot.js 绑定；避免重复请求
if (!$("#logoutButton")?.dataset.bootBound) {
  on("#logoutButton", "click", async () => {
    await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
    state.csrfToken = "";
    window.__crcSession = null;
    setLoggedIn(false);
  });
}

on("#refreshButton", "click", () => {
  refreshData().catch((error) => showToast(error.message));
});

on("#stopJobButton", "click", () => {
  stopCurrentJob().catch((error) => showToast(error.message));
});

on("#projectSearchInput", "input", renderProjects);

on("#browseOpenButton", "click", async () => {
  setBrowsePanelOpen(true);
  await loadBrowse(null);
});

on("#browseCloseButton", "click", () => {
  setBrowsePanelOpen(false);
});

on("#browseUpButton", "click", async () => {
  if (state.browse.parentPath) {
    await loadBrowse(state.browse.parentPath);
    return;
  }
  // 已在某个允许根目录顶层，或没有上级时，回到根列表
  await loadBrowse(null);
});

on("#browseSelectButton", "click", async () => {
  await confirmBrowseSelection(state.browse.currentPath);
});

on("#browseList", "click", async (event) => {
  const item = event.target.closest("[data-browse-path]");
  if (!item) return;
  await loadBrowse(item.dataset.browsePath);
});

on("#submitJobButton", "click", async () => {
  const prompt = $("#promptInput").value.trim();
  const projectId = $("#projectSelect").value;
  const parentJobId = $("#parentJobSelect").value || undefined;

  if (!projectId) {
    showToast(t("toast.selectProject"));
    return;
  }
  if (!prompt) {
    showToast(t("toast.enterPrompt"));
    return;
  }

  $("#submitJobButton").disabled = true;
  try {
    const mode = getModeFromSelect($("#modeSelect"));
    saveMode(mode);

    const { job } = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ projectId, prompt, parentJobId, mode }),
    });
    state.currentJobId = job.id;
    renderCurrentJob(job);
    $("#promptInput").value = "";
    await refreshData();
    startPollingCurrentJob();
  } catch (error) {
    showToast(error.message);
  } finally {
    $("#submitJobButton").disabled = false;
  }
});

on("#followUpForm", "submit", async (event) => {
  event.preventDefault();
  const prompt = $("#followUpInput")?.value.trim();
  if (!prompt) {
    showToast(t("toast.enterFollowUp"));
    return;
  }

  const button = $("#followUpButton");
  if (button) button.disabled = true;
  try {
    await submitFollowUp(prompt, state.currentJobId);
  } catch (error) {
    showToast(error.message);
  } finally {
    updateFollowUpComposer(state.currentJob);
  }
});

on("#followUpInput", "keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  $("#followUpForm")?.requestSubmit();
});

on("#followUpInput", "input", (event) => {
  const input = event.currentTarget;
  autosizeTextarea(input);
  if (state.currentJobId) {
    if (input.value.trim()) {
      state.followUpDrafts.set(state.currentJobId, input.value);
    } else {
      state.followUpDrafts.delete(state.currentJobId);
    }
  }
});

on("#modeSelect", "change", (event) => {
  saveMode(getModeFromSelect(event.currentTarget));
});

on("#followUpModeSelect", "change", (event) => {
  saveMode(getModeFromSelect(event.currentTarget));
});

on("#jobList", "click", async (event) => {
  const item = event.target.closest(".job-item");
  if (!item) return;

  const clickedId = item.dataset.jobId;
  const chain = getConversationChain(clickedId);
  const tip = chain.at(-1);
  state.currentJobId = tip?.id || clickedId;

  const chatOutput = $("#chatOutput");
  if (chatOutput) delete chatOutput.dataset.ready;
  await refreshCurrentJob();
  renderJobs();
});

function isStandaloneDisplay() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.navigator.standalone === true
  );
}

function isIosSafari() {
  const ua = window.navigator.userAgent.toLowerCase();
  const isAppleMobile = /iphone|ipad|ipod/.test(ua);
  const isWebkit = /webkit/.test(ua);
  const isChromeOrCriOS = /crios|chrome|fxios|edgios/.test(ua);
  return isAppleMobile && isWebkit && !isChromeOrCriOS;
}

function updateInstallButtonVisibility() {
  const button = $("#installButton");
  if (!button) return;

  if (isStandaloneDisplay()) {
    button.classList.add("hidden");
    return;
  }

  // Chromium 收到 beforeinstallprompt 后显示；iOS 永不触发该事件，改为常驻安装引导
  if (state.installPromptEvent || isIosSafari()) {
    button.classList.remove("hidden");
    return;
  }

  button.classList.add("hidden");
}

function showManualInstallHint() {
  if (isIosSafari()) {
    showToast(t("toast.iosInstall"));
    return;
  }

  showToast(t("toast.manualInstall"));
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPromptEvent = event;
  updateInstallButtonVisibility();
});

window.addEventListener("appinstalled", () => {
  state.installPromptEvent = null;
  updateInstallButtonVisibility();
  showToast(t("toast.installed"));
});

on("#installButton", "click", async () => {
  if (!state.installPromptEvent) {
    showManualInstallHint();
    return;
  }

  state.installPromptEvent.prompt();
  await state.installPromptEvent.userChoice.catch(() => undefined);
  state.installPromptEvent = null;
  updateInstallButtonVisibility();
});

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  // 注销掉带 ?v= 的旧注册，避免旧 SW 长期控制页面导致登录脚本失效
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    registrations.map(async (registration) => {
      const scriptURL =
        registration.active?.scriptURL ||
        registration.waiting?.scriptURL ||
        registration.installing?.scriptURL ||
        "";
      if (scriptURL.includes("sw.js?")) {
        await registration.unregister();
      }
    }),
  );

  await navigator.serviceWorker.register("/sw.js");
  updateInstallButtonVisibility();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    registerServiceWorker().catch((error) => {
      console.warn("Service Worker 注册失败", error);
    });
  });
}

$("#langSwitch")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-lang]");
  if (!button) return;
  const next = button.dataset.lang === "en" ? "en" : "zh";
  if (next === getLocale()) return;
  applyLocale(next);
});

stripCredentialsFromUrl();
applyDomI18n();
updateLangSwitch();
updateInstallButtonVisibility();
setModeSelect($("#modeSelect"), loadSavedMode());
ensureMarkdownLibs().catch((error) => {
  console.warn("Markdown 组件加载失败", error);
});

// 有 boot.js 时由 boot 在登录后调用 onBootAuthenticated，避免抢跑导致未带令牌请求
if (!window.__crcBootManaged) {
  bootstrap().catch((error) => {
    console.error("初始化失败", error);
    if (!window.__crcSession?.csrfToken) {
      setLoggedIn(false);
      showToast(error instanceof Error ? error.message : t("toast.requestFailed"));
    }
  });
}
