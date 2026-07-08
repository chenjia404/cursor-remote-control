import { APP_VERSION } from "./version.js";

const state = {
  csrfToken: "",
  jobs: [],
  projects: [],
  currentJobId: "",
  currentJob: null,
  pollingTimer: null,
  installPromptEvent: null,
  followUpDrafts: new Map(),
};

const versionEl = document.querySelector("#appVersion");
if (versionEl) {
  versionEl.textContent = `v${APP_VERSION}`;
}

const $ = (selector) => document.querySelector(selector);

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
  const previousValue = select.value;
  const keyword = $("#projectSearchInput").value.trim().toLowerCase();
  const projects = state.projects.filter((project) => {
    if (!keyword) return true;
    return `${project.name} ${project.path}`.toLowerCase().includes(keyword);
  });

  select.innerHTML = projects
    .map((project) => {
      const modifiedAt = project.modifiedAt ? new Date(project.modifiedAt).toLocaleString() : "未知时间";
      return `<option value="${project.id}">${project.name} · ${modifiedAt} · ${project.path}</option>`;
    })
    .join("");

  if (projects.some((project) => project.id === previousValue)) {
    select.value = previousValue;
  }

  if (projects.length === 0) {
    select.innerHTML = '<option value="">没有匹配的项目</option>';
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

function followUpHint(job) {
  if (["queued", "running"].includes(job.status)) {
    return "任务进行中，完成后可继续安排";
  }
  if (!job?.agentId) {
    return "该任务没有可继续的会话";
  }
  return "基于当前会话继续对话 · Enter 发送，Shift+Enter 换行";
}

function rememberFollowUpDrafts() {
  document.querySelectorAll(".job-follow-up-input").forEach((input) => {
    const jobId = input.closest("[data-parent-job-id]")?.dataset.parentJobId;
    if (!jobId) return;
    const value = input.value;
    if (value.trim()) {
      state.followUpDrafts.set(jobId, value);
    } else {
      state.followUpDrafts.delete(jobId);
    }
  });

  const currentInput = $("#followUpInput");
  if (state.currentJobId && currentInput && !currentInput.disabled) {
    const value = currentInput.value;
    if (value.trim()) {
      state.followUpDrafts.set(state.currentJobId, value);
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
  rememberFollowUpDrafts();

  const activeInput = document.activeElement;
  const focusedParentJobId =
    activeInput?.classList?.contains("job-follow-up-input")
      ? activeInput.closest("[data-parent-job-id]")?.dataset.parentJobId
      : "";
  const selectionStart = focusedParentJobId ? activeInput.selectionStart : null;
  const selectionEnd = focusedParentJobId ? activeInput.selectionEnd : null;

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
      const disabled = !canFollowUp(job);
      const draft = state.followUpDrafts.get(job.id) || "";
      const activeClass = job.id === state.currentJobId ? " active" : "";
      return `
        <article class="job-item${activeClass}" data-job-id="${job.id}">
          <div class="job-item-summary">
            <strong>${escapeHtml(job.project.name)}<span class="status status-${job.status}">${statusText(job.status)}</span></strong>
            <div>${escapeHtml(job.promptSummary)}</div>
            <div class="meta">${new Date(job.createdAt).toLocaleString()} · ${job.id}</div>
          </div>
          <form class="follow-up-composer job-follow-up" data-parent-job-id="${job.id}">
            <textarea
              class="job-follow-up-input"
              rows="2"
              placeholder="继续安排这个任务…"
              ${disabled ? "disabled" : ""}
            >${escapeHtml(draft)}</textarea>
            <div class="follow-up-actions">
              <span class="hint">${escapeHtml(followUpHint(job))}</span>
              <button type="submit" ${disabled ? "disabled" : ""}>发送</button>
            </div>
          </form>
        </article>
      `;
    })
    .join("");

  list.querySelectorAll(".job-follow-up-input").forEach((input) => {
    if (input.value) autosizeTextarea(input);
  });

  if (focusedParentJobId) {
    const nextInput = list.querySelector(
      `[data-parent-job-id="${focusedParentJobId}"] .job-follow-up-input`,
    );
    if (nextInput && !nextInput.disabled) {
      nextInput.focus();
      if (selectionStart != null && selectionEnd != null) {
        nextInput.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }
}

function canFollowUp(job) {
  return Boolean(job?.agentId) && !["queued", "running"].includes(job.status);
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

  if (!job) {
    form.classList.add("hidden");
    input.value = "";
    return;
  }

  form.classList.remove("hidden");

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

function renderCurrentJob(job) {
  state.currentJob = job || null;

  if (!job) {
    $("#currentJob").textContent = "暂无任务";
    $("#logOutput").textContent = "";
    updateFollowUpComposer(null);
    return;
  }

  $("#currentJob").innerHTML = `
    <strong>${escapeHtml(job.project.name)}</strong>
    <span class="status status-${job.status}">${statusText(job.status)}</span>
    <p class="meta">${escapeHtml(job.promptSummary)}</p>
  `;
  $("#logOutput").textContent = formatLogs(job.logs);
  updateFollowUpComposer(job);
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

  const { job: created } = await api("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      projectId: job.project.id,
      prompt,
      parentJobId: job.id,
    }),
  });

  state.followUpDrafts.delete(job.id);
  state.currentJobId = created.id;
  renderCurrentJob(created);
  $("#followUpInput").value = "";
  await refreshData();
  startPollingCurrentJob();
}

function formatLogs(logs) {
  const lines = [];

  for (const log of logs) {
    const time = new Date(log.time).toLocaleTimeString();
    if (log.level === "assistant") {
      const previous = lines.at(-1);
      if (previous?.level === "assistant") {
        previous.message += log.message;
      } else {
        lines.push({ level: "assistant", message: `[${time}] assistant:\n${log.message.trimStart()}` });
      }
      continue;
    }

    lines.push({ level: log.level, message: `[${time}] ${log.level}: ${log.message}` });
  }

  return lines.map((line) => line.message).join("\n\n");
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

$("#projectSearchInput").addEventListener("input", renderProjects);

$("#submitJobButton").addEventListener("click", async () => {
  const prompt = $("#promptInput").value.trim();
  const projectId = $("#projectSelect").value;
  const parentJobId = $("#parentJobSelect").value || undefined;

  if (!projectId) {
    showToast("没有可用项目");
    return;
  }
  if (!prompt) {
    showToast("请输入任务指令");
    return;
  }

  $("#submitJobButton").disabled = true;
  try {
    const { job } = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ projectId, prompt, parentJobId }),
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

$("#jobList").addEventListener("click", async (event) => {
  if (event.target.closest(".follow-up-composer")) return;
  const item = event.target.closest(".job-item");
  if (!item) return;
  state.currentJobId = item.dataset.jobId;
  await refreshCurrentJob();
  renderJobs();
});

$("#jobList").addEventListener("submit", async (event) => {
  const form = event.target.closest(".job-follow-up");
  if (!form) return;
  event.preventDefault();

  const parentJobId = form.dataset.parentJobId;
  const input = form.querySelector(".job-follow-up-input");
  const button = form.querySelector('button[type="submit"]');
  const prompt = input?.value.trim() || "";

  if (!prompt) {
    showToast("请输入后续安排");
    return;
  }

  button.disabled = true;
  input.disabled = true;
  try {
    await submitFollowUp(prompt, parentJobId);
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
    input.disabled = false;
  }
});

$("#jobList").addEventListener("keydown", (event) => {
  if (!event.target.classList.contains("job-follow-up-input")) return;
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  event.target.closest(".job-follow-up")?.requestSubmit();
});

$("#jobList").addEventListener("input", (event) => {
  if (!event.target.classList.contains("job-follow-up-input")) return;
  autosizeTextarea(event.target);
  const parentJobId = event.target.closest("[data-parent-job-id]")?.dataset.parentJobId;
  if (!parentJobId) return;
  if (event.target.value.trim()) {
    state.followUpDrafts.set(parentJobId, event.target.value);
  } else {
    state.followUpDrafts.delete(parentJobId);
  }
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
bootstrap();
