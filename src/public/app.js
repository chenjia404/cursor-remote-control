import { APP_VERSION } from "./version.js";
import {
  applyDomI18n,
  getLocale,
  initLocale,
  localeTag,
  setLocale,
  t,
  translateApiError,
} from "./i18n.js?v=0.2.27";

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

const FALLBACK_MODELS = [
  { id: "default", displayName: "Auto", aliases: ["auto"] },
  {
    id: "auto-smart",
    displayName: "Auto (Router)",
    parameters: [
      {
        id: "optimize_for",
        displayName: "Optimize for",
        values: [
          { value: "cost", displayName: "Cost" },
          { value: "balanced", displayName: "Balanced" },
          { value: "intelligence", displayName: "Intelligence" },
        ],
      },
    ],
  },
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [
      {
        id: "fast",
        displayName: "Fast",
        values: [
          { value: "false", displayName: "Standard" },
          { value: "true", displayName: "Fast" },
        ],
      },
    ],
  },
];

const MODE_STORAGE_KEY = "cursor-rc-mode";
const MODEL_STORAGE_KEY = "cursor-rc-model";
const AGENT_OPTIONS_KEY = "cursor-rc-agent-options";
const MAX_ATTACH_IMAGES = 4;
const DISALLOWABLE_TOOLS = ["shell", "mcp", "webSearch", "webFetch", "generateImage", "task", "delete", "edit"];
const PROJECT_STORAGE_KEY = "cursor-rc-project";
const TAB_STORAGE_KEY = "cursor-rc-tab";
const HISTORY_FILTER_KEY = "cursor-rc-history-filter";
const ARCHIVED_JOBS_KEY = "cursor-rc-archived-jobs";
const NOTIFY_STORAGE_KEY = "cursor-rc-notify";
const ONBOARDING_STORAGE_KEY = "cursor-rc-onboarded";
const FOLLOW_UP_OPTIONS_KEY = "cursor-rc-follow-up-options-open";
const SESSION_SUMMARY_KEY = "cursor-rc-session-summary-open";

const state = {
  csrfToken: "",
  jobs: [],
  projects: [],
  selectedProjectId: "",
  currentJobId: "",
  currentJob: null,
  activeTab: "session",
  historyFilter: "all",
  historySearch: "",
  showArchived: false,
  archivedJobIds: new Set(),
  notifyEnabled: false,
  lastNotifiedStatus: new Map(),
  pollingTimer: null,
  installPromptEvent: null,
  followUpDrafts: new Map(),
  stoppingJobIds: new Set(),
  chatPinnedToBottom: true,
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
  extraProjectIds: [],
  newTaskImages: [],
  followUpImages: [],
  agentOptionDefaults: {
    sandbox: false,
    autoReview: false,
    disallowedTools: [],
  },
};

initLocale();

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
  renderProjectList();
  renderJobs();
  renderBrowsePanel();
  renderCurrentJob(state.currentJob);
  updateContextHeader();
  updateNewTaskProjectLabel();
  renderModelSettings("submit");
  renderModelSettings("followUp");
  renderExtraWorkspaces();
  renderDisallowedTools("submit", collectDisallowedTools("submit"));
  renderDisallowedTools("followUp", collectDisallowedTools("followUp"));
  syncModeSegmentFromSelect();
  updateFilterChips();
  updateOnboardingVisibility();
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

function applySessionAgentDefaults(session) {
  const defaults = session?.agentOptions;
  if (defaults && typeof defaults === "object") {
    state.agentOptionDefaults = {
      sandbox: Boolean(defaults.sandbox),
      autoReview: Boolean(defaults.autoReview),
      disallowedTools: Array.isArray(defaults.disallowedTools) ? defaults.disallowedTools : [],
    };
  }
  applyAgentOptions("submit", loadSavedAgentOptions());
  applyAgentOptions("followUp", loadSavedAgentOptions());
}

function defaultAgentOptions() {
  return {
    loadLocalSettings: true,
    sandbox: Boolean(state.agentOptionDefaults.sandbox),
    autoReview: Boolean(state.agentOptionDefaults.autoReview),
    disallowedTools: [...(state.agentOptionDefaults.disallowedTools || [])],
    extraProjectIds: [...state.extraProjectIds],
  };
}

function loadSavedAgentOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem(AGENT_OPTIONS_KEY) || "null");
    if (!saved || typeof saved !== "object") return defaultAgentOptions();
    return {
      loadLocalSettings: saved.loadLocalSettings !== false,
      sandbox: Boolean(saved.sandbox),
      autoReview: Boolean(saved.autoReview),
      disallowedTools: Array.isArray(saved.disallowedTools)
        ? saved.disallowedTools.filter((item) => DISALLOWABLE_TOOLS.includes(item))
        : [],
      extraProjectIds: Array.isArray(saved.extraProjectIds) ? saved.extraProjectIds : [],
    };
  } catch {
    return defaultAgentOptions();
  }
}

