import { APP_VERSION } from "./version.js";

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

const versionEl = document.querySelector("#appVersion");
if (versionEl) {
  versionEl.textContent = `v${APP_VERSION}`;
}

const $ = (selector) => document.querySelector(selector);

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

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(state.csrfToken ? { "x-csrf-token": state.csrfToken } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "请求失败");
  }

  return data;
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
    select.innerHTML = '<option value="">暂无已选项目，请先按目录打开并确认</option>';
    if (hint) hint.textContent = "下拉列表只显示已确认过的项目。新项目请点「按目录打开」浏览并确认。";
    return;
  }

  if (projects.length === 0) {
    select.innerHTML = '<option value="">没有匹配的已选项目</option>';
    return;
  }

  select.innerHTML = projects
    .map((project) => {
      const modifiedAt = project.modifiedAt ? new Date(project.modifiedAt).toLocaleString() : "未知时间";
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

  pathEl.textContent = currentPath || "选择允许的根目录开始浏览";
  // 已进入具体目录时允许返回；在某个 PROJECT_ROOT 顶层时回到根列表
  upButton.disabled = loading || !currentPath;
  selectButton.disabled = loading || !currentPath || !currentIsProject;
  selectButton.textContent = currentIsProject ? "确认当前目录为项目" : "当前目录不是有效项目";

  if (loading) {
    listEl.innerHTML = '<p class="browse-empty">正在加载目录…</p>';
    return;
  }

  if (entries.length === 0) {
    listEl.innerHTML = '<p class="browse-empty">此目录下没有可进入的子文件夹</p>';
    return;
  }

  listEl.innerHTML = entries
    .map((entry) => {
      const badge = entry.isProject ? '<span class="browse-badge">可确认</span>' : "";
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
    showToast("请先进入要打开的项目目录");
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
    showToast(`已确认项目：${project.name}`);
  } catch (error) {
    showToast(error.message);
  } finally {
    renderBrowsePanel();
  }
}

function statusText(status) {
  const map = {
    queued: "排队中",
    running: "运行中",
    finished: "已完成",
    error: "失败",
    cancelled: "已取消",
  };
  return map[status] || status;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
    '<option value="">新建会话</option>' +
    state.jobs
      .filter((job) => job.agentId)
      .map((job) => `<option value="${job.id}">${escapeHtml(job.project.name)} - ${escapeHtml(job.promptSummary)}</option>`)
      .join("");

  if (state.jobs.length === 0) {
    list.innerHTML = '<p class="empty">暂无历史任务</p>';
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
            <div class="meta">${new Date(job.createdAt).toLocaleString()} · ${job.id}</div>
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
    hint.textContent = "任务进行中，完成后可继续安排";
    return;
  }

  if (!job.agentId) {
    button.disabled = true;
    input.disabled = true;
    hint.textContent = "该任务没有可继续的会话";
    return;
  }

  button.disabled = false;
  input.disabled = false;
  hint.textContent = "基于当前会话继续对话 · Enter 发送，Shift+Enter 换行";
}

function updateStopButton(job) {
  const button = $("#stopJobButton");
  if (!button) return;

  const canStop = canStopJob(job);
  const isStopping = Boolean(job) && state.stoppingJobIds.has(job.id);
  button.classList.toggle("hidden", !canStop);
  button.disabled = !canStop || isStopping;
  button.textContent = isStopping ? "停止中…" : "停止";
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
        text: "AI 正在回复…",
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
    output.innerHTML = '<p class="empty">暂无会话内容</p>';
    return;
  }

  const wasNearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 80;

  output.innerHTML = messages
    .map((message) => {
      const time = new Date(message.time).toLocaleTimeString();
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
                <span>思考过程</span>
                <time>${escapeHtml(time)}</time>
              </summary>
              <div class="chat-text">${escapeHtml(message.text)}</div>
            </details>
          </div>
        `;
      }

      const side = message.role === "user" ? "right" : "left";
      const label = message.role === "user" ? "我" : "AI";
      return `
        <div class="chat-row chat-${side}">
          <div class="chat-bubble chat-bubble-${message.role}">
            <div class="chat-meta">
              <span>${label}</span>
              <time>${escapeHtml(time)}</time>
            </div>
            <div class="chat-text">${escapeHtml(message.text)}</div>
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
    $("#currentJob").textContent = "暂无任务";
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
    showToast("请先选择一个任务");
    return;
  }
  if (!canFollowUp(job)) {
    showToast("当前任务暂时无法继续安排");
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
    showToast("当前任务不能停止");
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
    showToast("已请求停止任务");
  } catch (error) {
    showToast(error.message);
  } finally {
    state.stoppingJobIds.delete(job.id);
    updateStopButton(state.currentJob);
  }
}

async function bootstrap() {
  try {
    const session = await api("/api/session");
    state.csrfToken = session.csrfToken;
    setLoggedIn(true);
    await refreshData();
  } catch {
    setLoggedIn(false);
  }
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
      }),
    });
    state.csrfToken = data.csrfToken;
    setLoggedIn(true);
    await refreshData();
  } catch (error) {
    showToast(error.message);
  }
});

