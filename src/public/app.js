import { APP_VERSION } from "./version.js";
import {
  applyDomI18n,
  getLocale,
  initLocale,
  localeTag,
  setLocale,
  t,
  translateApiError,
} from "./i18n.js?v=0.2.17";

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
const MODEL_STORAGE_KEY = "cursor-rc-model";
const PANEL_STORAGE_KEY = "cursor-rc-panels";
const DEFAULT_PANEL_EXPANDED = {
  submit: true,
  session: true,
  history: false,
};

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
  models: [],
  defaultModel: null,
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
  applyPanelState();
  renderModelSettings("submit");
  renderModelSettings("followUp");
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

function loadPanelState() {
  const next = { ...DEFAULT_PANEL_EXPANDED };
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (!raw) return next;
    const parsed = JSON.parse(raw);
    for (const key of Object.keys(DEFAULT_PANEL_EXPANDED)) {
      if (typeof parsed[key] === "boolean") next[key] = parsed[key];
    }
  } catch {
    // localStorage 不可用或数据损坏时使用默认值
  }
  return next;
}

function savePanelState(panels) {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(panels));
  } catch {
    // localStorage 不可用时忽略
  }
}

function applyPanelState(panels = loadPanelState()) {
  document.querySelectorAll("[data-panel]").forEach((card) => {
    const id = card.dataset.panel;
    if (!id || !(id in DEFAULT_PANEL_EXPANDED)) return;
    const expanded = panels[id] !== false;
    card.classList.toggle("is-collapsed", !expanded);
    const toggle = card.querySelector("[data-panel-toggle]");
    if (toggle) {
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      toggle.setAttribute("aria-label", `${t(expanded ? "panel.collapse" : "panel.expand")} ${t(`${id}.title`)}`);
    }
  });
}

function setPanelExpanded(id, expanded) {
  if (!(id in DEFAULT_PANEL_EXPANDED)) return;
  const panels = loadPanelState();
  panels[id] = Boolean(expanded);
  savePanelState(panels);
  applyPanelState(panels);
}

function togglePanel(id) {
  const panels = loadPanelState();
  setPanelExpanded(id, !panels[id]);
}

function getModeFromSelect(select) {
  const value = select?.value;
  return value === "plan" ? "plan" : "agent";
}

function setModeSelect(select, mode) {
  if (!select) return;
  select.value = mode === "plan" ? "plan" : "agent";
}

function hasI18n(key) {
  return t(key) !== key;
}

function paramLabel(paramId, displayName) {
  const key = `model.param.${paramId}`;
  if (hasI18n(key)) return t(key);
  return displayName || paramId;
}

function paramValueLabel(paramId, value, displayName) {
  const specific = `model.param.${paramId}.${value}`;
  if (hasI18n(specific)) return t(specific);
  const generic = `model.param.${value}`;
  if (hasI18n(generic)) return t(generic);
  return displayName || value;
}

function findCatalogModel(id) {
  return state.models.find((item) => item.id === id || item.aliases?.includes(id));
}

function defaultParamsForModel(model) {
  if (!model) return [];
  const preset = model.variants?.find((item) => item.isDefault) ?? model.variants?.[0];
  if (preset?.params?.length) return preset.params.map((item) => ({ id: item.id, value: item.value }));
  return (model.parameters ?? [])
    .map((parameter) => {
      const value = parameter.values?.[0]?.value;
      return value ? { id: parameter.id, value } : null;
    })
    .filter(Boolean);
}

function loadSavedModel() {
  try {
    const saved = JSON.parse(localStorage.getItem(MODEL_STORAGE_KEY) || "null");
    if (saved?.id) return { id: String(saved.id), params: Array.isArray(saved.params) ? saved.params : [] };
  } catch {
    // localStorage 不可用或数据损坏时忽略
  }
  return state.defaultModel || { id: "auto", params: [] };
}

function saveModelSelection(selection) {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // localStorage 不可用时忽略
  }
}

function collectModelSelection(kind) {
  const select = $(kind === "followUp" ? "#followUpModelSelect" : "#modelSelect");
  const paramsRoot = $(kind === "followUp" ? "#followUpModelParams" : "#modelParams");
  const id = select?.value || loadSavedModel().id;
  const params = [...(paramsRoot?.querySelectorAll("[data-model-param]") || [])]
    .map((element) => ({
      id: element.dataset.modelParam,
      value: element.value,
    }))
    .filter((item) => item.id && item.value);
  return params.length ? { id, params } : { id };
}

function applyModelSelection(kind, selection) {
  const select = $(kind === "followUp" ? "#followUpModelSelect" : "#modelSelect");
  const paramsRoot = $(kind === "followUp" ? "#followUpModelParams" : "#modelParams");
  if (!select || !paramsRoot) return;

  const fallback = loadSavedModel();
  const chosen = {
    id: selection?.id && findCatalogModel(selection.id) ? selection.id : fallback.id,
    params: Array.isArray(selection?.params) && selection.params.length ? selection.params : fallback.params,
  };
  if (![...select.options].some((option) => option.value === chosen.id) && state.models[0]) {
    chosen.id = state.models[0].id;
    chosen.params = defaultParamsForModel(state.models[0]);
  }
  select.value = chosen.id;
  renderModelParams(kind, chosen);
}