function saveAgentOptions(options) {
  try {
    localStorage.setItem(AGENT_OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // ignore
  }
}

function toolToggleSelector(kind) {
  return kind === "followUp" ? "#followUpDisallowedTools" : "#disallowedTools";
}

function renderDisallowedTools(kind, selected = []) {
  const root = $(toolToggleSelector(kind));
  if (!root) return;
  const chosen = new Set(selected);
  root.innerHTML = DISALLOWABLE_TOOLS.map((tool) => {
    const active = chosen.has(tool) ? " active" : "";
    return `<button type="button" class="option-chip${active}" data-tool="${escapeHtml(tool)}">${escapeHtml(t(`tool.${tool}`))}</button>`;
  }).join("");
}

function collectDisallowedTools(kind) {
  return [...document.querySelectorAll(`${toolToggleSelector(kind)} .option-chip.active`)].map(
    (button) => button.dataset.tool,
  );
}

function renderExtraWorkspaces() {
  const root = $("#extraWorkspaceList");
  if (!root) return;
  const others = state.projects.filter((project) => project.id !== state.selectedProjectId);
  if (others.length === 0) {
    root.innerHTML = `<p class="hint">${escapeHtml(t("submit.extraWorkspacesEmpty"))}</p>`;
    return;
  }

  const selected = new Set(state.extraProjectIds);
  root.innerHTML = `<span class="sheet-label">${escapeHtml(t("submit.extraWorkspaces"))}</span>${others
    .map((project) => {
      const active = selected.has(project.id) ? " active" : "";
      return `<button type="button" class="option-chip${active}" data-extra-project="${escapeHtml(project.id)}">${escapeHtml(project.name)}</button>`;
    })
    .join("")}`;
}

function collectAgentOptions(kind) {
  const prefix = kind === "followUp" ? "followUp" : "";
  const loadToggle = $(prefix ? "#followUpLoadLocalSettingsToggle" : "#loadLocalSettingsToggle");
  const sandboxToggle = $(prefix ? "#followUpSandboxToggle" : "#sandboxToggle");
  const autoReviewToggle = $(prefix ? "#followUpAutoReviewToggle" : "#autoReviewToggle");
  return {
    loadLocalSettings: Boolean(loadToggle?.checked),
    sandbox: Boolean(sandboxToggle?.checked),
    autoReview: Boolean(autoReviewToggle?.checked),
    disallowedTools: collectDisallowedTools(kind),
    extraProjectIds: kind === "followUp" ? [] : [...state.extraProjectIds],
  };
}

function applyAgentOptions(kind, options) {
  const prefix = kind === "followUp" ? "followUp" : "";
  const loadToggle = $(prefix ? "#followUpLoadLocalSettingsToggle" : "#loadLocalSettingsToggle");
  const sandboxToggle = $(prefix ? "#followUpSandboxToggle" : "#sandboxToggle");
  const autoReviewToggle = $(prefix ? "#followUpAutoReviewToggle" : "#autoReviewToggle");
  if (loadToggle) loadToggle.checked = options.loadLocalSettings !== false;
  if (sandboxToggle) sandboxToggle.checked = Boolean(options.sandbox);
  if (autoReviewToggle) autoReviewToggle.checked = Boolean(options.autoReview);
  renderDisallowedTools(kind, options.disallowedTools || []);
  if (kind !== "followUp") {
    state.extraProjectIds = (options.extraProjectIds || []).filter((id) => id !== state.selectedProjectId);
    renderExtraWorkspaces();
  }
}

function imageStateKey(kind) {
  return kind === "followUp" ? "followUpImages" : "newTaskImages";
}

function revokeImagePreviews(kind) {
  for (const item of state[imageStateKey(kind)]) {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }
  state[imageStateKey(kind)] = [];
}

function renderImagePreviews(kind) {
  const root = $(kind === "followUp" ? "#followUpImagePreviews" : "#newTaskImagePreviews");
  if (!root) return;
  const items = state[imageStateKey(kind)];
  root.innerHTML = items
    .map(
      (item) => `
        <div class="image-preview">
          <img src="${escapeHtml(item.previewUrl)}" alt="" />
          <button type="button" data-remove-image="${escapeHtml(item.id)}" aria-label="remove">×</button>
        </div>
      `,
    )
    .join("");
}

async function fileToImagePayload(file) {
  if (file.size > 12 * 1024 * 1024) throw new Error(t("toast.imageTooLarge"));

  const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error(t("toast.imageUnsupported")));
      reader.readAsDataURL(blob);
    });

  try {
    const bitmap = await createImageBitmap(file);
    const maxDim = 1920;
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error(t("toast.imageUnsupported"));
    if (blob.size > 4 * 1024 * 1024) throw new Error(t("toast.imageTooLarge"));
    const dataUrl = await blobToDataUrl(blob);
    return { mimeType: "image/jpeg", data: dataUrl };
  } catch (error) {
    if (file.size > 4 * 1024 * 1024) throw error instanceof Error ? error : new Error(t("toast.imageTooLarge"));
    const dataUrl = await blobToDataUrl(file);
    return { mimeType: file.type || "image/jpeg", data: dataUrl };
  }
}

async function addImageFiles(kind, fileList) {
  const files = [...(fileList || [])].filter((file) => file.type.startsWith("image/"));
  if (!files.length) {
    showToast(t("toast.imageUnsupported"));
    return;
  }

  const current = state[imageStateKey(kind)];
  if (current.length + files.length > MAX_ATTACH_IMAGES) {
    showToast(t("toast.imageTooMany"));
    return;
  }

  for (const file of files) {
    current.push({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
    });
  }
  renderImagePreviews(kind);
}

async function collectImagePayloads(kind) {
  const items = state[imageStateKey(kind)];
  const payloads = [];
  for (const item of items) {
    payloads.push(await fileToImagePayload(item.file));
  }
  return payloads;
}

function formatUsage(usage) {
  if (!usage) return "";
  const total = usage.totalTokens ?? 0;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return `${t("session.usage")} ${total} (${input} / ${output})`;
}

function loadSavedTab() {
  try {
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    if (saved === "session" || saved === "history" || saved === "projects") return saved;
  } catch {
    // localStorage 不可用时忽略
  }
  return "session";
}

function saveTab(tab) {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // localStorage 不可用时忽略
  }
}

function loadHistoryFilter() {
  try {
    const saved = localStorage.getItem(HISTORY_FILTER_KEY);
    if (saved === "all" || saved === "active" || saved === "finished" || saved === "failed") return saved;
  } catch {
    // localStorage 不可用时忽略
  }
  return "all";
}

function saveHistoryFilter(filter) {
  try {
    localStorage.setItem(HISTORY_FILTER_KEY, filter);
  } catch {
    // localStorage 不可用时忽略
  }
}