$("#logoutButton").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
  state.csrfToken = "";
  setLoggedIn(false);
});

$("#refreshButton").addEventListener("click", () => {
  refreshData().catch((error) => showToast(error.message));
});

$("#stopJobButton").addEventListener("click", () => {
  stopCurrentJob().catch((error) => showToast(error.message));
});

$("#projectSearchInput").addEventListener("input", renderProjects);

$("#browseOpenButton").addEventListener("click", async () => {
  setBrowsePanelOpen(true);
  await loadBrowse(null);
});

$("#browseCloseButton").addEventListener("click", () => {
  setBrowsePanelOpen(false);
});

$("#browseUpButton").addEventListener("click", async () => {
  if (state.browse.parentPath) {
    await loadBrowse(state.browse.parentPath);
    return;
  }
  // 已在某个允许根目录顶层，或没有上级时，回到根列表
  await loadBrowse(null);
});

$("#browseSelectButton").addEventListener("click", async () => {
  await confirmBrowseSelection(state.browse.currentPath);
});

$("#browseList").addEventListener("click", async (event) => {
  const item = event.target.closest("[data-browse-path]");
  if (!item) return;
  await loadBrowse(item.dataset.browsePath);
});

$("#submitJobButton").addEventListener("click", async () => {
  const prompt = $("#promptInput").value.trim();
  const projectId = $("#projectSelect").value;
  const parentJobId = $("#parentJobSelect").value || undefined;

  if (!projectId) {
    showToast("请先选择或确认一个项目");
    return;
  }
  if (!prompt) {
    showToast("请输入任务指令");
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

$("#followUpForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = $("#followUpInput").value.trim();
  if (!prompt) {
    showToast("请输入后续安排");
    return;
  }

  const button = $("#followUpButton");
  button.disabled = true;
  try {
    await submitFollowUp(prompt, state.currentJobId);
  } catch (error) {
    showToast(error.message);
  } finally {
    updateFollowUpComposer(state.currentJob);
  }
});

$("#followUpInput").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  $("#followUpForm").requestSubmit();
});

$("#followUpInput").addEventListener("input", (event) => {
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

$("#modeSelect").addEventListener("change", (event) => {
  saveMode(getModeFromSelect(event.currentTarget));
});

$("#followUpModeSelect").addEventListener("change", (event) => {
  saveMode(getModeFromSelect(event.currentTarget));
});

$("#jobList").addEventListener("click", async (event) => {
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
    showToast("请点分享按钮，再选择“添加到主屏幕”。");
    return;
  }

  showToast("请用浏览器菜单中的“安装应用 / 添加到主屏幕”。需 HTTPS 或 localhost。");
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPromptEvent = event;
  updateInstallButtonVisibility();
});

window.addEventListener("appinstalled", () => {
  state.installPromptEvent = null;
  updateInstallButtonVisibility();
  showToast("已安装到设备。");
});

$("#installButton").addEventListener("click", async () => {
  if (!state.installPromptEvent) {
    showManualInstallHint();
    return;
  }

  state.installPromptEvent.prompt();
  await state.installPromptEvent.userChoice.catch(() => undefined);
  state.installPromptEvent = null;
  updateInstallButtonVisibility();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`/sw.js?v=${APP_VERSION}`)
      .then(() => updateInstallButtonVisibility())
      .catch((error) => {
        console.warn("Service Worker 注册失败", error);
      });
  });
}

updateInstallButtonVisibility();
setModeSelect($("#modeSelect"), loadSavedMode());
bootstrap();