function matchingVariantValue(model, params) {
  if (!model?.variants?.length) return "";
  const list = params || [];
  const match = model.variants.find(
    (variant) =>
      variant.params.length === list.length &&
      variant.params.every((item) => list.some((param) => param.id === item.id && param.value === item.value)),
  );
  return match ? JSON.stringify(match.params) : "";
}

function renderModelParams(kind, selection) {
  const paramsRoot = $(kind === "followUp" ? "#followUpModelParams" : "#modelParams");
  if (!paramsRoot) return;

  const model = findCatalogModel(selection?.id);
  const compact = kind === "followUp";
  const params = selection?.params?.length ? selection.params : defaultParamsForModel(model);
  const byId = new Map(params.map((item) => [item.id, item.value]));
  const parts = [];

  if (model?.variants?.length > 1) {
    const current = matchingVariantValue(model, params);
    parts.push(`
      <label>
        <span>${escapeHtml(t("submit.modelVariant"))}</span>
        <select data-model-variant>
          <option value="">${escapeHtml(t("submit.modelCustom"))}</option>
          ${model.variants
            .map((variant) => {
              const value = JSON.stringify(variant.params);
              const selected = value === current ? " selected" : "";
              return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(variant.displayName || t("submit.modelCustom"))}</option>`;
            })
            .join("")}
        </select>
      </label>
    `);
  }

  for (const parameter of model?.parameters || []) {
    const current = byId.get(parameter.id) || parameter.values?.[0]?.value || "";
    parts.push(`
      <label>
        <span>${escapeHtml(paramLabel(parameter.id, parameter.displayName))}</span>
        <select data-model-param="${escapeHtml(parameter.id)}">
          ${(parameter.values || [])
            .map((item) => {
              const selected = item.value === current ? " selected" : "";
              return `<option value="${escapeHtml(item.value)}"${selected}>${escapeHtml(paramValueLabel(parameter.id, item.value, item.displayName))}</option>`;
            })
            .join("")}
        </select>
      </label>
    `);
  }

  paramsRoot.classList.toggle("compact", compact);
  paramsRoot.innerHTML = parts.join("");
}

function renderModelSettings(kind) {
  const select = $(kind === "followUp" ? "#followUpModelSelect" : "#modelSelect");
  if (!select) return;

  const previous = collectModelSelection(kind);
  select.innerHTML = state.models
    .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.displayName || model.id)}</option>`)
    .join("");
  applyModelSelection(kind, previous.id ? previous : loadSavedModel());
}

function formatModelBadge(model) {
  if (!model?.id) return "";
  const catalog = findCatalogModel(model.id);
  const name = catalog?.displayName || model.id;
  const extras = (model.params || [])
    .map((param) => {
      const definition = catalog?.parameters?.find((item) => item.id === param.id);
      const value = definition?.values?.find((item) => item.value === param.value);
      if (param.value === "false") return "";
      if (param.value === "true") return paramLabel(param.id, definition?.displayName);
      return paramValueLabel(param.id, param.value, value?.displayName);
    })
    .filter(Boolean);
  const label = extras.length ? `${name} · ${extras.join(" / ")}` : name;
  return `<span class="mode-badge model-badge">${escapeHtml(label)}</span>`;
}