function loadArchivedJobIds() {
  try {
    const raw = localStorage.getItem(ARCHIVED_JOBS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function saveArchivedJobIds() {
  try {
    localStorage.setItem(ARCHIVED_JOBS_KEY, JSON.stringify([...state.archivedJobIds]));
  } catch {
    // localStorage 不可用时忽略
  }
}

function loadNotifyEnabled() {
  try {
    return localStorage.getItem(NOTIFY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveNotifyEnabled(enabled) {
  state.notifyEnabled = Boolean(enabled);
  try {
    localStorage.setItem(NOTIFY_STORAGE_KEY, state.notifyEnabled ? "1" : "0");
  } catch {
    // localStorage 不可用时忽略
  }
}

function isOnboardingDone() {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function markOnboardingDone() {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
  } catch {
    // localStorage 不可用时忽略
  }
}

function isWideLayout() {
  return window.matchMedia("(min-width: 900px)").matches;
}

function updateWideLayout() {
  const app = $("#appView");
  if (!app) return;
  app.classList.toggle("is-wide", isWideLayout());
  if (isWideLayout() && state.activeTab === "history") {
    switchTab("session");
  }
  updateLayoutState();
}

function updateLayoutState() {
  const app = $("#appView");
  if (!app) return;
  app.dataset.activeTab = state.activeTab;
}

function loadSavedProjectId() {
  try {
    return localStorage.getItem(PROJECT_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function saveSelectedProjectId(projectId) {
  state.selectedProjectId = projectId || "";
  try {
    if (projectId) localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
    else localStorage.removeItem(PROJECT_STORAGE_KEY);
  } catch {
    // localStorage 不可用时忽略
  }
}

function switchTab(tabId) {
  let tab = tabId === "history" || tabId === "projects" ? tabId : "session";
  if (isWideLayout() && tab === "history") {
    tab = "session";
  }
  state.activeTab = tab;
  saveTab(tab);
  updateLayoutState();

  document.querySelectorAll(".main-panel .tab-panel").forEach((panel) => {
    const active = panel.dataset.tab === tab;
    panel.classList.toggle("active", active);
    panel.classList.toggle("hidden", !active);
    panel.hidden = !active;
  });

  document.querySelectorAll(".nav-item").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });

  updateContextHeader();
  updateComposerDock();
  updateOnboardingVisibility();
}

function openSheet(sheetId) {
  const sheet = document.getElementById(sheetId);
  if (!sheet) return;
  sheet.classList.remove("hidden");
  sheet.setAttribute("aria-hidden", "false");
}

function closeSheet(sheetId) {
  const sheet = document.getElementById(sheetId);
  if (!sheet) return;
  sheet.classList.add("hidden");
  sheet.setAttribute("aria-hidden", "true");
}

function closeAllSheets() {
  closeSheet("newTaskSheet");
  closeSheet("settingsSheet");
}

function getModeFromSelect(select) {
  const value = select?.value;
  return value === "plan" ? "plan" : "agent";
}

function setModeSelect(select, mode) {
  if (!select) return;
  select.value = mode === "plan" ? "plan" : "agent";
  syncModeSegmentFromSelect();
}

function syncModeSegmentFromSelect() {
  const mode = getModeFromSelect($("#modeSelect"));
  document.querySelectorAll(".mode-segment-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
}

function syncModeSelectFromSegment(mode) {
  setModeSelect($("#modeSelect"), mode);
  saveMode(mode);
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

let modelRetryCount = 0;

function applyModels(models, defaultModel) {
  const list = Array.isArray(models) && models.length ? models : FALLBACK_MODELS;
  const nextIds = list.map((item) => item.id).join("|");
  const prevIds = state.models.map((item) => item.id).join("|");
  const selectEmpty = !($("#modelSelect")?.options.length);
  state.models = list;
  state.defaultModel = defaultModel || { id: list[0]?.id || "default" };
  if (nextIds !== prevIds || selectEmpty) {
    renderModelSettings("submit");
    renderModelSettings("followUp");
  }
}

async function loadModels(retry = true) {
  try {
    const data = await api("/api/models");
    applyModels(data.models, data.defaultModel);
  } catch {
    applyModels(FALLBACK_MODELS, { id: "default" });
  }

  if (state.models.length > FALLBACK_MODELS.length) {
    modelRetryCount = 0;
    return;
  }

  if (retry && modelRetryCount < 6) {
    modelRetryCount += 1;
    window.setTimeout(() => {
      loadModels(true).catch(() => undefined);
    }, 5000);
  }
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
    cache: "no-store",
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
}

function findProject(projectId) {
  return state.projects.find((project) => project.id === projectId) || null;
}

function ensureSelectedProject() {
  if (state.selectedProjectId && findProject(state.selectedProjectId)) return;
  const saved = loadSavedProjectId();
  if (saved && findProject(saved)) {
    state.selectedProjectId = saved;
    return;
  }
  if (state.projects[0]) {
    saveSelectedProjectId(state.projects[0].id);
  }
}

function selectedProjectName() {
  return findProject(state.selectedProjectId)?.name || t("project.noneSelected");
}

function updateNewTaskProjectLabel() {
  const projectName = selectedProjectName();
  const label = $("#newTaskProjectName");
  if (label) label.textContent = projectName;
  const current = $("#projectCurrentName");
  if (current) current.textContent = projectName;
  renderExtraWorkspaces();
}

function selectProjectById(projectId) {
  const project = findProject(projectId);
  if (!project || state.selectedProjectId === projectId) return;
  saveSelectedProjectId(projectId);
  renderProjectList();
  updateContextHeader();
  showToast(t("project.switched", { name: project.name }));
}

const removingProjectIds = new Set();

async function removeConfirmedProject(projectId) {
  if (!projectId || removingProjectIds.has(projectId)) return;
  removingProjectIds.add(projectId);
  const project = findProject(projectId);
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
    if (state.selectedProjectId === projectId) {
      saveSelectedProjectId("");
    }
    await refreshData();
    showToast(t("project.removed", { name: project?.name || "" }));
  } finally {
    removingProjectIds.delete(projectId);
  }
}

function renderProjectList() {
  const list = $("#projectList");
  if (!list) return;
  const hint = $("#projectSelectHint");
  const keyword = $("#projectSearchInput")?.value.trim().toLowerCase() || "";
  const projects = state.projects.filter((project) => {
    if (!keyword) return true;
    return `${project.name} ${project.path}`.toLowerCase().includes(keyword);
  });

  ensureSelectedProject();

  if (state.projects.length === 0) {
    list.innerHTML = `<p class="empty">${escapeHtml(t("project.noneSelected"))}</p>`;
    if (hint) hint.textContent = t("submit.projectHint");
    updateNewTaskProjectLabel();
    return;
  }

  if (projects.length === 0) {
    list.innerHTML = `<p class="empty">${escapeHtml(t("project.noMatch"))}</p>`;
    updateNewTaskProjectLabel();
    return;
  }

  list.innerHTML = projects
    .map((project) => {
      const selected = project.id === state.selectedProjectId;
      const activeClass = selected ? " active" : "";
      const modifiedAt = project.modifiedAt ? formatDateTime(project.modifiedAt) : t("project.unknownTime");
      const badge = selected
        ? `<span class="mode-badge mode-agent">${escapeHtml(t("project.currentBadge"))}</span>`
        : "";
      const useLabel = selected ? t("project.using") : t("project.use");
      return `
        <article class="project-item${activeClass}" data-project-id="${escapeHtml(project.id)}">
          <div class="project-item-summary">
            <span class="project-item-name">${escapeHtml(project.name)}${badge}</span>
            <span class="project-item-path">${escapeHtml(modifiedAt)} · ${escapeHtml(project.path)}</span>
          </div>
          <div class="project-item-actions">
            <button type="button" class="ghost small project-use-btn" data-project-id="${escapeHtml(project.id)}"${selected ? " disabled" : ""}>${escapeHtml(useLabel)}</button>
            <button type="button" class="ghost small danger project-remove-btn" data-project-id="${escapeHtml(project.id)}">${escapeHtml(t("project.remove"))}</button>
          </div>
        </article>
      `;
    })
    .join("");

  if (hint) hint.textContent = t("submit.projectHint");
  updateNewTaskProjectLabel();
}

function setBrowseOverlayOpen(open) {
  state.browse.open = open;
  const overlay = $("#browseOverlay");
  overlay?.classList.toggle("hidden", !open);
  overlay?.setAttribute("aria-hidden", open ? "false" : "true");
}

function renderBrowsePanel() {
  const pathEl = $("#browsePath");
  const listEl = $("#browseList");
  const upButton = $("#browseUpButton");
  const selectButton = $("#browseSelectButton");
  const { currentPath, currentIsProject, entries, loading } = state.browse;

  pathEl.textContent = currentPath || t("submit.browseRootHint");
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
    saveSelectedProjectId(project.id);
    setBrowseOverlayOpen(false);
    showToast(t("project.confirmed", { name: project.name }));
    switchTab("projects");
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
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  updateComposerDock();
}

function bindComposerPanels() {
  const options = $("#followUpOptions");
  if (options && options.dataset.bound !== "1") {
    options.dataset.bound = "1";
    try {
      if (localStorage.getItem(FOLLOW_UP_OPTIONS_KEY) === "1") {
        options.open = true;
      }
    } catch {
      // localStorage 不可用时忽略
    }
    options.addEventListener("toggle", () => {
      try {
        localStorage.setItem(FOLLOW_UP_OPTIONS_KEY, options.open ? "1" : "0");
      } catch {
        // localStorage 不可用时忽略
      }
      updateComposerDock();
    });
  }

  const dock = $("#followUpDock");
  if (dock && dock.dataset.resizeBound !== "1") {
    dock.dataset.resizeBound = "1";
    dock.querySelectorAll("details").forEach((element) => {
      element.addEventListener("toggle", updateComposerDock);
    });
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => updateComposerDock());
      observer.observe(dock);
    }
  }
}

function updateSessionJobLayout(hasJob) {
  $("#sessionPullZone")?.classList.toggle("is-active-job", Boolean(hasJob));
}

function loadSessionSummaryOpen() {
  try {
    return localStorage.getItem(SESSION_SUMMARY_KEY) === "1";
  } catch {
    return false;
  }
}

function saveSessionSummaryOpen(open) {
  try {
    localStorage.setItem(SESSION_SUMMARY_KEY, open ? "1" : "0");
  } catch {
    // localStorage 不可用时忽略
  }
}

function updateComposerDock() {
  const dock = $("#followUpDock");
  const appShell = $("#appView");
  if (!dock || !appShell) return;

  const show = state.activeTab === "session" && Boolean(state.currentJob);
  dock.classList.toggle("hidden", !show);
  appShell.classList.toggle("has-composer", show);

  if (show) {
    const height = dock.offsetHeight;
    document.documentElement.style.setProperty("--composer-h", `${height}px`);
  } else {
    document.documentElement.style.setProperty("--composer-h", "0px");
  }
}

function updateFilterChips() {
  document.querySelectorAll("#historyFilters .filter-chip").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.historyFilter);
  });
}

function jobMatchesFilter(job) {
  const archived = state.archivedJobIds.has(job.id);
  if (!state.showArchived && archived) {
    return false;
  }

  const keyword = state.historySearch.trim().toLowerCase();
  if (keyword && !`${job.project.name} ${job.promptSummary}`.toLowerCase().includes(keyword)) {
    return false;
  }

  switch (state.historyFilter) {
    case "active":
      return ["queued", "running"].includes(job.status);
    case "finished":
      return job.status === "finished";
    case "failed":
      return ["error", "cancelled"].includes(job.status);
    default:
      return true;
  }
}

function toggleArchiveJob(jobId) {
  if (state.archivedJobIds.has(jobId)) {
    state.archivedJobIds.delete(jobId);
  } else {
    state.archivedJobIds.add(jobId);
  }
  saveArchivedJobIds();
  renderJobs();
}

function updateOnboardingVisibility() {
  const guide = $("#onboardingGuide");
  if (!guide) return;
  const show =
    state.activeTab === "session" &&
    !state.currentJob &&
    !isOnboardingDone() &&
    state.projects.length === 0 &&
    state.jobs.length === 0;
  guide.classList.toggle("hidden", !show);
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

function maybeNotifyJobStatus(job) {
  if (!state.notifyEnabled || !job || !document.hidden) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const previous = state.lastNotifiedStatus.get(job.id);
  if (previous === job.status) return;
  if (!["finished", "error", "cancelled"].includes(job.status)) return;

  state.lastNotifiedStatus.set(job.id, job.status);
  const title =
    job.status === "finished"
      ? t("notify.taskDone", { name: job.project?.name || "" })
      : t("notify.taskFailed", { name: job.project?.name || "" });

  try {
    new Notification(title, {
      body: job.promptSummary,
      tag: `crc-job-${job.id}`,
    });
  } catch {
    // 部分浏览器在后台可能拒绝通知
  }
}

function bindPullToRefresh(zone, indicator, onRefresh, getScrollEl) {
  if (!zone || !indicator || zone.dataset.ptrBound === "1") return;
  zone.dataset.ptrBound = "1";

  let startY = 0;
  let pulling = false;
  let distance = 0;
  const threshold = 68;
  const scrollEl = () => getScrollEl?.() || zone;

  const reset = () => {
    pulling = false;
    distance = 0;
    zone.classList.remove("is-pulling", "is-refreshing");
    indicator.querySelector(".pull-refresh-text").textContent = t("pull.pull");
  };

  zone.addEventListener(
    "touchstart",
    (event) => {
      if (scrollEl().scrollTop > 0) return;
      startY = event.touches[0].clientY;
      pulling = true;
    },
    { passive: true },
  );

  zone.addEventListener(
    "touchmove",
    (event) => {
      if (!pulling || scrollEl().scrollTop > 0) return;
      distance = Math.max(0, event.touches[0].clientY - startY);
      if (distance <= 0) return;
      zone.classList.add("is-pulling");
      indicator.querySelector(".pull-refresh-text").textContent =
        distance >= threshold ? t("pull.release") : t("pull.pull");
    },
    { passive: true },
  );

  zone.addEventListener("touchend", async () => {
    if (!pulling) return;
    if (distance < threshold) {
      reset();
      return;
    }

    zone.classList.remove("is-pulling");
    zone.classList.add("is-refreshing");
    try {
      await onRefresh();
    } catch (error) {
      showToast(error.message);
    } finally {
      reset();
    }
  });
}

function setupPullToRefresh() {
  bindPullToRefresh($("#historyPullZone"), $("#historyPullIndicator"), () => refreshData());
  bindPullToRefresh($("#projectsPullZone"), $("#projectsPullIndicator"), () => refreshData());
  bindPullToRefresh($("#sessionPullZone"), $("#sessionPullIndicator"), async () => {
    if (state.currentJobId) {
      await refreshCurrentJob();
      return;
    }
    await refreshData();
  }, () => {
    const chat = $("#chatOutput");
    return chat && !chat.classList.contains("hidden") ? chat : $("#sessionPullZone");
  });
}

function updateContextHeader(job = state.currentJob) {
  const eyebrow = $("#contextEyebrow");
  const title = $("#contextTitle");
  const status = $("#contextStatus");

  if (state.activeTab === "history") {
    eyebrow.textContent = t("nav.history");
    title.textContent = t("history.title");
    status.classList.add("hidden");
    return;
  }

  if (state.activeTab === "projects") {
    eyebrow.textContent = t("nav.projects");
    title.textContent = selectedProjectName();
    status.classList.add("hidden");
    return;
  }

  eyebrow.textContent = t("nav.session");
  if (!job) {
    title.textContent = t("session.empty");
    status.classList.add("hidden");
    return;
  }

  title.textContent = job.project?.name || t("session.empty");
  status.textContent = statusText(job.status);
  status.className = `status status-${job.status}`;
  status.classList.remove("hidden");
}

function renderJobs() {
  const list = $("#jobList");
  rememberFollowUpDraft();
  updateFilterChips();

  const jobs = state.jobs.filter(jobMatchesFilter);
  if (state.jobs.length === 0) {
    list.innerHTML = `<p class="empty">${escapeHtml(t("history.empty"))}</p>`;
    return;
  }

  if (jobs.length === 0) {
    list.innerHTML = `<p class="empty">${escapeHtml(t("history.noMatch"))}</p>`;
    return;
  }

  list.innerHTML = jobs
    .map((job) => {
      const activeClass = job.id === state.currentJobId ? " active" : "";
      const archived = state.archivedJobIds.has(job.id);
      const archiveLabel = archived ? t("history.unarchive") : t("history.archive");
      const archivedBadge = archived ? `<span class="mode-badge">${escapeHtml(t("history.archived"))}</span>` : "";
      return `
        <article class="job-item${activeClass}" data-job-id="${job.id}">
          <div class="job-item-summary">
            <strong>${escapeHtml(job.project.name)}${archivedBadge}<span class="status status-${job.status}">${statusText(job.status)}</span>${modeBadge(job.mode)}${formatModelBadge(job.model)}</strong>
            <div>${escapeHtml(job.promptSummary)}</div>
            <div class="meta">${escapeHtml(formatDateTime(job.createdAt))}</div>
          </div>
          <div class="job-item-actions">
            <button type="button" class="ghost job-archive-btn" data-job-id="${escapeHtml(job.id)}">${escapeHtml(archiveLabel)}</button>
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
  return state.jobs.find((job) => job.id === jobId) || (state.currentJob?.id === jobId ? state.currentJob : null);
}

function upsertJob(job) {
  if (!job) return;
  const index = state.jobs.findIndex((item) => item.id === job.id);
  if (index >= 0) {
    state.jobs[index] = job;
  } else {
    state.jobs.unshift(job);
  }
}

function updateFollowUpComposer(job) {
  const form = $("#followUpForm");
  const button = $("#followUpButton");
  const interruptButton = $("#followUpInterruptButton");
  const hint = $("#followUpHint");
  const input = $("#followUpInput");
  const modeSelect = $("#followUpModeSelect");

  if (!job) {
    form.classList.add("hidden");
    input.value = "";
    followUpBoundJobId = "";
    updateComposerDock();
    return;
  }

  form.classList.remove("hidden");
  if (followUpBoundJobId !== job.id) {
    followUpBoundJobId = job.id;
    setModeSelect(modeSelect, job.mode || loadSavedMode());
    applyModelSelection("followUp", job.model || loadSavedModel());
    applyAgentOptions("followUp", {
      loadLocalSettings: job.loadLocalSettings !== false,
      sandbox: Boolean(job.sandbox),
      autoReview: Boolean(job.autoReview),
      disallowedTools: job.disallowedTools || [],
    });
    revokeImagePreviews("followUp");
    renderImagePreviews("followUp");
  }

  const draft = state.followUpDrafts.get(job.id) || "";
  if (document.activeElement !== input) {
    input.value = draft;
    autosizeTextarea(input);
  }

  if (!canFollowUp(job)) {
    button.disabled = true;
    if (interruptButton) {
      interruptButton.disabled = true;
      interruptButton.classList.add("hidden");
    }
    input.disabled = true;
    hint.textContent = t("session.followUpHintNoAgent");
    updateComposerDock();
    return;
  }

  const busy = conversationIsBusy(job);
  button.disabled = false;
  button.textContent = busy ? t("session.followUpQueue") : t("session.followUpSend");
  input.disabled = false;
  if (interruptButton) {
    interruptButton.classList.toggle("hidden", !busy);
    interruptButton.disabled = !busy;
    interruptButton.textContent = t("session.followUpInterrupt");
  }
  hint.textContent = busy ? t("session.followUpHintBusy") : t("session.followUpHintReady");
  updateComposerDock();
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
      images: turn.images || [],
      jobId: job.id,
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

      if (log.level === "tool") {
        messages.push({
          role: "tool",
          time: log.time,
          text: log.message,
        });
        continue;
      }

      if (log.level === "status") {
        messages.push({
          role: "system",
          level: "status",
          time: log.time,
          text: log.message,
        });
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

function isChatNearBottom(output) {
  return output.scrollHeight - output.scrollTop - output.clientHeight < 80;
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

  const wasNearBottom = isChatNearBottom(output);

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

      if (message.role === "tool") {
        const [title, ...rest] = String(message.text || "").split("\n");
        return `
          <div class="chat-row chat-left">
            <details class="chat-tool">
              <summary>
                <span>${escapeHtml(title || t("session.tool"))}</span>
                <time>${escapeHtml(time)}</time>
              </summary>
              ${rest.length ? `<div class="chat-text">${escapeHtml(rest.join("\n"))}</div>` : ""}
            </details>
          </div>
        `;
      }

      const side = message.role === "user" ? "right" : "left";
      const label = message.role === "user" ? t("session.me") : t("session.ai");
      const images = (message.images || [])
        .map(
          (image) =>
            `<a href="/api/jobs/${escapeHtml(message.jobId)}/images/${escapeHtml(image.id)}" target="_blank" rel="noopener"><img src="/api/jobs/${escapeHtml(message.jobId)}/images/${escapeHtml(image.id)}" alt="" /></a>`,
        )
        .join("");
      return `
        <div class="chat-row chat-${side}">
          <div class="chat-bubble chat-bubble-${message.role}">
            <div class="chat-meta">
              <span>${escapeHtml(label)}</span>
              <time>${escapeHtml(time)}</time>
            </div>
            ${images ? `<div class="chat-images">${images}</div>` : ""}
            ${message.text?.trim() ? formatChatBody(message.role, message.text) : ""}
          </div>
        </div>
      `;
    })
    .join("");

  const fab = $("#newMessagesFab");
  if (wasNearBottom || state.chatPinnedToBottom) {
    output.scrollTop = output.scrollHeight;
    state.chatPinnedToBottom = true;
    fab?.classList.add("hidden");
  } else {
    fab?.classList.remove("hidden");
  }
}

function renderCurrentJob(job) {
  state.currentJob = job || null;
  const empty = $("#sessionEmpty");
  const summary = $("#currentJob");
  const chat = $("#chatOutput");

  if (!job) {
    empty?.classList.remove("hidden");
    summary?.classList.add("hidden");
    chat?.classList.add("hidden");
    summary.innerHTML = "";
    renderChatMessages(null);
    updateFollowUpComposer(null);
    updateStopButton(null);
    updateContextHeader(null);
    updateOnboardingVisibility();
    updateSessionJobLayout(false);
    return;
  }

  empty?.classList.add("hidden");
  summary?.classList.remove("hidden");
  chat?.classList.remove("hidden");
  updateSessionJobLayout(true);

  const extraNames = (job.extraProjects || []).map((item) => item.name).filter(Boolean);
  const extraLabel = extraNames.length ? `<p class="meta">${escapeHtml(t("session.extraWorkspaces", { names: extraNames.join("、") }))}</p>` : "";
  const usageLabel = formatUsage(job.usage);
  summary.innerHTML = `
    <details class="session-summary"${loadSessionSummaryOpen() ? " open" : ""}>
      <summary>
        <strong>${escapeHtml(job.project.name)}</strong>
        <span class="status status-${job.status}">${statusText(job.status)}</span>
        ${modeBadge(job.mode)}
        ${formatModelBadge(job.model)}
      </summary>
      <div class="session-summary-body">
        ${job.sandbox ? `<span class="mode-badge">${escapeHtml(t("submit.sandbox"))}</span>` : ""}
        ${job.autoReview ? `<span class="mode-badge">${escapeHtml(t("submit.autoReview"))}</span>` : ""}
        <p class="meta">${escapeHtml(job.promptSummary)}</p>
        ${extraLabel}
        ${usageLabel ? `<p class="usage-meta">${escapeHtml(usageLabel)}</p>` : ""}
      </div>
    </details>
  `;
  renderChatMessages(job);
  updateFollowUpComposer(job);
  updateStopButton(job);
  updateContextHeader(job);
  updateOnboardingVisibility();
}

let currentJobPollInFlight = false;

function stopPollingCurrentJob() {
  if (!state.pollingTimer) return;
  window.clearInterval(state.pollingTimer);
  state.pollingTimer = null;
}

function startPollingCurrentJob() {
  if (state.pollingTimer) return;
  state.pollingTimer = window.setInterval(() => {
    if (currentJobPollInFlight) return;
    currentJobPollInFlight = true;
    refreshCurrentJob()
      .catch((error) => showToast(error.message))
      .finally(() => {
        currentJobPollInFlight = false;
      });
  }, 1000);
}

async function submitFollowUp(prompt, jobId, delivery = "queue") {
  const job = findJob(jobId);
  if (!job) {
    showToast(t("toast.selectJob"));
    return;
  }
  if (!canFollowUp(job)) {
    showToast(t("toast.cannotFollowUp"));
    return;
  }

  const images = await collectImagePayloads("followUp");
  if (!prompt && images.length === 0) {
    showToast(t("toast.enterFollowUp"));
    return;
  }

  const mode = getModeFromSelect($("#followUpModeSelect"));
  const model = collectModelSelection("followUp");
  const agentOptions = collectAgentOptions("followUp");
  saveMode(mode);
  saveModelSelection(model);
  const saved = loadSavedAgentOptions();
  saveAgentOptions({
    ...saved,
    ...agentOptions,
    extraProjectIds: saved.extraProjectIds,
  });

  const { job: updated } = await api(`/api/jobs/${job.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      prompt,
      mode,
      model,
      delivery,
      images,
      loadLocalSettings: agentOptions.loadLocalSettings,
      sandbox: agentOptions.sandbox,
      autoReview: agentOptions.autoReview,
      disallowedTools: agentOptions.disallowedTools,
    }),
  });

  state.followUpDrafts.delete(job.id);
  state.currentJobId = updated.id;
  state.chatPinnedToBottom = true;
  revokeImagePreviews("followUp");
  renderImagePreviews("followUp");
  renderCurrentJob(updated);
  $("#followUpInput").value = "";
  await refreshData();
  startPollingCurrentJob();
}

async function refreshData() {
  const [projectsData, jobsData] = await Promise.all([api("/api/projects"), api("/api/jobs")]);
  state.projects = projectsData.projects;
  state.jobs = jobsData.jobs;
  renderProjectList();
  renderJobs();
  void loadModels();

  if (state.currentJobId) {
    await refreshCurrentJob();
  }
}

async function refreshCurrentJob() {
  if (!state.currentJobId) return;

  const { job } = await api(`/api/jobs/${state.currentJobId}`);
  upsertJob(job);
  renderJobs();
  renderCurrentJob(job);
  maybeNotifyJobStatus(job);

  if (conversationIsBusy(job)) {
    startPollingCurrentJob();
    return;
  }

  stopPollingCurrentJob();
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

function openNewTaskSheet() {
  ensureSelectedProject();
  updateNewTaskProjectLabel();
  setModeSelect($("#modeSelect"), loadSavedMode());
  applyModelSelection("submit", loadSavedModel());
  applyAgentOptions("submit", loadSavedAgentOptions());
  revokeImagePreviews("submit");
  renderImagePreviews("submit");
  openSheet("newTaskSheet");
  window.setTimeout(() => $("#promptInput")?.focus(), 120);
}

async function submitNewJob() {
  const button = $("#submitJobButton");
  if (button?.disabled) return;
  if (button) button.disabled = true;

  try {
    const prompt = $("#promptInput").value.trim();
    const projectId = state.selectedProjectId;
    if (!projectId) {
      showToast(t("toast.selectProject"));
      switchTab("projects");
      return;
    }

    const images = await collectImagePayloads("submit");
    if (!prompt && images.length === 0) {
      showToast(t("toast.enterPrompt"));
      return;
    }

    const mode = getModeFromSelect($("#modeSelect"));
    const model = collectModelSelection("submit");
    const agentOptions = collectAgentOptions("submit");
    saveMode(mode);
    saveModelSelection(model);
    saveAgentOptions(agentOptions);

    const { job } = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        prompt,
        mode,
        model,
        images,
        extraProjectIds: agentOptions.extraProjectIds,
        loadLocalSettings: agentOptions.loadLocalSettings,
        sandbox: agentOptions.sandbox,
        autoReview: agentOptions.autoReview,
        disallowedTools: agentOptions.disallowedTools,
      }),
    });
    state.currentJobId = job.id;
    state.chatPinnedToBottom = true;
    closeSheet("newTaskSheet");
    switchTab("session");
    renderCurrentJob(job);
    $("#promptInput").value = "";
    revokeImagePreviews("submit");
    renderImagePreviews("submit");
    await refreshData();
    startPollingCurrentJob();
  } catch (error) {
    showToast(error.message);
  } finally {
    if (button) button.disabled = false;
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
    applySessionAgentDefaults(session);
    setLoggedIn(true);
    await refreshData();
  } catch {
    setLoggedIn(false);
  }
}

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
  applySessionAgentDefaults(session);
  state.selectedProjectId = loadSavedProjectId();
  state.historyFilter = loadHistoryFilter();
  state.archivedJobIds = loadArchivedJobIds();
  state.notifyEnabled = loadNotifyEnabled();
  const notifyToggle = $("#notifyToggle");
  if (notifyToggle) notifyToggle.checked = state.notifyEnabled;
  const archivedToggle = $("#showArchivedToggle");
  if (archivedToggle) archivedToggle.checked = state.showArchived;
  updateWideLayout();
  switchTab(loadSavedTab());
  setupPullToRefresh();
  await ensureMarkdownLibs().catch(() => {});
  await refreshData();
  updateOnboardingVisibility();
}

window.__crcApp = {
  onBootAuthenticated,
  refreshData: () => refreshData(),
};

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

if (!$("#logoutButton")?.dataset.bootBound) {
  on("#logoutButton", "click", async () => {
    closeAllSheets();
    await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
    state.csrfToken = "";
    window.__crcSession = null;
    setLoggedIn(false);
  });
}

on("#stopJobButton", "click", () => {
  stopCurrentJob().catch((error) => showToast(error.message));
});

on("#projectSearchInput", "input", renderProjectList);

on("#projectList", "click", (event) => {
  const removeButton = event.target.closest(".project-remove-btn");
  if (removeButton) {
    event.stopPropagation();
    removeConfirmedProject(removeButton.dataset.projectId).catch((error) => showToast(error.message));
    return;
  }

  const useButton = event.target.closest(".project-use-btn");
  if (useButton) {
    event.stopPropagation();
    selectProjectById(useButton.dataset.projectId);
    return;
  }

  const item = event.target.closest(".project-item");
  if (!item) return;
  selectProjectById(item.dataset.projectId);
});

on("#browseOpenButton", "click", async () => {
  setBrowseOverlayOpen(true);
  await loadBrowse(null);
});

on("#browseCloseButton", "click", () => {
  setBrowseOverlayOpen(false);
});