function bindModelSettings(kind) {
  const select = $(kind === "followUp" ? "#followUpModelSelect" : "#modelSelect");
  const paramsRoot = $(kind === "followUp" ? "#followUpModelParams" : "#modelParams");
  select?.addEventListener("change", () => {
    const model = findCatalogModel(select.value);
    const next = { id: select.value, params: defaultParamsForModel(model) };
    renderModelParams(kind, next);
    saveModelSelection(collectModelSelection(kind));
  });
  paramsRoot?.addEventListener("change", (event) => {
    const variant = event.target.closest("[data-model-variant]");
    if (variant) {
      let params = [];
      try {
        params = variant.value ? JSON.parse(variant.value) : [];
      } catch {
        params = [];
      }
      renderModelParams(kind, { id: select.value, params });
    }
    saveModelSelection(collectModelSelection(kind));
  });
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
            <strong>${escapeHtml(job.project.name)}<span class="status status-${job.status}">${statusText(job.status)}</span>${modeBadge(job.mode)}${formatModelBadge(job.model)}</strong>
            <div>${escapeHtml(job.promptSummary)}</div>
            <div class="meta">${escapeHtml(formatDateTime(job.createdAt))} · ${job.id}</div>
          </div>
        </article>
      `;
    })
    .join("");
}

function getJobTurns(job) {
  if (!job) return [];
  if (Array.isArray(job.turns) && job.turns.length > 0) return job.turns;
  return [
    {
      id: job.activeTurnId || job.id,
      prompt: job.prompt,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      mode: job.mode,
      result: job.result,
      error: job.error,
    },
  ];
}

function conversationIsBusy(job) {
  return getJobTurns(job).some((turn) => ["queued", "running"].includes(turn.status));
}

function canFollowUp(job) {
  return Boolean(job);
}

function canStopJob(job) {
  return conversationIsBusy(job);
}

let followUpBoundJobId = "";

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
    followUpBoundJobId = "";
    return;
  }

  form.classList.remove("hidden");
  if (followUpBoundJobId !== job.id) {
    followUpBoundJobId = job.id;
    setModeSelect(modeSelect, job.mode || loadSavedMode());
    applyModelSelection("followUp", job.model || loadSavedModel());
  }

  const draft = state.followUpDrafts.get(job.id) || "";
  if (document.activeElement !== input) {
    input.value = draft;
    autosizeTextarea(input);
  }

  if (!canFollowUp(job)) {
    button.disabled = true;
    input.disabled = true;
    hint.textContent = t("session.followUpHintNoAgent");
    return;
  }

  button.disabled = false;
  input.disabled = false;
  hint.textContent = conversationIsBusy(job) ? t("session.followUpHintBusy") : t("session.followUpHintReady");
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

function buildChatMessages(job) {
  const messages = [];
  const turns = getJobTurns(job);
  const logs = job.logs || [];

  for (const turn of turns) {
    messages.push({
      role: "user",
      time: turn.createdAt,
      text: turn.prompt,
    });

    let sawAssistant = false;
    let sawThinking = false;
    for (const log of logs) {
      if (log.turnId && log.turnId !== turn.id) continue;
      if (!log.turnId && turn.id !== turns[0]?.id) continue;

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
    }

    if (!sawAssistant && typeof turn.result === "string" && turn.result.trim()) {
      appendChatMessage(messages, "assistant", turn.result, turn.finishedAt || job.updatedAt);
    }

    if (!sawAssistant && !sawThinking && !turn.result && ["queued", "running"].includes(turn.status)) {
      messages.push({
        role: "system",
        level: "info",
        time: turn.startedAt || turn.createdAt,
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

  const messages = buildChatMessages(job);
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
    ${formatModelBadge(job.model)}
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

async function submitFollowUp(prompt, jobId) {
  const job = findJob(jobId);
  if (!job) {
    showToast(t("toast.selectJob"));
    return;
  }
  if (!canFollowUp(job)) {
    showToast(t("toast.cannotFollowUp"));
    return;
  }

  const mode = getModeFromSelect($("#followUpModeSelect"));
  const model = collectModelSelection("followUp");
  saveMode(mode);
  saveModelSelection(model);

  const { job: updated } = await api(`/api/jobs/${job.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ prompt, mode, model }),
  });

  state.followUpDrafts.delete(job.id);
  state.currentJobId = updated.id;
  renderCurrentJob(updated);
  $("#followUpInput").value = "";
  await refreshData();
  startPollingCurrentJob();
}

async function refreshData() {
  const [projectsData, jobsData, modelsData] = await Promise.all([
    api("/api/projects"),
    api("/api/jobs"),
    api("/api/models").catch(() => null),
  ]);
  state.projects = projectsData.projects;
  const nextModels = modelsData?.models || [];
  const nextIds = nextModels.map((item) => item.id).join("|");
  const prevIds = state.models.map((item) => item.id).join("|");
  if (nextModels.length) {
    state.models = nextModels;
    state.defaultModel = modelsData.defaultModel || { id: "auto" };
    if (nextIds !== prevIds) {
      renderModelSettings("submit");
      renderModelSettings("followUp");
    }
  } else if (!state.models.length) {
    showToast(t("toast.modelsFailed"));
  }
  state.jobs = jobsData.jobs;
  renderProjects();
  renderJobs();

  if (state.currentJobId) {
    await refreshCurrentJob();
  }
}

async function refreshCurrentJob() {
  if (!state.currentJobId) return;
  const jobsData = await api("/api/jobs");
  state.jobs = jobsData.jobs;
  renderJobs();

  const job = findJob(state.currentJobId);
  if (!job) return;
  renderCurrentJob(job);

  if (!conversationIsBusy(job) && state.pollingTimer) {
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
    state.currentJobId = updatedJob.id;
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
    const model = collectModelSelection("submit");
    saveMode(mode);
    saveModelSelection(model);

    const { job } = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ projectId, prompt, parentJobId, mode, model }),
    });
    state.currentJobId = job.id;
    setPanelExpanded("submit", false);
    setPanelExpanded("session", true);
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

on("#appView", "click", (event) => {
  const toggle = event.target.closest("[data-panel-toggle]");
  if (!toggle || !event.currentTarget.contains(toggle)) return;
  event.preventDefault();
  togglePanel(toggle.dataset.panelToggle);
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
  state.currentJobId = clickedId;
  setPanelExpanded("session", true);

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
applyPanelState();
updateInstallButtonVisibility();
setModeSelect($("#modeSelect"), loadSavedMode());
bindModelSettings("submit");
bindModelSettings("followUp");
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