on("#browseUpButton", "click", async () => {
  if (state.browse.parentPath) {
    await loadBrowse(state.browse.parentPath);
    return;
  }
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

on("#extraWorkspaceList", "click", (event) => {
  const chip = event.target.closest("[data-extra-project]");
  if (!chip) return;
  const projectId = chip.dataset.extraProject;
  const selected = new Set(state.extraProjectIds);
  if (selected.has(projectId)) selected.delete(projectId);
  else selected.add(projectId);
  state.extraProjectIds = [...selected];
  renderExtraWorkspaces();
});

on("#disallowedTools", "click", (event) => {
  const chip = event.target.closest("[data-tool]");
  if (!chip) return;
  chip.classList.toggle("active");
});

on("#followUpDisallowedTools", "click", (event) => {
  const chip = event.target.closest("[data-tool]");
  if (!chip) return;
  chip.classList.toggle("active");
});

on("#newTaskImageButton", "click", () => $("#newTaskImageInput")?.click());
on("#followUpImageButton", "click", () => $("#followUpImageInput")?.click());

on("#newTaskImageInput", "change", (event) => {
  addImageFiles("submit", event.currentTarget.files).catch((error) => showToast(error.message));
  event.currentTarget.value = "";
});

on("#followUpImageInput", "change", (event) => {
  addImageFiles("followUp", event.currentTarget.files).catch((error) => showToast(error.message));
  event.currentTarget.value = "";
});

on("#newTaskImagePreviews", "click", (event) => {
  const button = event.target.closest("[data-remove-image]");
  if (!button) return;
  const id = button.dataset.removeImage;
  const next = state.newTaskImages.filter((item) => item.id !== id);
  const removed = state.newTaskImages.find((item) => item.id === id);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  state.newTaskImages = next;
  renderImagePreviews("submit");
});

on("#followUpImagePreviews", "click", (event) => {
  const button = event.target.closest("[data-remove-image]");
  if (!button) return;
  const id = button.dataset.removeImage;
  const next = state.followUpImages.filter((item) => item.id !== id);
  const removed = state.followUpImages.find((item) => item.id === id);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  state.followUpImages = next;
  renderImagePreviews("followUp");
});

on("#submitJobButton", "click", () => {
  submitNewJob().catch((error) => showToast(error.message));
});

on("#headerNewTaskButton", "click", openNewTaskSheet);
on("#sessionNewTaskButton", "click", openNewTaskSheet);

on("#newTaskChangeProjectButton", "click", () => {
  closeSheet("newTaskSheet");
  switchTab("projects");
});

on("#settingsButton", "click", () => openSheet("settingsSheet"));

document.addEventListener("click", (event) => {
  const closeTarget = event.target.closest("[data-sheet-close]");
  if (closeTarget) {
    const sheetId = closeTarget.dataset.sheetClose;
    if (sheetId) closeSheet(sheetId);
  }
});

on("#bottomNav", "click", (event) => {
  const button = event.target.closest(".nav-item");
  if (!button) return;
  switchTab(button.dataset.tab);
});

on("#followUpForm", "submit", async (event) => {
  event.preventDefault();
  const prompt = $("#followUpInput")?.value.trim();
  if (!prompt && state.followUpImages.length === 0) {
    showToast(t("toast.enterFollowUp"));
    return;
  }

  const button = $("#followUpButton");
  const interruptButton = $("#followUpInterruptButton");
  if (button) button.disabled = true;
  if (interruptButton) interruptButton.disabled = true;
  try {
    await submitFollowUp(prompt, state.currentJobId, "queue");
  } catch (error) {
    showToast(error.message);
  } finally {
    updateFollowUpComposer(state.currentJob);
  }
});

on("#followUpInterruptButton", "click", async () => {
  const prompt = $("#followUpInput")?.value.trim();
  if (!prompt && state.followUpImages.length === 0) {
    showToast(t("toast.enterFollowUp"));
    return;
  }

  const button = $("#followUpButton");
  const interruptButton = $("#followUpInterruptButton");
  if (button) button.disabled = true;
  if (interruptButton) interruptButton.disabled = true;
  try {
    await submitFollowUp(prompt, state.currentJobId, "interrupt");
  } catch (error) {
    showToast(error.message);
  } finally {
    updateFollowUpComposer(state.currentJob);
  }
});

on("#currentJob", "toggle", (event) => {
  if (event.target.classList.contains("session-summary")) {
    saveSessionSummaryOpen(event.target.open);
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
  syncModeSegmentFromSelect();
});

on("#followUpModeSelect", "change", (event) => {
  saveMode(getModeFromSelect(event.currentTarget));
});

document.querySelector(".mode-segment")?.addEventListener("click", (event) => {
  const button = event.target.closest(".mode-segment-btn");
  if (!button) return;
  syncModeSelectFromSegment(button.dataset.mode === "plan" ? "plan" : "agent");
});

on("#jobList", "click", async (event) => {
  const archiveButton = event.target.closest(".job-archive-btn");
  if (archiveButton) {
    event.stopPropagation();
    toggleArchiveJob(archiveButton.dataset.jobId);
    return;
  }

  const item = event.target.closest(".job-item");
  if (!item) return;

  state.currentJobId = item.dataset.jobId;
  state.chatPinnedToBottom = true;
  switchTab("session");

  const chatOutput = $("#chatOutput");
  if (chatOutput) delete chatOutput.dataset.ready;
  await refreshCurrentJob();
  renderJobs();
});

on("#historyFilters", "click", (event) => {
  const chip = event.target.closest(".filter-chip");
  if (!chip) return;
  state.historyFilter = chip.dataset.filter || "all";
  saveHistoryFilter(state.historyFilter);
  renderJobs();
});

on("#historySearchInput", "input", (event) => {
  state.historySearch = event.currentTarget.value;
  renderJobs();
});

on("#showArchivedToggle", "change", (event) => {
  state.showArchived = Boolean(event.currentTarget.checked);
  renderJobs();
});

on("#dismissOnboardingButton", "click", () => {
  markOnboardingDone();
  updateOnboardingVisibility();
});

on("#notifyToggle", "change", async (event) => {
  const enabled = Boolean(event.currentTarget.checked);
  if (enabled) {
    const granted = await requestNotificationPermission();
    if (!granted) {
      event.currentTarget.checked = false;
      saveNotifyEnabled(false);
      showToast(t("notify.permissionDenied"));
      return;
    }
  }
  saveNotifyEnabled(enabled);
});

on("#chatOutput", "scroll", () => {
  const output = $("#chatOutput");
  if (!output) return;
  const nearBottom = isChatNearBottom(output);
  state.chatPinnedToBottom = nearBottom;
  $("#newMessagesFab")?.classList.toggle("hidden", nearBottom);
});

on("#newMessagesFab", "click", () => {
  const output = $("#chatOutput");
  if (!output) return;
  state.chatPinnedToBottom = true;
  output.scrollTop = output.scrollHeight;
  $("#newMessagesFab")?.classList.add("hidden");
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

const versionEl = document.querySelector("#appVersion");
const loginVersionEl = document.querySelector("#loginAppVersion");
if (versionEl) versionEl.textContent = `v${APP_VERSION}`;
if (loginVersionEl) loginVersionEl.textContent = `v${APP_VERSION}`;

stripCredentialsFromUrl();
applyDomI18n();
updateLangSwitch();
updateInstallButtonVisibility();
setModeSelect($("#modeSelect"), loadSavedMode());
bindModelSettings("submit");
bindModelSettings("followUp");
applyAgentOptions("submit", loadSavedAgentOptions());
applyAgentOptions("followUp", loadSavedAgentOptions());
applyModels(FALLBACK_MODELS, { id: "default" });
state.historyFilter = loadHistoryFilter();
state.archivedJobIds = loadArchivedJobIds();
state.notifyEnabled = loadNotifyEnabled();
updateFilterChips();
setupPullToRefresh();
bindComposerPanels();
window.addEventListener("resize", updateWideLayout);
ensureMarkdownLibs().catch((error) => {
  console.warn("Markdown 组件加载失败", error);
});

if (!window.__crcBootManaged) {
  bootstrap().catch((error) => {
    console.error("初始化失败", error);
    if (!window.__crcSession?.csrfToken) {
      setLoggedIn(false);
      showToast(error instanceof Error ? error.message : t("toast.requestFailed"));
    }
  });
}
