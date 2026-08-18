import { APP_VERSION } from "./version.js";
import {
  applyDomI18n,
  getLocale,
  initLocale,
  localeTag,
  setLocale,
  t,
  translateApiError,
} from "./i18n.js?v=0.4.9";

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
const SESSION_SUMMARY_KEY = "cursor-rc-session-summary-open";

const state = {
  csrfToken: "",
  jobs: [],
  projects: [],
  selectedProjectId: "",
  submitProjectId: "",
  currentJobId: "",
  currentJob: null,
  inChat: false,
  homeTab: "session",
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
  auth: {
    username: "",
    role: "viewer",
    permissions: [],
    allowedProjectIds: [],
  },
  users: [],
  permissionCatalog: [],
  roleDefaults: {},
  editingUserId: "",
  schedules: [],
  editingScheduleId: "",
  scheduleProjectId: "",
  scheduleExtraProjectIds: [],
};

initLocale();

function currentUsername() {
  return String(state.auth?.username || window.__crcSession?.username || "")
    .trim()
    .toLowerCase();
}

function prefKey(base) {
  const user = currentUsername();
  return user ? `${base}::${user}` : base;
}

function readPref(base) {
  try {
    const keyed = localStorage.getItem(prefKey(base));
    if (keyed != null) return keyed;
    return localStorage.getItem(base);
  } catch {
    return null;
  }
}

function writePref(base, value) {
  try {
    localStorage.setItem(prefKey(base), value);
  } catch {
    // localStorage 不可用时忽略
  }
}

function hasPerm(permission) {
  return Boolean(state.auth?.permissions?.includes(permission));
}

function isOwnJob(job) {
  return Boolean(job?.submittedBy && job.submittedBy === state.auth?.username);
}

function roleLabel(role) {
  return t(`users.role.${role || "viewer"}`);
}

function applyAuthFromSession(session) {
  state.auth = {
    username: session?.username || "",
    role: session?.role || "viewer",
    permissions: Array.isArray(session?.permissions) ? session.permissions : [],
    allowedProjectIds: Array.isArray(session?.allowedProjectIds) ? session.allowedProjectIds : [],
  };
  applyAuthUi();
}

function applyAuthUi() {
  const canCreate = hasPerm("jobs.create");
  const canBrowse = hasPerm("projects.browse");
  const canSelect = hasPerm("projects.select");
  const canManageUsers = hasPerm("users.manage");

  $("#headerNewTaskButton")?.classList.toggle("hidden", !canCreate);
  $("#sessionNewTaskButton")?.classList.toggle("hidden", !canCreate);
  $("#newScheduleButton")?.classList.toggle("hidden", !canCreate);
  $("#browseOpenButton")?.classList.toggle("hidden", !canBrowse);
  $("#browseSelectButton")?.classList.toggle("hidden", !canSelect);
  $("#usersManageButton")?.classList.toggle("hidden", !canManageUsers);

  const accountName = $("#settingsAccountName");
  const accountRole = $("#settingsAccountRole");
  if (accountName) accountName.textContent = state.auth.username || "—";
  if (accountRole) accountRole.textContent = roleLabel(state.auth.role);
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
  renderProjectList();
  renderJobs();
  renderSchedules();
  renderBrowsePanel();
  renderCurrentJob(state.currentJob);
  updateContextHeader();
  updateNewTaskProjectLabel();
  updateScheduleProjectLabel();
  renderScheduleProjectPicker();
  renderModelSettings("submit");
  renderModelSettings("followUp");
  renderModelSettings("schedule");
  updateComposerModelLabel("followUp");
  updateComposerModelLabel("submit");
  updateFollowUpSendState();
  updateNewTaskSendState();
  renderExtraWorkspaces();
  renderScheduleExtraWorkspaces();
  renderDisallowedTools("submit", collectDisallowedTools("submit"));
  applyAuthUi();
  renderUserList();
  renderUserEditForm();
  renderDisallowedTools("followUp", collectDisallowedTools("followUp"));
  renderDisallowedTools("schedule", collectDisallowedTools("schedule"));
  renderScheduleWeekdays(collectScheduleWeekdays());
  renderSchedulePromptChips();
  updateScheduleNextPreview();
  syncModeSegmentFromSelect();
  syncScheduleModeSegment();
  updateFilterChips();
  updateOnboardingVisibility();
}

function loadSavedMode() {
  try {
    const saved = readPref(MODE_STORAGE_KEY);
    if (saved === "agent" || saved === "plan") return saved;
  } catch {
    // localStorage 不可用时忽略
  }
  return "agent";
}

function saveMode(mode) {
  try {
    writePref(MODE_STORAGE_KEY, mode);
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
    const saved = JSON.parse(readPref(AGENT_OPTIONS_KEY) || "null");
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
    writePref(AGENT_OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // ignore
  }
}

function modelFieldIds(kind) {
  if (kind === "followUp") return { select: "#followUpModelSelect", params: "#followUpModelParams" };
  if (kind === "schedule") return { select: "#scheduleModelSelect", params: "#scheduleModelParams" };
  return { select: "#modelSelect", params: "#modelParams" };
}

function agentFieldIds(kind) {
  if (kind === "followUp") {
    return {
      load: "#followUpLoadLocalSettingsToggle",
      sandbox: "#followUpSandboxToggle",
      autoReview: "#followUpAutoReviewToggle",
    };
  }
  if (kind === "schedule") {
    return {
      load: "#scheduleLoadLocalSettingsToggle",
      sandbox: "#scheduleSandboxToggle",
      autoReview: "#scheduleAutoReviewToggle",
    };
  }
  return {
    load: "#loadLocalSettingsToggle",
    sandbox: "#sandboxToggle",
    autoReview: "#autoReviewToggle",
  };
}

function toolToggleSelector(kind) {
  if (kind === "followUp") return "#followUpDisallowedTools";
  if (kind === "schedule") return "#scheduleDisallowedTools";
  return "#disallowedTools";
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
  const primaryId = state.submitProjectId || state.selectedProjectId;
  const others = state.projects.filter((project) => project.id !== primaryId);
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
  const fields = agentFieldIds(kind);
  const loadToggle = $(fields.load);
  const sandboxToggle = $(fields.sandbox);
  const autoReviewToggle = $(fields.autoReview);
  const extraIds = kind === "schedule" ? state.scheduleExtraProjectIds : state.extraProjectIds;
  return {
    loadLocalSettings: Boolean(loadToggle?.checked),
    sandbox: Boolean(sandboxToggle?.checked),
    autoReview: Boolean(autoReviewToggle?.checked),
    disallowedTools: collectDisallowedTools(kind),
    extraProjectIds: kind === "followUp" ? [] : [...extraIds],
  };
}

function applyAgentOptions(kind, options) {
  const fields = agentFieldIds(kind);
  const loadToggle = $(fields.load);
  const sandboxToggle = $(fields.sandbox);
  const autoReviewToggle = $(fields.autoReview);
  if (loadToggle) loadToggle.checked = options.loadLocalSettings !== false;
  if (sandboxToggle) sandboxToggle.checked = Boolean(options.sandbox);
  if (autoReviewToggle) autoReviewToggle.checked = Boolean(options.autoReview);
  renderDisallowedTools(kind, options.disallowedTools || []);
  if (kind === "schedule") {
    const projectId = state.scheduleProjectId || state.selectedProjectId;
    state.scheduleExtraProjectIds = (options.extraProjectIds || []).filter((id) => id !== projectId);
    renderScheduleExtraWorkspaces();
    return;
  }
  if (kind !== "followUp") {
    state.extraProjectIds = (options.extraProjectIds || []).filter(
      (id) => id !== (state.submitProjectId || state.selectedProjectId),
    );
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
  if (kind === "followUp") updateFollowUpSendState();
  if (kind === "submit") updateNewTaskSendState();
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
    const saved = readPref(TAB_STORAGE_KEY);
    if (saved === "session" || saved === "history" || saved === "projects" || saved === "schedules") return saved;
  } catch {
    // localStorage 不可用时忽略
  }
  return "session";
}

function saveTab(tab) {
  try {
    writePref(TAB_STORAGE_KEY, tab);
  } catch {
    // localStorage 不可用时忽略
  }
}

function loadHistoryFilter() {
  try {
    const saved = readPref(HISTORY_FILTER_KEY);
    if (saved === "all" || saved === "active" || saved === "finished" || saved === "failed") return saved;
  } catch {
    // localStorage 不可用时忽略
  }
  return "all";
}

function saveHistoryFilter(filter) {
  try {
    writePref(HISTORY_FILTER_KEY, filter);
  } catch {
    // localStorage 不可用时忽略
  }
}

function loadArchivedJobIds() {
  try {
    const raw = readPref(ARCHIVED_JOBS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function saveArchivedJobIds() {
  try {
    writePref(ARCHIVED_JOBS_KEY, JSON.stringify([...state.archivedJobIds]));
  } catch {
    // localStorage 不可用时忽略
  }
}

function loadNotifyEnabled() {
  try {
    return readPref(NOTIFY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveNotifyEnabled(enabled) {
  state.notifyEnabled = Boolean(enabled);
  try {
    writePref(NOTIFY_STORAGE_KEY, state.notifyEnabled ? "1" : "0");
  } catch {
    // localStorage 不可用时忽略
  }
}

function isOnboardingDone() {
  try {
    return readPref(ONBOARDING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function markOnboardingDone() {
  try {
    writePref(ONBOARDING_STORAGE_KEY, "1");
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
    return readPref(PROJECT_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function saveSelectedProjectId(projectId) {
  state.selectedProjectId = projectId || "";
  try {
    if (projectId) writePref(PROJECT_STORAGE_KEY, projectId);
    else writePref(PROJECT_STORAGE_KEY, "");
  } catch {
    // localStorage 不可用时忽略
  }
}

function switchTab(tabId) {
  let tab = tabId === "history" || tabId === "projects" || tabId === "schedules" ? tabId : "session";
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
  renderSessionSwitcher();
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
  if (sheetId === "newTaskSheet") setNewTaskOptionsOpen(false);
}

function closeAllSheets() {
  closeSheet("newTaskSheet");
  closeSheet("settingsSheet");
  closeSheet("scheduleSheet");
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
  document.querySelectorAll("#newTaskSheet .mode-segment-btn").forEach((button) => {
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
    const saved = JSON.parse(readPref(MODEL_STORAGE_KEY) || "null");
    if (saved?.id) return { id: String(saved.id), params: Array.isArray(saved.params) ? saved.params : [] };
  } catch {
    // localStorage 不可用或数据损坏时忽略
  }
  return state.defaultModel || { id: "auto", params: [] };
}

function saveModelSelection(selection) {
  try {
    writePref(MODEL_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // localStorage 不可用时忽略
  }
}

function collectModelSelection(kind) {
  const fields = modelFieldIds(kind);
  const select = $(fields.select);
  const paramsRoot = $(fields.params);
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
  const fields = modelFieldIds(kind);
  const select = $(fields.select);
  const paramsRoot = $(fields.params);
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
  updateComposerModelLabel(kind);
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
  const paramsRoot = $(modelFieldIds(kind).params);
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
  const select = $(modelFieldIds(kind).select);
  if (!select) return;

  const previous = collectModelSelection(kind);
  select.innerHTML = state.models
    .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.displayName || model.id)}</option>`)
    .join("");
  applyModelSelection(kind, previous.id ? previous : loadSavedModel());
}

function modelDisplayLabel(model) {
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
  return extras.length ? `${name} ${extras.join(" ")}` : name;
}

function formatModelBadge(model) {
  const label = modelDisplayLabel(model);
  if (!label) return "";
  return `<span class="mode-badge model-badge">${escapeHtml(label)}</span>`;
}

function composerOptionIds(kind) {
  if (kind === "submit") {
    return { popover: "#newTaskOptions", trigger: "#newTaskModelTrigger", label: "#newTaskModelLabel" };
  }
  return { popover: "#followUpOptions", trigger: "#followUpModelTrigger", label: "#followUpModelLabel" };
}

function updateComposerModelLabel(kind) {
  if (kind !== "followUp" && kind !== "submit") return;
  const ids = composerOptionIds(kind);
  const label = $(ids.label);
  if (!label) return;
  const text = modelDisplayLabel(collectModelSelection(kind)) || t("submit.model");
  label.textContent = text;
  const trigger = $(ids.trigger);
  if (trigger) trigger.setAttribute("aria-label", `${t("submit.model")}: ${text}`);
}

function setComposerOptionsOpen(kind, open) {
  const ids = composerOptionIds(kind);
  const popover = $(ids.popover);
  const trigger = $(ids.trigger);
  if (!popover || !trigger) return;
  popover.classList.toggle("hidden", !open);
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
  if (kind === "followUp") updateComposerDock();
}

function setFollowUpOptionsOpen(open) {
  setComposerOptionsOpen("followUp", open);
}

function setNewTaskOptionsOpen(open) {
  setComposerOptionsOpen("submit", open);
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
    renderModelSettings("schedule");
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
  const fields = modelFieldIds(kind);
  const select = $(fields.select);
  const paramsRoot = $(fields.params);
  select?.addEventListener("change", () => {
    const model = findCatalogModel(select.value);
    const next = { id: select.value, params: defaultParamsForModel(model) };
    renderModelParams(kind, next);
    saveModelSelection(collectModelSelection(kind));
    updateComposerModelLabel(kind);
  });
  paramsRoot?.addEventListener("change", (event) => {
    const variant = event.target.closest("[data-model-variant]");
    if (variant) {
      let params = [];
      if (variant.value) {
        try {
          params = JSON.parse(variant.value);
        } catch {
          params = [];
        }
      }
      renderModelParams(kind, { id: select.value, params });
    }
    saveModelSelection(collectModelSelection(kind));
    updateComposerModelLabel(kind);
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

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // 部分 HTTP / WebView 环境没有剪贴板权限，改用选中复制。
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;";
  document.body.appendChild(textarea);

  const previous = document.activeElement;
  const selection = window.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  try {
    textarea.focus();
    textarea.select();
    try {
      textarea.setSelectionRange(0, textarea.value.length);
    } catch {
      // 部分环境只支持 select()
    }
    const copied = document.execCommand("copy");
    if (!copied) throw new Error(t("toast.copyFailed"));
  } finally {
    textarea.remove();
    if (previousRange && selection) {
      selection.removeAllRanges();
      try {
        selection.addRange(previousRange);
      } catch {
        // 原选区可能已失效，忽略。
      }
    }
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  }
}

function getSessionToken() {
  if (window.__crcSession?.sessionToken) return window.__crcSession.sessionToken;
  try {
    const lasting = localStorage.getItem("crc_session_token");
    if (lasting) return lasting;
  } catch {
    // ignore
  }
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
  if (!loggedIn) {
    stopJobEventStream();
    stopPollingCurrentJob();
    if (state.inChat) {
      state.inChat = false;
      state.currentJobId = "";
      state.currentJob = null;
      updateChatMode();
    }
  }
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
  if (state.projects.length === 1) {
    saveSelectedProjectId(state.projects[0].id);
    return;
  }
  if (state.selectedProjectId) saveSelectedProjectId("");
}

function selectedProject() {
  return findProject(state.submitProjectId) || findProject(state.selectedProjectId);
}

function selectedProjectName() {
  return findProject(state.selectedProjectId)?.name || t("project.noneSelected");
}

function setProjectPathLabel(elementId, projectPath) {
  const el = $(`#${elementId}`);
  if (!el) return;
  el.textContent = projectPath || "";
  el.classList.toggle("hidden", !projectPath);
}

function updateNewTaskProjectLabel() {
  const project = selectedProject();
  const projectName = project?.name || t("project.noneSelected");
  const label = $("#newTaskProjectName");
  if (label) label.textContent = projectName;
  const current = $("#projectCurrentName");
  if (current) current.textContent = findProject(state.selectedProjectId)?.name || t("project.noneSelected");
  setProjectPathLabel("newTaskProjectPath", project?.path);
  setProjectPathLabel("projectCurrentPath", findProject(state.selectedProjectId)?.path);
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
    if (hint) hint.textContent = hasPerm("projects.browse") ? t("submit.projectHint") : t("submit.projectHintAssigned");
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
            ${
              hasPerm("projects.select")
                ? `<button type="button" class="ghost small danger project-remove-btn" data-project-id="${escapeHtml(project.id)}">${escapeHtml(t("project.remove"))}</button>`
                : ""
            }
          </div>
        </article>
      `;
    })
    .join("");

  if (hint) hint.textContent = hasPerm("projects.browse") ? t("submit.projectHint") : t("submit.projectHintAssigned");
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
    renderProjectList();
    updateContextHeader();
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
        if (state.inChat && state.currentJob) renderCurrentJob(state.currentJob);
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

function isSubmitEnter(event) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

function autosizeTextarea(input, maxHeight = 120) {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
  if (input.id === "followUpInput") updateComposerDock();
}

function bindComposerPopover(kind) {
  const ids = composerOptionIds(kind);
  const trigger = $(ids.trigger);
  const popover = $(ids.popover);
  if (!trigger || !popover || trigger.dataset.bound === "1") return;
  trigger.dataset.bound = "1";
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    setComposerOptionsOpen(kind, popover.classList.contains("hidden"));
  });
}

function bindComposerPanels() {
  bindComposerPopover("followUp");
  bindComposerPopover("submit");

  if (document.documentElement.dataset.composerOutsideBound !== "1") {
    document.documentElement.dataset.composerOutsideBound = "1";
    document.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (!target.closest("#followUpOptions") && !target.closest("#followUpModelTrigger")) {
        setFollowUpOptionsOpen(false);
      }
      if (!target.closest("#newTaskOptions") && !target.closest("#newTaskModelTrigger")) {
        setNewTaskOptionsOpen(false);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      setFollowUpOptionsOpen(false);
      setNewTaskOptionsOpen(false);
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
      const popover = $("#followUpOptions");
      if (popover) observer.observe(popover);
    }
  }
}

function updateSessionJobLayout(hasJob) {
  $("#sessionPullZone")?.classList.toggle("is-active-job", Boolean(hasJob));
}

function loadSessionSummaryOpen() {
  try {
    return readPref(SESSION_SUMMARY_KEY) === "1";
  } catch {
    return false;
  }
}

function saveSessionSummaryOpen(open) {
  try {
    writePref(SESSION_SUMMARY_KEY, open ? "1" : "0");
  } catch {
    // localStorage 不可用时忽略
  }
}

function updateComposerDock() {
  const dock = $("#followUpDock");
  const appShell = $("#appView");
  if (!dock || !appShell) return;

  const show = state.inChat && Boolean(state.currentJob) && canFollowUp(state.currentJob);
  dock.classList.toggle("hidden", !show);
  appShell.classList.toggle("has-composer", show);

  if (show) {
    let height = dock.offsetHeight;
    const popover = $("#followUpOptions");
    if (popover && !popover.classList.contains("hidden")) {
      const gap = 8;
      height += popover.offsetHeight + gap;
    }
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
    !state.inChat &&
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
  bindPullToRefresh($("#schedulesPullZone"), $("#schedulesPullIndicator"), () => refreshData());
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

function rememberHomeTab() {
  if (state.inChat) return;
  let tab = state.activeTab;
  if (isWideLayout() && tab === "history") tab = "session";
  state.homeTab = tab === "history" || tab === "projects" || tab === "schedules" ? tab : "session";
}

function updateChatMode() {
  const app = $("#appView");
  if (!app) return;
  app.classList.toggle("in-chat", state.inChat);
  const back = $("#chatBackButton");
  back?.classList.toggle("hidden", !state.inChat);
  updateLayoutState();
  updateComposerDock();
  updateContextHeader();
  renderSessionSwitcher();
  updateOnboardingVisibility();
}

let suppressChatPopstate = false;
let suppressChatPopstateTimer = 0;

function ensureChatHistoryState() {
  try {
    if (history.state?.crcView !== "chat") {
      history.pushState({ crcView: "chat" }, "");
    }
  } catch {
    // history 不可用时仍进入会话页
  }
}

function enterChat() {
  if (!state.inChat) rememberHomeTab();
  state.inChat = true;
  switchTab("session");
  updateChatMode();
  ensureChatHistoryState();
}

function leaveChat({ fromPopstate = false } = {}) {
  if (!state.inChat) return;
  state.inChat = false;
  stopJobEventStream();
  rememberFollowUpDraft();
  state.currentJobId = "";
  closeAllSheets();
  $("#followUpInput")?.blur();
  renderCurrentJob(null);
  const homeTab = state.homeTab || "session";
  state.homeTab = "session";
  updateChatMode();
  switchTab(homeTab);
  if (!fromPopstate) {
    try {
      if (history.state?.crcView === "chat") {
        suppressChatPopstate = true;
        window.clearTimeout(suppressChatPopstateTimer);
        suppressChatPopstateTimer = window.setTimeout(() => {
          suppressChatPopstate = false;
        }, 1000);
        history.back();
      }
    } catch {
      suppressChatPopstate = false;
    }
  }
  if (shouldKeepPolling()) startPollingCurrentJob();
  else stopPollingCurrentJob();
}

function updateContextHeader(job = state.currentJob) {
  const eyebrow = $("#contextEyebrow");
  const title = $("#contextTitle");
  const status = $("#contextStatus");

  if (state.inChat) {
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
    return;
  }

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

  if (state.activeTab === "schedules") {
    eyebrow.textContent = t("nav.schedules");
    title.textContent = t("nav.schedules");
    status.classList.add("hidden");
    return;
  }

  eyebrow.textContent = t("nav.session");
  title.textContent = t("session.empty");
  status.classList.add("hidden");
}

function renderJobs() {
  const list = $("#jobList");
  rememberFollowUpDraft();
  updateFilterChips();

  const jobs = state.jobs.filter(jobMatchesFilter);
  if (state.jobs.length === 0) {
    list.innerHTML = `<p class="empty">${escapeHtml(t("history.empty"))}</p>`;
    renderSessionSwitcher();
    updateHistoryBadge();
    return;
  }

  if (jobs.length === 0) {
    list.innerHTML = `<p class="empty">${escapeHtml(t("history.noMatch"))}</p>`;
    renderSessionSwitcher();
    updateHistoryBadge();
    return;
  }

  list.innerHTML = jobs
    .map((job) => {
      const activeClass = job.id === state.currentJobId ? " active" : "";
      const archived = state.archivedJobIds.has(job.id);
      const archiveLabel = archived ? t("history.unarchive") : t("history.archive");
      const archivedBadge = archived ? `<span class="mode-badge">${escapeHtml(t("history.archived"))}</span>` : "";
      const scheduledBadge = job.scheduleId
        ? `<span class="mode-badge mode-scheduled">${escapeHtml(t("history.scheduled"))}</span>`
        : "";
      return `
        <article class="job-item${activeClass}" data-job-id="${job.id}">
          <div class="job-item-summary">
            <strong><span class="job-item-name">${escapeHtml(job.project.name)}</span>${archivedBadge}${scheduledBadge}<span class="status status-${job.status}">${statusText(job.status)}</span>${modeBadge(job.mode)}${formatModelBadge(job.model)}</strong>
            <div class="job-item-prompt">${escapeHtml(job.promptSummary)}</div>
            <div class="meta">${escapeHtml(formatDateTime(job.createdAt))}${
              hasPerm("jobs.viewAll") && job.submittedBy
                ? ` · ${escapeHtml(t("history.submittedBy", { name: job.submittedBy }))}`
                : ""
            }</div>
          </div>
          <div class="job-item-actions">
            <button type="button" class="ghost job-archive-btn" data-job-id="${escapeHtml(job.id)}">${escapeHtml(archiveLabel)}</button>
          </div>
        </article>
      `;
    })
    .join("");
  renderSessionSwitcher();
  updateHistoryBadge();
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

function listBusyJobs() {
  return state.jobs.filter((job) => conversationIsBusy(job) && !state.archivedJobIds.has(job.id));
}

function switcherLabel(job, busyJobs) {
  const name = job.project?.name || t("session.empty");
  const sameNameCount = busyJobs.filter((item) => item.project?.name === name).length;
  if (sameNameCount < 2) return name;
  const summary = String(job.promptSummary || "").trim();
  return summary ? `${name} · ${summary.slice(0, 16)}` : name;
}

function renderSessionSwitcher() {
  const root = $("#sessionSwitcher");
  if (!root) return;

  const busyJobs = listBusyJobs();
  const show = !state.inChat && state.activeTab === "session" && busyJobs.length > 1;
  root.hidden = !show;
  root.classList.toggle("hidden", !show);
  if (!show) {
    root.innerHTML = "";
    return;
  }

  root.innerHTML = `
    <span class="session-switcher-label">${escapeHtml(t("session.switcher"))}</span>
    <div class="session-switcher-list">
      ${busyJobs
        .map((job) => {
          const current = job.id === state.currentJobId ? " current" : "";
          return `
            <button type="button" class="session-switch-chip${current}" data-switch-job="${escapeHtml(job.id)}">
              <span class="status status-${escapeHtml(job.status)}">${escapeHtml(statusText(job.status))}</span>
              <span class="session-switch-chip-name">${escapeHtml(switcherLabel(job, busyJobs))}</span>
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function updateHistoryBadge() {
  const badge = $("#historyNavBadge");
  if (!badge) return;
  const count = listBusyJobs().length;
  badge.hidden = count < 1;
  badge.textContent = count > 9 ? "9+" : String(count);
}

async function openJob(jobId) {
  if (!jobId) return;

  rememberFollowUpDraft();
  const sameJob = jobId === state.currentJobId && Boolean(state.currentJob);
  state.currentJobId = jobId;
  state.chatPinnedToBottom = true;
  enterChat();
  if (sameJob) {
    renderCurrentJob(state.currentJob);
    startJobEventStream(jobId);
    startPollingCurrentJob();
    return;
  }

  const cached = findJob(jobId);
  if (cached) renderCurrentJob(cached);
  const chatOutput = $("#chatOutput");
  if (chatOutput) delete chatOutput.dataset.ready;
  startJobEventStream(jobId);
  if (!cached) await refreshCurrentJob();
  else startPollingCurrentJob();
}

function canFollowUp(job) {
  if (!job || !hasPerm("jobs.followUp")) return false;
  if (isOwnJob(job) || !job.submittedBy) return true;
  return hasPerm("jobs.operateOthers");
}

function canStopJob(job) {
  if (!conversationIsBusy(job) || !hasPerm("jobs.cancel")) return false;
  if (isOwnJob(job) || !job.submittedBy) return true;
  return hasPerm("jobs.operateOthers");
}

let followUpBoundJobId = "";

function findJob(jobId) {
  if (!jobId) return null;
  return state.jobs.find((job) => job.id === jobId) || (state.currentJob?.id === jobId ? state.currentJob : null);
}

function mergeListedJob(listed, previous) {
  if (!previous) return listed;
  if (Array.isArray(listed.logs) && listed.logs.length > 0) return listed;
  return {
    ...listed,
    logs: previous.logs,
    prompt: listed.prompt || previous.prompt,
    turns: listed.turns?.some((turn) => turn.prompt) ? listed.turns : previous.turns || listed.turns,
  };
}

function replaceJobList(list) {
  const previous = new Map(state.jobs.map((job) => [job.id, job]));
  state.jobs = (list || []).map((job) => mergeListedJob(job, previous.get(job.id)));
}

function upsertJob(job) {
  if (!job) return;
  const index = state.jobs.findIndex((item) => item.id === job.id);
  if (index >= 0) {
    state.jobs[index] = mergeListedJob(job, state.jobs[index]);
  } else {
    state.jobs.unshift(job);
  }
}

function updateFollowUpSendState(job) {
  const form = $("#followUpForm");
  const button = $("#followUpButton");
  const input = $("#followUpInput");
  if (!form || !button) return;

  const current = job || state.currentJob;
  const hasContent = Boolean(input?.value.trim() || state.followUpImages.length);
  const available = Boolean(current) && canFollowUp(current);
  const busy = Boolean(current) && conversationIsBusy(current);
  form.classList.toggle("has-content", hasContent);
  button.disabled = !available || !hasContent;
  const actionKey = busy ? "session.followUpQueue" : "session.followUpSend";
  button.setAttribute("aria-label", t(actionKey));
  button.setAttribute("title", t(actionKey));
}

function updateNewTaskSendState() {
  const composer = $(".new-task-composer");
  const button = $("#submitJobButton");
  const input = $("#promptInput");
  if (!button) return;
  const hasContent = Boolean(input?.value.trim() || state.newTaskImages.length);
  composer?.classList.toggle("has-content", hasContent);
  button.disabled = !hasContent;
  button.setAttribute("aria-label", t("task.start"));
  button.setAttribute("title", t("task.start"));
}

function updateFollowUpComposer(job) {
  const form = $("#followUpForm");
  const interruptButton = $("#followUpInterruptButton");
  const hint = $("#followUpHint");
  const input = $("#followUpInput");
  const modeSelect = $("#followUpModeSelect");

  if (!job) {
    form.classList.add("hidden");
    input.value = "";
    followUpBoundJobId = "";
    setFollowUpOptionsOpen(false);
    updateFollowUpSendState(null);
    updateComposerDock();
    return;
  }

  form.classList.remove("hidden");
  if (followUpBoundJobId !== job.id) {
    followUpBoundJobId = job.id;
    setFollowUpOptionsOpen(false);
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
    if (interruptButton) {
      interruptButton.disabled = true;
      interruptButton.classList.add("hidden");
    }
    input.disabled = true;
    hint.textContent = t("session.followUpHintNoAgent");
    hint.classList.remove("is-ready");
    updateFollowUpSendState(job);
    updateComposerDock();
    return;
  }

  const busy = conversationIsBusy(job);
  input.disabled = false;
  if (interruptButton) {
    interruptButton.classList.toggle("hidden", !busy);
    interruptButton.disabled = !busy;
    interruptButton.textContent = t("session.followUpInterrupt");
  }
  hint.textContent = busy ? t("session.followUpHintBusy") : t("session.followUpHintReady");
  hint.classList.toggle("is-ready", !busy);
  updateFollowUpSendState(job);
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

    // 排队中的轮次不要占「正在回复」，否则会挡住当前轮思考的增量更新。
    if (!sawAssistant && !sawThinking && !turn.result && turn.status === "running") {
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
  return output.scrollHeight - output.scrollTop - output.clientHeight < 120;
}

const COPY_ICON_SVG = `<svg class="chat-copy-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 18H8V7h11v16z"/></svg>`;
const COPY_CHECK_SVG = `<svg class="chat-copy-check hidden" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
const copyFeedbackTimers = new WeakMap();

function chatCopyButtonHtml() {
  const label = escapeHtml(t("session.copy"));
  return `
    <div class="chat-actions">
      <button type="button" class="chat-copy-btn" data-chat-copy aria-label="${label}" title="${label}">
        ${COPY_ICON_SVG}
        ${COPY_CHECK_SVG}
      </button>
    </div>
  `;
}

function messageCopyText(message) {
  const text = String(message?.text || "").replace(/^\uFEFF/, "").trim();
  if (text) return text;
  if ((message?.images || []).length > 0) return t("session.copyImage");
  return "";
}

function showCopyButtonFeedback(button) {
  if (!button.isConnected) return;
  const copyIcon = button.querySelector(".chat-copy-icon");
  const checkIcon = button.querySelector(".chat-copy-check");
  button.classList.add("is-copied");
  copyIcon?.classList.add("hidden");
  checkIcon?.classList.remove("hidden");
  button.setAttribute("aria-label", t("session.copied"));
  button.setAttribute("title", t("session.copied"));

  const previous = copyFeedbackTimers.get(button);
  if (previous) window.clearTimeout(previous);
  const timer = window.setTimeout(() => {
    if (!button.isConnected) {
      copyFeedbackTimers.delete(button);
      return;
    }
    button.classList.remove("is-copied");
    copyIcon?.classList.remove("hidden");
    checkIcon?.classList.add("hidden");
    button.setAttribute("aria-label", t("session.copy"));
    button.setAttribute("title", t("session.copy"));
    copyFeedbackTimers.delete(button);
  }, 1600);
  copyFeedbackTimers.set(button, timer);
}

function renderChatMessageHtml(message) {
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
  const canCopy = Boolean(message.text?.trim()) || Boolean(images);
  return `
    <div class="chat-row chat-${side}">
      <div class="chat-col">
        <div class="chat-bubble chat-bubble-${message.role}">
          <div class="chat-meta">
            <span>${escapeHtml(label)}</span>
            <time>${escapeHtml(time)}</time>
          </div>
          ${images ? `<div class="chat-images">${images}</div>` : ""}
          ${message.text?.trim() ? formatChatBody(message.role, message.text) : ""}
        </div>
        ${canCopy ? chatCopyButtonHtml() : ""}
      </div>
    </div>
  `;
}

let lastChatMessages = [];

function rememberChatRender(output, jobId, messages) {
  output.dataset.jobId = jobId;
  lastChatMessages = messages;
}

function resetChatRender(output) {
  delete output.dataset.jobId;
  lastChatMessages = [];
}

function chatMessageEquals(a, b) {
  if (a.role !== b.role || (a.level || "") !== (b.level || "")) return false;
  const aText = a.text || "";
  const bText = b.text || "";
  if (aText.length !== bText.length || aText !== bText) return false;
  const aImages = a.images || [];
  const bImages = b.images || [];
  if (aImages.length !== bImages.length) return false;
  for (let index = 0; index < aImages.length; index += 1) {
    if (aImages[index]?.id !== bImages[index]?.id) return false;
  }
  return true;
}

function chatMessageSameSlot(a, b) {
  return a.role === b.role && (a.level || "") === (b.level || "");
}

function chatElementMatchesRole(el, message) {
  if (!el) return false;
  if (message.role === "system") return el.classList.contains("chat-system");
  if (message.role === "thinking") return Boolean(el.querySelector(":scope > .chat-thinking"));
  if (message.role === "tool") return Boolean(el.querySelector(":scope > .chat-tool"));
  if (message.role === "user") return el.classList.contains("chat-right");
  if (message.role === "assistant") {
    return el.classList.contains("chat-left") && Boolean(el.querySelector(".chat-bubble-assistant"));
  }
  return false;
}

function findChatUpdate(prev, next) {
  if (!prev.length) return { type: "replace", index: 0 };
  const minLen = Math.min(prev.length, next.length);
  let index = 0;
  while (index < minLen && chatMessageEquals(prev[index], next[index])) index += 1;

  if (index === prev.length && index === next.length) return { type: "none" };

  if (next.length === prev.length + 1 && index === prev.length) {
    return { type: "append" };
  }

  if (prev.length === next.length && index < next.length && chatMessageSameSlot(prev[index], next[index])) {
    let rest = index + 1;
    while (rest < next.length && chatMessageEquals(prev[rest], next[rest])) rest += 1;
    if (rest === next.length) return { type: "patch", index };
  }

  return { type: "splice", index };
}

function spliceChatMessages(output, messages, index) {
  clearPendingMarkdown();
  while (output.children.length > index) {
    output.lastElementChild.remove();
  }
  if (index <= 0) {
    output.innerHTML = messages.map((item) => renderChatMessageHtml(item)).join("");
    return;
  }
  const html = messages.slice(index).map((item) => renderChatMessageHtml(item)).join("");
  if (html) output.insertAdjacentHTML("beforeend", html);
}

function finishChatScroll(output, wasNearBottom) {
  const fab = $("#newMessagesFab");
  if (wasNearBottom || state.chatPinnedToBottom) {
    output.scrollTop = output.scrollHeight;
    state.chatPinnedToBottom = true;
    fab?.classList.add("hidden");
  } else {
    fab?.classList.remove("hidden");
  }
}

let pendingMarkdown = null;
let markdownFlushTimer = null;
let lastMarkdownAt = 0;

function clearPendingMarkdown() {
  if (markdownFlushTimer) {
    window.clearTimeout(markdownFlushTimer);
    markdownFlushTimer = null;
  }
  pendingMarkdown = null;
}

function flushPendingMarkdown() {
  markdownFlushTimer = null;
  lastMarkdownAt = Date.now();
  if (!pendingMarkdown) return;
  const { body, text } = pendingMarkdown;
  pendingMarkdown = null;
  if (body.isConnected) body.innerHTML = renderMarkdown(text);
}

function setMarkdownBody(body, text) {
  pendingMarkdown = { body, text };
  const waited = Date.now() - lastMarkdownAt;
  if (waited >= 80) {
    flushPendingMarkdown();
    return;
  }
  if (!markdownFlushTimer) {
    markdownFlushTimer = window.setTimeout(flushPendingMarkdown, 80 - waited);
  }
}

function updateChatElement(el, message) {
  const time = formatTime(message.time);
  el.querySelectorAll("time").forEach((node) => {
    node.textContent = time;
  });

  if (message.role === "system") {
    const span = el.querySelector("span");
    if (span) span.textContent = message.text;
    el.className = `chat-system chat-system-${message.level || "info"}`;
    return;
  }

  if (message.role === "tool") {
    const [title, ...rest] = String(message.text || "").split("\n");
    const summarySpan = el.querySelector("summary span");
    if (summarySpan) summarySpan.textContent = title || t("session.tool");
    const details = el.querySelector("details");
    let body = el.querySelector(".chat-text");
    if (rest.length) {
      if (body) body.textContent = rest.join("\n");
      else details?.insertAdjacentHTML("beforeend", `<div class="chat-text">${escapeHtml(rest.join("\n"))}</div>`);
    } else {
      body?.remove();
    }
    return;
  }

  const body = el.querySelector(".chat-markdown") || el.querySelector(".chat-text");
  if (!body) return;
  if (message.role === "assistant" || message.role === "thinking") {
    setMarkdownBody(body, message.text);
    return;
  }
  body.textContent = message.text;
}

function renderChatMessages(job) {
  const output = $("#chatOutput");
  if (!job) {
    clearPendingMarkdown();
    output.innerHTML = "";
    resetChatRender(output);
    return;
  }

  const messages = buildChatMessages(job);
  if (messages.length === 0) {
    clearPendingMarkdown();
    output.innerHTML = `<p class="empty">${escapeHtml(t("session.noChat"))}</p>`;
    resetChatRender(output);
    return;
  }

  const wasNearBottom = isChatNearBottom(output);
  const prevJobId = output.dataset.jobId;
  const last = messages.at(-1);
  const canReuseDom =
    prevJobId === job.id &&
    output.children.length === lastChatMessages.length &&
    lastChatMessages.length > 0 &&
    !output.querySelector(":scope > .empty");

  if (canReuseDom) {
    const update = findChatUpdate(lastChatMessages, messages);
    if (update.type === "none") {
      finishChatScroll(output, wasNearBottom);
      return;
    }
    if (update.type === "patch") {
      const target = output.children[update.index];
      if (target && chatElementMatchesRole(target, messages[update.index])) {
        updateChatElement(target, messages[update.index]);
      } else {
        spliceChatMessages(output, messages, update.index);
      }
    } else if (update.type === "append") {
      output.insertAdjacentHTML("beforeend", renderChatMessageHtml(last));
    } else {
      spliceChatMessages(output, messages, update.index);
    }
    rememberChatRender(output, job.id, messages);
    finishChatScroll(output, wasNearBottom);
    return;
  }

  clearPendingMarkdown();
  output.innerHTML = messages.map((message) => renderChatMessageHtml(message)).join("");
  rememberChatRender(output, job.id, messages);
  finishChatScroll(output, wasNearBottom);
}

function renderCurrentJob(job, options = {}) {
  if (job && !state.inChat) return;
  state.currentJob = job || null;
  const empty = $("#sessionEmpty");
  const summary = $("#currentJob");
  const chat = $("#chatOutput");

  if (!job) {
    empty?.classList.remove("hidden");
    summary?.classList.add("hidden");
    chat?.classList.add("hidden");
    summary.innerHTML = "";
    delete summary.dataset.liveId;
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

  if (options.live && summary.dataset.liveId === job.id) {
    const statusEl = summary.querySelector(".status");
    if (statusEl) {
      statusEl.className = `status status-${job.status}`;
      statusEl.textContent = statusText(job.status);
    }
    const usageLabel = formatUsage(job.usage);
    const usageEl = summary.querySelector(".usage-meta");
    if (usageLabel) {
      if (usageEl) usageEl.textContent = usageLabel;
      else summary.querySelector(".session-summary-body")?.insertAdjacentHTML("beforeend", `<p class="usage-meta">${escapeHtml(usageLabel)}</p>`);
    }
    renderChatMessages(job);
    updateFollowUpComposer(job);
    updateStopButton(job);
    updateContextHeader(job);
    return;
  }

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
  summary.dataset.liveId = job.id;
  renderChatMessages(job);
  updateFollowUpComposer(job);
  updateStopButton(job);
  updateContextHeader(job);
  updateOnboardingVisibility();
}

let currentJobPollInFlight = false;
let jobListPollAt = 0;
let jobsRenderTimer = null;
let jobStreamAbort = null;
let jobStreamJobId = "";
let jobStreamActive = false;
let jobStreamReconnectTimer = null;
let jobStreamGeneration = 0;
let jobStreamAttempt = 0;

function stopPollingCurrentJob() {
  if (!state.pollingTimer) return;
  window.clearInterval(state.pollingTimer);
  state.pollingTimer = null;
}

function shouldKeepPolling() {
  return listBusyJobs().length > 0;
}

function scheduleRenderJobs(immediate = false) {
  if (immediate) {
    if (jobsRenderTimer) {
      window.clearTimeout(jobsRenderTimer);
      jobsRenderTimer = null;
    }
    renderJobs();
    return;
  }
  if (jobsRenderTimer) return;
  jobsRenderTimer = window.setTimeout(() => {
    jobsRenderTimer = null;
    renderJobs();
  }, 250);
}

function applyLiveJob(job, options = {}) {
  if (!job) return;
  const previous = findJob(job.id);
  const statusChanged = previous && previous.status !== job.status;
  upsertJob(job);
  if (state.inChat && state.currentJobId === job.id) {
    renderCurrentJob(job, { live: Boolean(options.live) && !options.replace });
  }
  scheduleRenderJobs(Boolean(statusChanged || options.replace));
  maybeNotifyJobStatus(job);
}

function applyLiveJobPatch(patch) {
  const prev = findJob(state.currentJobId) || state.currentJob;
  if (!prev || !patch) {
    void refreshCurrentJob();
    return;
  }
  const prevLogs = prev.logs || [];
  if (patch.logStart > prevLogs.length) {
    void refreshCurrentJob();
    return;
  }
  applyLiveJob(
    {
      ...prev,
      updatedAt: patch.updatedAt,
      status: patch.status,
      startedAt: patch.startedAt ?? prev.startedAt,
      finishedAt: patch.finishedAt,
      error: patch.error,
      result: patch.result,
      usage: patch.usage ?? prev.usage,
      activeTurnId: patch.activeTurnId,
      runId: patch.runId ?? prev.runId,
      agentId: patch.agentId ?? prev.agentId,
      mode: patch.mode ?? prev.mode,
      model: patch.model ?? prev.model,
      turns: patch.turns ?? prev.turns,
      logs: prevLogs.slice(0, patch.logStart).concat(patch.logs || []),
    },
    { live: true },
  );
}

async function consumeSseStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines = [];

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }
    const raw = dataLines.join("\n");
    dataLines = [];
    const name = eventName;
    eventName = "message";
    if (!raw) return;
    try {
      onEvent(name, JSON.parse(raw));
    } catch {
      // 忽略心跳或不完整分片
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        dispatch();
      } else if (!line.startsWith(":")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      newline = buffer.indexOf("\n");
    }
  }
}

function stopJobEventStream() {
  jobStreamGeneration += 1;
  jobStreamActive = false;
  jobStreamJobId = "";
  jobStreamAttempt = 0;
  if (jobStreamReconnectTimer) {
    window.clearTimeout(jobStreamReconnectTimer);
    jobStreamReconnectTimer = null;
  }
  jobStreamAbort?.abort();
  jobStreamAbort = null;
}

function scheduleJobStreamReconnect(jobId, generation) {
  if (generation !== jobStreamGeneration) return;
  if (!state.inChat || state.currentJobId !== jobId) return;
  const delay = Math.min(8000, 400 * 2 ** jobStreamAttempt);
  jobStreamAttempt += 1;
  jobStreamReconnectTimer = window.setTimeout(() => {
    jobStreamReconnectTimer = null;
    if (generation !== jobStreamGeneration) return;
    if (!state.inChat || state.currentJobId !== jobId) return;
    void connectJobEventStream(jobId);
  }, delay);
  startPollingCurrentJob();
}

async function connectJobEventStream(jobId) {
  const generation = jobStreamGeneration;
  const controller = new AbortController();
  jobStreamAbort = controller;
  try {
    const sessionToken = getSessionToken();
    const response = await fetch(`/api/jobs/${jobId}/events`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "text/event-stream",
        ...(state.csrfToken ? { "x-csrf-token": state.csrfToken } : {}),
        ...(sessionToken
          ? {
              Authorization: `Bearer ${sessionToken}`,
              "x-crc-session": sessionToken,
            }
          : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        jobStreamActive = false;
        jobStreamAbort = null;
        startPollingCurrentJob();
        return;
      }
      throw new Error("stream failed");
    }
    jobStreamActive = true;
    jobStreamAttempt = 0;
    await consumeSseStream(response.body, (event, data) => {
      if (generation !== jobStreamGeneration) return;
      if (event === "snapshot" && data.job) applyLiveJob(data.job, { replace: true });
      if (event === "update" && data.patch) applyLiveJobPatch(data.patch);
    });
    throw new Error("stream closed");
  } catch (error) {
    if (controller.signal.aborted || generation !== jobStreamGeneration) return;
    jobStreamActive = false;
    jobStreamAbort = null;
    scheduleJobStreamReconnect(jobId, generation);
  }
}

function startJobEventStream(jobId) {
  if (!jobId) return;
  if (jobStreamJobId === jobId && (jobStreamActive || jobStreamAbort)) return;
  stopJobEventStream();
  jobStreamJobId = jobId;
  void connectJobEventStream(jobId);
}

function startLiveUpdates(jobId = state.currentJobId) {
  if (jobId && state.inChat) startJobEventStream(jobId);
  startPollingCurrentJob();
}

async function refreshJobList() {
  const jobsData = await api("/api/jobs");
  replaceJobList(jobsData.jobs);
  if (state.inChat && state.currentJob && state.currentJobId) {
    upsertJob(state.currentJob);
  }
  renderJobs();
}

function startPollingCurrentJob() {
  if (state.pollingTimer) return;
  state.pollingTimer = window.setInterval(() => {
    if (currentJobPollInFlight) return;
    currentJobPollInFlight = true;
    const now = Date.now();
    const tasks = [];
    if (state.currentJobId && state.inChat && !jobStreamActive) {
      tasks.push(refreshCurrentJob({ fromPoll: true }));
    }
    if (now - jobListPollAt >= 5000 && shouldKeepPolling()) {
      jobListPollAt = now;
      tasks.push(refreshJobList());
    }
    if (tasks.length === 0) {
      currentJobPollInFlight = false;
      if (!shouldKeepPolling() && (jobStreamActive || !state.inChat)) stopPollingCurrentJob();
      return;
    }
    Promise.all(tasks)
      .catch((error) => showToast(error.message))
      .finally(() => {
        currentJobPollInFlight = false;
        if (!shouldKeepPolling() && (jobStreamActive || !state.inChat)) stopPollingCurrentJob();
      });
  }, 2000);
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
  upsertJob(updated);
  if (!state.inChat) {
    renderJobs();
    if (shouldKeepPolling()) startPollingCurrentJob();
    return;
  }

  state.currentJobId = updated.id;
  state.chatPinnedToBottom = true;
  revokeImagePreviews("followUp");
  renderImagePreviews("followUp");
  renderCurrentJob(updated);
  $("#followUpInput").value = "";
  await refreshData();
  startLiveUpdates(updated.id);
}

async function refreshData() {
  const [projectsData, jobsData, schedulesData] = await Promise.all([
    api("/api/projects"),
    api("/api/jobs"),
    api("/api/schedules"),
  ]);
  state.projects = projectsData.projects;
  replaceJobList(jobsData.jobs);
  state.schedules = schedulesData.schedules || [];
  renderProjectList();
  renderJobs();
  renderSchedules();
  void loadModels();

  if (state.currentJobId) {
    await refreshCurrentJob();
  } else if (shouldKeepPolling()) {
    startPollingCurrentJob();
  }
}

async function refreshCurrentJob({ fromPoll = false } = {}) {
  if (!state.currentJobId || !state.inChat) return;

  const jobId = state.currentJobId;
  const { job } = await api(`/api/jobs/${jobId}`);
  if (state.currentJobId !== jobId || !state.inChat) return;
  upsertJob(job);
  renderJobs();
  renderCurrentJob(job, { live: fromPoll });
  maybeNotifyJobStatus(job);

  if (fromPoll) {
    if (!shouldKeepPolling() && !jobStreamActive) stopPollingCurrentJob();
    return;
  }

  startLiveUpdates(jobId);
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
    upsertJob(updatedJob);
    if (state.inChat && (!state.currentJobId || state.currentJobId === updatedJob.id || state.currentJobId === job.id)) {
      state.currentJobId = updatedJob.id;
      renderCurrentJob(updatedJob);
    } else {
      renderJobs();
    }
    await refreshData();
    showToast(t("toast.stopRequested"));
  } catch (error) {
    showToast(error.message);
  } finally {
    state.stoppingJobIds.delete(job.id);
    updateStopButton(state.currentJob);
  }
}

function effectivePermissions(role, grants = [], denies = []) {
  const defaults = new Set(state.roleDefaults[role] || []);
  for (const grant of grants) defaults.add(grant);
  for (const deny of denies) defaults.delete(deny);
  if (defaults.has("jobs.operateOthers")) defaults.add("jobs.viewAll");
  return state.permissionCatalog.filter((item) => defaults.has(item));
}

function computeOverrides(role, checked) {
  const defaults = new Set(state.roleDefaults[role] || []);
  const grants = [];
  const denies = [];
  for (const permission of state.permissionCatalog) {
    const on = checked.has(permission);
    if (on && !defaults.has(permission)) grants.push(permission);
    if (!on && defaults.has(permission)) denies.push(permission);
  }
  return { grants, denies };
}

function renderUserList() {
  const list = $("#userList");
  if (!list) return;
  if (!state.users.length) {
    list.innerHTML = `<p class="empty">${escapeHtml(t("users.empty"))}</p>`;
    return;
  }

  list.innerHTML = state.users
    .map((user) => {
      const active = user.id === state.editingUserId ? " active" : "";
      const disabled = user.disabled ? ` · ${escapeHtml(t("users.disabled"))}` : "";
      return `
        <button type="button" class="user-item${active}" data-user-id="${escapeHtml(user.id)}">
          <strong>${escapeHtml(user.username)}</strong>
          <span class="meta">${escapeHtml(roleLabel(user.role))}${disabled}</span>
        </button>
      `;
    })
    .join("");
}

function selectedUserPermissions() {
  const checked = new Set(
    [...document.querySelectorAll("#userPermissionList input[type=checkbox]:checked")].map((item) => item.value),
  );
  return checked;
}

function renderUserPermissionList(checked) {
  const root = $("#userPermissionList");
  if (!root) return;
  root.innerHTML = state.permissionCatalog
    .map((permission) => {
      const on = checked.has(permission) ? " checked" : "";
      return `
        <label class="inline-toggle">
          <input type="checkbox" value="${escapeHtml(permission)}"${on} />
          <span>${escapeHtml(t(`users.perm.${permission}`))}</span>
        </label>
      `;
    })
    .join("");
}

function renderUserProjectList(allowedIds) {
  const root = $("#userProjectList");
  if (!root) return;
  if (!state.projects.length) {
    root.innerHTML = `<p class="hint">${escapeHtml(t("users.noProjects"))}</p>`;
    return;
  }
  const allowed = new Set(allowedIds || []);
  root.innerHTML = state.projects
    .map((project) => {
      const on = allowed.has(project.id) ? " checked" : "";
      return `
        <label class="inline-toggle">
          <input type="checkbox" value="${escapeHtml(project.id)}"${on} />
          <span>${escapeHtml(project.name)}</span>
        </label>
      `;
    })
    .join("");
}

function resetUserEditForm() {
  state.editingUserId = "";
  const form = $("#userEditForm");
  if (!form) return;
  form.reset();
  form.userId.value = "";
  form.username.disabled = false;
  $("#userEditTitle").textContent = t("users.create");
  $("#userPasswordField")?.classList.remove("hidden");
  $("#userDisabledField")?.classList.add("hidden");
  $("#userResetPasswordButton")?.classList.add("hidden");
  renderUserPermissionList(new Set(effectivePermissions(form.role.value)));
  renderUserProjectList([]);
  renderUserList();
}

function fillUserEditForm(user) {
  const form = $("#userEditForm");
  if (!form || !user) return;
  state.editingUserId = user.id;
  form.userId.value = user.id;
  form.username.value = user.username;
  form.username.disabled = true;
  form.role.value = user.role;
  form.password.value = "";
  form.disabled.checked = Boolean(user.disabled);
  $("#userEditTitle").textContent = t("users.edit");
  $("#userPasswordField")?.classList.add("hidden");
  $("#userDisabledField")?.classList.remove("hidden");
  $("#userResetPasswordButton")?.classList.remove("hidden");
  renderUserPermissionList(new Set(user.permissions || effectivePermissions(user.role, user.grants, user.denies)));
  renderUserProjectList(user.allowedProjectIds || []);
  renderUserList();
}

function renderUserEditForm() {
  const form = $("#userEditForm");
  if (!form) return;
  if (state.editingUserId) {
    const user = state.users.find((item) => item.id === state.editingUserId);
    if (user) {
      fillUserEditForm(user);
      return;
    }
  }
  resetUserEditForm();
}

async function loadUserAdminData() {
  const [catalog, users] = await Promise.all([api("/api/permissions"), api("/api/users")]);
  state.permissionCatalog = catalog.permissions || [];
  state.roleDefaults = catalog.roleDefaults || {};
  state.users = users.users || [];
  renderUserList();
  renderUserEditForm();
}

async function openUsersSheet() {
  if (!hasPerm("users.manage")) return;
  closeSheet("settingsSheet");
  openSheet("usersSheet");
  try {
    await loadUserAdminData();
  } catch (error) {
    showToast(error.message);
  }
}

function sameUsername(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function canManageSchedule(schedule) {
  if (!hasPerm("jobs.create")) return false;
  if (sameUsername(schedule.ownerUsername, state.auth.username)) return true;
  return hasPerm("jobs.operateOthers");
}

function currentScheduleKind() {
  return $("#scheduleKindSegment .mode-segment-btn.active")?.dataset.kind === "cron" ? "cron" : "simple";
}

function setScheduleKind(kind) {
  const next = kind === "cron" ? "cron" : "simple";
  document.querySelectorAll("#scheduleKindSegment .mode-segment-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.kind === next);
  });
  $("#scheduleSimpleFields")?.classList.toggle("hidden", next === "cron");
  $("#scheduleCronField")?.classList.toggle("hidden", next !== "cron");
  updateScheduleFrequencyFields();
  updateScheduleNextPreview();
}

function updateScheduleFrequencyFields() {
  const frequency = $("#scheduleFrequencySelect")?.value || "daily";
  const isInterval = frequency === "interval";
  const isWeekly = frequency === "weekly";
  const isMonthly = frequency === "monthly";
  $("#scheduleTimeField")?.classList.toggle("hidden", isInterval);
  $("#scheduleWeekdaysField")?.classList.toggle("hidden", !isWeekly);
  $("#scheduleMonthDayField")?.classList.toggle("hidden", !isMonthly);
  $("#scheduleIntervalField")?.classList.toggle("hidden", !isInterval);
}

function renderScheduleWeekdays(selected = []) {
  const root = $("#scheduleWeekdays");
  if (!root) return;
  const chosen = new Set(selected);
  root.innerHTML = [0, 1, 2, 3, 4, 5, 6]
    .map((day) => {
      const active = chosen.has(day) ? " active" : "";
      return `<button type="button" class="option-chip${active}" data-weekday="${day}">${escapeHtml(t(`schedule.weekday.${day}`))}</button>`;
    })
    .join("");
}

function collectScheduleWeekdays() {
  return [...document.querySelectorAll("#scheduleWeekdays .option-chip.active")].map((button) => Number(button.dataset.weekday));
}

function renderSchedulePromptChips() {
  const root = $("#schedulePromptChips");
  if (!root) return;
  root.innerHTML = [
    ["deps", "schedule.templateDeps"],
    ["errors", "schedule.templateErrors"],
  ]
    .map(
      ([id, key]) =>
        `<button type="button" class="option-chip" data-prompt-template="${id}">${escapeHtml(t(key))}</button>`,
    )
    .join("");
}

function renderScheduleExtraWorkspaces() {
  const root = $("#scheduleExtraWorkspaceList");
  if (!root) return;
  const projectId = state.scheduleProjectId || state.selectedProjectId;
  const others = state.projects.filter((project) => project.id !== projectId);
  if (others.length === 0) {
    root.innerHTML = `<p class="hint">${escapeHtml(t("submit.extraWorkspacesEmpty"))}</p>`;
    return;
  }
  const selected = new Set(state.scheduleExtraProjectIds);
  root.innerHTML = `<span class="sheet-label">${escapeHtml(t("submit.extraWorkspaces"))}</span>${others
    .map((project) => {
      const active = selected.has(project.id) ? " active" : "";
      return `<button type="button" class="option-chip${active}" data-extra-project="${escapeHtml(project.id)}">${escapeHtml(project.name)}</button>`;
    })
    .join("")}`;
}

function updateScheduleProjectLabel() {
  const label = $("#scheduleProjectName");
  if (!label) return;
  const project = state.projects.find((item) => item.id === state.scheduleProjectId);
  label.textContent = project?.name || t("project.noneSelected");
}

function renderScheduleProjectPicker() {
  const root = $("#scheduleProjectPicker");
  if (!root) return;
  if (!state.projects.length) {
    root.innerHTML = `<p class="hint">${escapeHtml(t("submit.projectHintAssigned"))}</p>`;
    return;
  }
  root.innerHTML = state.projects
    .map((project) => {
      const active = project.id === state.scheduleProjectId ? " active" : "";
      return `<button type="button" class="option-chip${active}" data-schedule-project="${escapeHtml(project.id)}">${escapeHtml(project.name)}</button>`;
    })
    .join("");
}

function setScheduleProject(projectId) {
  if (!projectId || projectId === state.scheduleProjectId) {
    updateScheduleProjectLabel();
    renderScheduleProjectPicker();
    return;
  }
  state.scheduleProjectId = projectId;
  state.scheduleExtraProjectIds = state.scheduleExtraProjectIds.filter((id) => id !== projectId);
  updateScheduleProjectLabel();
  renderScheduleExtraWorkspaces();
  renderScheduleProjectPicker();
}

function syncScheduleModeSegment() {
  const mode = getModeFromSelect($("#scheduleModeSelect"));
  document.querySelectorAll("#scheduleModeSegment .mode-segment-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
}

function estimateScheduleNextRun() {
  if (currentScheduleKind() === "cron") return "";
  const frequency = $("#scheduleFrequencySelect")?.value || "daily";
  const now = new Date();
  if (frequency === "interval") {
    const hours = Number($("#scheduleIntervalInput")?.value || 6);
    if (!Number.isInteger(hours) || hours < 1) return "";
    return t("schedule.next", { time: formatDateTime(new Date(now.getTime() + hours * 3600000).toISOString()) });
  }

  const time = ($("#scheduleTimeInput")?.value || "03:00").slice(0, 5);
  const [hour, minute] = time.split(":").map((part) => Number(part));
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return "";

  if (frequency === "weekly") {
    const days = collectScheduleWeekdays();
    if (!days.length) return "";
    for (let offset = 0; offset < 8; offset += 1) {
      const candidate = new Date(now);
      candidate.setHours(hour, minute, 0, 0);
      candidate.setDate(now.getDate() + offset);
      if (candidate.getTime() <= now.getTime()) continue;
      if (days.includes(candidate.getDay())) {
        return t("schedule.next", { time: formatDateTime(candidate.toISOString()) });
      }
    }
    return "";
  }

  if (frequency === "monthly") {
    const monthDay = Number($("#scheduleMonthDayInput")?.value);
    if (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) return "";
    for (let offset = 0; offset < 12; offset += 1) {
      const candidate = new Date(now.getFullYear(), now.getMonth() + offset, monthDay, hour, minute, 0, 0);
      if (candidate.getDate() !== monthDay) continue;
      if (candidate.getTime() <= now.getTime()) continue;
      return t("schedule.next", { time: formatDateTime(candidate.toISOString()) });
    }
    return "";
  }

  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return t("schedule.next", { time: formatDateTime(next.toISOString()) });
}

function updateScheduleNextPreview() {
  const preview = $("#scheduleNextPreview");
  if (!preview) return;
  preview.textContent = estimateScheduleNextRun();
}

function describeSchedule(schedule) {
  if (schedule.kind === "cron") return schedule.cronExpr || "cron";
  const simple = schedule.simple || {};
  if (simple.frequency === "interval") return t("schedule.interval") + ` · ${simple.intervalHours}h`;
  if (simple.frequency === "weekly") {
    const days = (simple.weekdays || []).map((day) => t(`schedule.weekday.${day}`)).join("");
    return `${t("schedule.weekly")} ${days} ${simple.time || ""}`.trim();
  }
  if (simple.frequency === "monthly") {
    return t("schedule.monthlySummary", { day: simple.monthDay, time: simple.time || "" });
  }
  return `${t("schedule.daily")} ${simple.time || ""}`.trim();
}

function renderSchedules() {
  const list = $("#scheduleList");
  if (!list) return;
  if (!state.schedules.length) {
    list.innerHTML = `<p class="empty">${escapeHtml(t("schedule.empty"))}</p>`;
    return;
  }

  list.innerHTML = state.schedules
    .map((schedule) => {
      const canManage = canManageSchedule(schedule);
      const nextText = schedule.nextRunAt
        ? t("schedule.next", { time: formatDateTime(schedule.nextRunAt) })
        : "";
      const lastText = schedule.lastRunAt
        ? t("schedule.last", { time: formatDateTime(schedule.lastRunAt) })
        : t("schedule.never");
      const owner =
        hasPerm("jobs.viewAll") && !sameUsername(schedule.ownerUsername, state.auth.username)
          ? ` · ${escapeHtml(t("schedule.owner", { name: schedule.ownerUsername }))}`
          : "";
      const error = schedule.lastError
        ? `<p class="schedule-error">${escapeHtml(translateApiError(schedule.lastError))}</p>`
        : "";
      const disabledBadge = schedule.enabled
        ? ""
        : `<span class="mode-badge">${escapeHtml(t("schedule.disabled"))}</span>`;
      return `
        <article class="schedule-item${schedule.enabled ? "" : " disabled"}" data-schedule-id="${escapeHtml(schedule.id)}">
          <div class="schedule-item-top">
            <div class="schedule-item-title">
              <strong>${escapeHtml(schedule.name)}${disabledBadge}</strong>
              <div class="meta">${escapeHtml(schedule.project.name)} · ${escapeHtml(describeSchedule(schedule))}${owner}</div>
              <div class="meta">${escapeHtml([nextText, lastText].filter(Boolean).join(" · "))}</div>
            </div>
            <label class="inline-toggle">
              <input type="checkbox" data-schedule-enabled="${escapeHtml(schedule.id)}" ${schedule.enabled ? "checked" : ""} ${canManage ? "" : "disabled"} />
            </label>
          </div>
          ${error}
          <div class="schedule-item-actions">
            ${canManage ? `<button type="button" class="ghost small" data-schedule-run="${escapeHtml(schedule.id)}">${escapeHtml(t("schedule.run"))}</button>` : ""}
            ${canManage ? `<button type="button" class="ghost small" data-schedule-edit="${escapeHtml(schedule.id)}">${escapeHtml(t("schedule.edit"))}</button>` : ""}
            ${canManage ? `<button type="button" class="ghost small danger" data-schedule-delete="${escapeHtml(schedule.id)}">${escapeHtml(t("schedule.delete"))}</button>` : ""}
          </div>
        </article>
      `;
    })
    .join("");
}

function resetScheduleForm() {
  const form = $("#scheduleForm");
  if (form) form.reset();
  state.editingScheduleId = "";
  state.scheduleProjectId = state.selectedProjectId;
  state.scheduleExtraProjectIds = [];
  if (form?.scheduleId) form.scheduleId.value = "";
  $("#scheduleSheetTitle").textContent = t("schedule.new");
  $("#scheduleDeleteButton")?.classList.add("hidden");
  $("#scheduleEnabledToggle").checked = true;
  $("#scheduleResumeToggle").checked = false;
  $("#scheduleFrequencySelect").value = "daily";
  $("#scheduleTimeInput").value = "03:00";
  $("#scheduleMonthDayInput").value = String(new Date().getDate());
  $("#scheduleIntervalInput").value = "6";
  $("#scheduleCronInput").value = "";
  $("#schedulePromptInput").value = "";
  setScheduleKind("simple");
  setModeSelect($("#scheduleModeSelect"), loadSavedMode());
  syncScheduleModeSegment();
  applyModelSelection("schedule", loadSavedModel());
  applyAgentOptions("schedule", loadSavedAgentOptions());
  renderScheduleWeekdays([new Date().getDay()]);
  renderSchedulePromptChips();
  updateScheduleProjectLabel();
  renderScheduleProjectPicker();
  $("#scheduleProjectPicker")?.classList.add("hidden");
  updateScheduleNextPreview();
}

function fillScheduleForm(schedule) {
  const form = $("#scheduleForm");
  if (!form) return;
  state.editingScheduleId = schedule.id;
  state.scheduleProjectId = schedule.project.id;
  state.scheduleExtraProjectIds = (schedule.runOptions?.extraProjects || []).map((item) => item.id);
  form.scheduleId.value = schedule.id;
  form.name.value = schedule.name;
  $("#scheduleSheetTitle").textContent = t("schedule.edit");
  $("#scheduleDeleteButton")?.classList.toggle("hidden", !canManageSchedule(schedule));
  $("#scheduleEnabledToggle").checked = schedule.enabled !== false;
  $("#scheduleResumeToggle").checked = Boolean(schedule.resumeLast);
  $("#schedulePromptInput").value = schedule.prompt || "";
  setScheduleKind(schedule.kind);
  if (schedule.kind === "cron") {
    $("#scheduleCronInput").value = schedule.cronExpr || "";
  } else {
    const simple = schedule.simple || { frequency: "daily", time: "03:00" };
    $("#scheduleFrequencySelect").value = simple.frequency || "daily";
    $("#scheduleTimeInput").value = simple.time || "03:00";
    $("#scheduleMonthDayInput").value = String(simple.monthDay || new Date().getDate());
    $("#scheduleIntervalInput").value = String(simple.intervalHours || 6);
    renderScheduleWeekdays(simple.weekdays || []);
  }
  updateScheduleFrequencyFields();
  setModeSelect($("#scheduleModeSelect"), schedule.runOptions?.mode || loadSavedMode());
  syncScheduleModeSegment();
  applyModelSelection("schedule", schedule.runOptions?.model || loadSavedModel());
  applyAgentOptions("schedule", {
    loadLocalSettings: schedule.runOptions?.loadLocalSettings,
    sandbox: schedule.runOptions?.sandbox,
    autoReview: schedule.runOptions?.autoReview,
    disallowedTools: schedule.runOptions?.disallowedTools || [],
    extraProjectIds: state.scheduleExtraProjectIds,
  });
  renderSchedulePromptChips();
  updateScheduleProjectLabel();
  renderScheduleProjectPicker();
  $("#scheduleProjectPicker")?.classList.add("hidden");
  updateScheduleNextPreview();
}

function openScheduleSheet(schedule) {
  if (!hasPerm("jobs.create") && !schedule) {
    showToast(t("api.forbidden"));
    return;
  }
  ensureSelectedProject();
  if (schedule) fillScheduleForm(schedule);
  else resetScheduleForm();
  openSheet("scheduleSheet");
  window.setTimeout(() => formFieldFocus(), 120);
}

function formFieldFocus() {
  const input = $("#scheduleForm")?.name;
  input?.focus();
}

function collectSchedulePayload() {
  const form = $("#scheduleForm");
  const kind = currentScheduleKind();
  const frequency = $("#scheduleFrequencySelect")?.value || "daily";
  const agentOptions = collectAgentOptions("schedule");
  const payload = {
    name: form.name.value.trim(),
    projectId: state.scheduleProjectId || state.selectedProjectId,
    enabled: Boolean($("#scheduleEnabledToggle")?.checked),
    kind,
    prompt: $("#schedulePromptInput")?.value.trim() || "",
    resumeLast: Boolean($("#scheduleResumeToggle")?.checked),
    mode: getModeFromSelect($("#scheduleModeSelect")),
    model: collectModelSelection("schedule"),
    extraProjectIds: agentOptions.extraProjectIds,
    loadLocalSettings: agentOptions.loadLocalSettings,
    sandbox: agentOptions.sandbox,
    autoReview: agentOptions.autoReview,
    disallowedTools: agentOptions.disallowedTools,
  };
  if (kind === "cron") {
    payload.cronExpr = $("#scheduleCronInput")?.value.trim() || "";
  } else {
    const rawTime = $("#scheduleTimeInput")?.value || "03:00";
    payload.simple = {
      frequency,
      time: rawTime.slice(0, 5),
      weekdays: collectScheduleWeekdays(),
      monthDay: Number($("#scheduleMonthDayInput")?.value || 1),
      intervalHours: Number($("#scheduleIntervalInput")?.value || 6),
    };
  }
  return payload;
}

async function saveSchedule() {
  const payload = collectSchedulePayload();
  if (!payload.projectId) {
    showToast(t("toast.selectProject"));
    switchTab("projects");
    return;
  }
  const editingId = state.editingScheduleId;
  const result = editingId
    ? await api(`/api/schedules/${editingId}`, { method: "PATCH", body: JSON.stringify(payload) })
    : await api("/api/schedules", { method: "POST", body: JSON.stringify(payload) });
  closeSheet("scheduleSheet");
  showToast(t("schedule.saved"));
  await refreshData();
  return result.schedule;
}

const removingScheduleIds = new Set();

async function removeSchedule(scheduleId) {
  if (!scheduleId || removingScheduleIds.has(scheduleId)) return false;
  removingScheduleIds.add(scheduleId);
  try {
    if (!window.confirm(t("schedule.deleteConfirm"))) return false;
    await api(`/api/schedules/${scheduleId}`, { method: "DELETE" });
    if (state.editingScheduleId === scheduleId) {
      closeSheet("scheduleSheet");
      state.editingScheduleId = "";
    }
    showToast(t("schedule.deleted"));
    await refreshData();
    return true;
  } finally {
    removingScheduleIds.delete(scheduleId);
  }
}

async function runSchedule(scheduleId) {
  const { job } = await api(`/api/schedules/${scheduleId}/run`, {
    method: "POST",
    body: "{}",
  });
  if (!job) return;
  state.currentJobId = job.id;
  state.chatPinnedToBottom = true;
  closeSheet("scheduleSheet");
  enterChat();
  renderCurrentJob(job);
  await refreshData();
  startLiveUpdates(job.id);
}

function openNewTaskSheet() {
  if (!hasPerm("jobs.create")) {
    showToast(t("api.forbidden"));
    return;
  }
  ensureSelectedProject();
  state.submitProjectId = state.selectedProjectId;
  updateNewTaskProjectLabel();
  setModeSelect($("#modeSelect"), loadSavedMode());
  applyModelSelection("submit", loadSavedModel());
  applyAgentOptions("submit", loadSavedAgentOptions());
  revokeImagePreviews("submit");
  renderImagePreviews("submit");
  setNewTaskOptionsOpen(false);
  updateComposerModelLabel("submit");
  updateNewTaskSendState();
  openSheet("newTaskSheet");
  window.setTimeout(() => {
    const input = $("#promptInput");
    input?.focus();
    if (input) autosizeTextarea(input, 220);
  }, 120);
}

async function submitNewJob() {
  const button = $("#submitJobButton");
  if (button?.disabled) return;
  if (button) button.disabled = true;

  try {
    const prompt = $("#promptInput").value.trim();
    const project = selectedProject();
    const projectId = project?.id || "";
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
        extraProjectIds: agentOptions.extraProjectIds.filter((id) => id !== projectId),
        loadLocalSettings: agentOptions.loadLocalSettings,
        sandbox: agentOptions.sandbox,
        autoReview: agentOptions.autoReview,
        disallowedTools: agentOptions.disallowedTools,
      }),
    });
    state.currentJobId = job.id;
    state.chatPinnedToBottom = true;
    closeSheet("newTaskSheet");
    setNewTaskOptionsOpen(false);
    enterChat();
    renderCurrentJob(job);
    $("#promptInput").value = "";
    revokeImagePreviews("submit");
    renderImagePreviews("submit");
    await refreshData();
    startLiveUpdates(job.id);
  } catch (error) {
    showToast(error.message);
  } finally {
    updateNewTaskSendState();
  }
}

async function bootstrap() {
  if (window.__crcSession?.csrfToken) {
    state.csrfToken = window.__crcSession.csrfToken;
    applyAuthFromSession(window.__crcSession);
    setLoggedIn(true);
    await refreshData();
    return;
  }

  try {
    const session = await api("/api/session");
    state.csrfToken = session.csrfToken;
    applyAuthFromSession(session);
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

  applyAuthFromSession(session);
  window.__crcSession = {
    csrfToken: state.csrfToken,
    sessionToken: session.sessionToken,
    username: session.username || "",
    role: session.role,
    permissions: session.permissions,
    allowedProjectIds: session.allowedProjectIds,
  };
  try {
    localStorage.setItem("crc_session_token", session.sessionToken);
    localStorage.setItem("crc_csrf_token", state.csrfToken);
    sessionStorage.removeItem("crc_session_token");
    sessionStorage.removeItem("crc_csrf_token");
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
    try {
      localStorage.removeItem("crc_session_token");
      localStorage.removeItem("crc_csrf_token");
      sessionStorage.removeItem("crc_session_token");
      sessionStorage.removeItem("crc_csrf_token");
    } catch {
      // ignore
    }
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

on("#scheduleExtraWorkspaceList", "click", (event) => {
  const chip = event.target.closest("[data-extra-project]");
  if (!chip) return;
  const projectId = chip.dataset.extraProject;
  const selected = new Set(state.scheduleExtraProjectIds);
  if (selected.has(projectId)) selected.delete(projectId);
  else selected.add(projectId);
  state.scheduleExtraProjectIds = [...selected];
  renderScheduleExtraWorkspaces();
});

on("#scheduleDisallowedTools", "click", (event) => {
  const chip = event.target.closest("[data-tool]");
  if (!chip) return;
  chip.classList.toggle("active");
});

on("#newScheduleButton", "click", () => openScheduleSheet());

on("#scheduleChangeProjectButton", "click", () => {
  const picker = $("#scheduleProjectPicker");
  if (!picker) return;
  picker.classList.toggle("hidden");
  if (!picker.classList.contains("hidden")) renderScheduleProjectPicker();
});

on("#scheduleProjectPicker", "click", (event) => {
  const chip = event.target.closest("[data-schedule-project]");
  if (!chip) return;
  setScheduleProject(chip.dataset.scheduleProject);
  $("#scheduleProjectPicker")?.classList.add("hidden");
});

on("#scheduleKindSegment", "click", (event) => {
  const button = event.target.closest("[data-kind]");
  if (!button) return;
  setScheduleKind(button.dataset.kind);
});

on("#scheduleFrequencySelect", "change", () => {
  updateScheduleFrequencyFields();
  updateScheduleNextPreview();
});

on("#scheduleTimeInput", "change", () => updateScheduleNextPreview());
on("#scheduleMonthDayInput", "input", () => updateScheduleNextPreview());
on("#scheduleIntervalInput", "input", () => updateScheduleNextPreview());
on("#scheduleCronInput", "input", () => updateScheduleNextPreview());

on("#scheduleWeekdays", "click", (event) => {
  const chip = event.target.closest("[data-weekday]");
  if (!chip) return;
  chip.classList.toggle("active");
  updateScheduleNextPreview();
});

on("#schedulePromptChips", "click", (event) => {
  const chip = event.target.closest("[data-prompt-template]");
  if (!chip) return;
  const key = chip.dataset.promptTemplate === "errors" ? "schedule.templateErrorsPrompt" : "schedule.templateDepsPrompt";
  const input = $("#schedulePromptInput");
  if (input) input.value = t(key);
});

on("#scheduleModeSegment", "click", (event) => {
  const button = event.target.closest("[data-mode]");
  if (!button) return;
  setModeSelect($("#scheduleModeSelect"), button.dataset.mode === "plan" ? "plan" : "agent");
  syncScheduleModeSegment();
});

on("#scheduleForm", "submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  if (button) button.disabled = true;
  try {
    await saveSchedule();
  } catch (error) {
    showToast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
});

on("#scheduleDeleteButton", "click", async () => {
  const id = state.editingScheduleId;
  if (!id) return;
  try {
    await removeSchedule(id);
  } catch (error) {
    showToast(error.message);
  }
});

on("#scheduleList", "click", async (event) => {
  const toggle = event.target.closest("[data-schedule-enabled]");
  if (toggle) {
    event.stopPropagation();
    try {
      await api(`/api/schedules/${toggle.dataset.scheduleEnabled}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: toggle.checked }),
      });
      await refreshData();
    } catch (error) {
      toggle.checked = !toggle.checked;
      showToast(error.message);
    }
    return;
  }

  const runButton = event.target.closest("[data-schedule-run]");
  if (runButton) {
    event.stopPropagation();
    try {
      await runSchedule(runButton.dataset.scheduleRun);
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  const deleteButton = event.target.closest("[data-schedule-delete]");
  if (deleteButton) {
    event.stopPropagation();
    try {
      await removeSchedule(deleteButton.dataset.scheduleDelete);
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  const editButton = event.target.closest("[data-schedule-edit]");
  const item = event.target.closest("[data-schedule-id]");
  const scheduleId = editButton?.dataset.scheduleEdit || item?.dataset.scheduleId;
  if (!scheduleId) return;
  const schedule = state.schedules.find((entry) => entry.id === scheduleId);
  if (schedule && canManageSchedule(schedule)) openScheduleSheet(schedule);
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
  setNewTaskOptionsOpen(false);
  submitNewJob().catch((error) => showToast(error.message));
});

on("#promptInput", "keydown", (event) => {
  if (!isSubmitEnter(event)) return;
  event.preventDefault();
  if ($("#submitJobButton")?.disabled) return;
  setNewTaskOptionsOpen(false);
  submitNewJob().catch((error) => showToast(error.message));
});

on("#promptInput", "input", (event) => {
  autosizeTextarea(event.currentTarget, 220);
  updateNewTaskSendState();
});

on("#headerNewTaskButton", "click", openNewTaskSheet);
on("#sessionNewTaskButton", "click", openNewTaskSheet);
on("#chatBackButton", "click", () => leaveChat());

window.addEventListener("popstate", () => {
  if (suppressChatPopstate) {
    suppressChatPopstate = false;
    window.clearTimeout(suppressChatPopstateTimer);
    if (state.inChat) ensureChatHistoryState();
    return;
  }
  if (state.inChat) leaveChat({ fromPopstate: true });
});

on("#newTaskChangeProjectButton", "click", () => {
  setNewTaskOptionsOpen(false);
  closeSheet("newTaskSheet");
  switchTab("projects");
});

on("#settingsButton", "click", () => {
  applyAuthUi();
  openSheet("settingsSheet");
});

on("#usersManageButton", "click", () => {
  openUsersSheet().catch((error) => showToast(error.message));
});

on("#userEditResetButton", "click", () => resetUserEditForm());

on("#userResetPasswordButton", "click", async () => {
  const userId = $("#userEditForm")?.userId?.value;
  if (!userId) return;
  try {
    const result = await api(`/api/users/${userId}/password`, {
      method: "POST",
      body: "{}",
    });
    showToast(result.password ? t("users.generatedPassword", { password: result.password }) : t("users.saved"));
  } catch (error) {
    showToast(error.message);
  }
});

on("#userList", "click", (event) => {
  const item = event.target.closest("[data-user-id]");
  if (!item) return;
  const user = state.users.find((entry) => entry.id === item.dataset.userId);
  if (user) fillUserEditForm(user);
});

on("#userEditForm", "change", (event) => {
  if (event.target?.name !== "role") return;
  const form = event.currentTarget;
  const user = state.users.find((entry) => entry.id === form.userId.value);
  if (user && user.role === form.role.value) {
    renderUserPermissionList(new Set(user.permissions || []));
    return;
  }
  renderUserPermissionList(new Set(effectivePermissions(form.role.value)));
});

on("#userEditForm", "submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const role = form.role.value;
  const { grants, denies } = computeOverrides(role, selectedUserPermissions());
  const allowedProjectIds = [...document.querySelectorAll("#userProjectList input[type=checkbox]:checked")].map(
    (item) => item.value,
  );
  const payload = {
    role,
    grants,
    denies,
    allowedProjectIds,
  };

  try {
    if (form.userId.value) {
      payload.disabled = Boolean(form.disabled.checked);
      await api(`/api/users/${form.userId.value}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      showToast(t("users.saved"));
    } else {
      const created = await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          username: form.username.value.trim(),
          password: form.password.value,
          ...payload,
        }),
      });
      showToast(created.password ? t("users.generatedPassword", { password: created.password }) : t("users.saved"));
    }
    await loadUserAdminData();
    resetUserEditForm();
  } catch (error) {
    showToast(error.message);
  }
});

on("#changePasswordForm", "submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const currentPassword = form.currentPassword.value;
  const newPassword = form.newPassword.value;
  try {
    await api("/api/me/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    form.reset();
    showToast(t("settings.passwordChanged"));
  } catch (error) {
    showToast(error.message);
  }
});

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
  setFollowUpOptionsOpen(false);
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
  setFollowUpOptionsOpen(false);
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
  if (!isSubmitEnter(event)) return;
  event.preventDefault();
  if ($("#followUpButton")?.disabled) return;
  $("#followUpForm")?.requestSubmit();
});

on("#followUpInput", "input", (event) => {
  const input = event.currentTarget;
  autosizeTextarea(input);
  updateFollowUpSendState();
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

document.querySelector("#newTaskSheet .mode-segment")?.addEventListener("click", (event) => {
  const button = event.target.closest(".mode-segment-btn");
  if (!button) return;
  syncModeSelectFromSegment(button.dataset.mode === "plan" ? "plan" : "agent");
});

on("#sessionSwitcher", "click", (event) => {
  const chip = event.target.closest("[data-switch-job]");
  if (!chip) return;
  openJob(chip.dataset.switchJob).catch((error) => showToast(error.message));
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
  openJob(item.dataset.jobId).catch((error) => showToast(error.message));
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

on("#chatOutput", "click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest("[data-chat-copy]");
  const output = $("#chatOutput");
  if (!button || !output?.contains(button)) return;

  const row = button.closest(".chat-row");
  const index = row ? Array.prototype.indexOf.call(output.children, row) : -1;
  const message = index >= 0 ? lastChatMessages[index] : null;
  if (!message || (message.role !== "user" && message.role !== "assistant")) {
    showToast(t("toast.copyFailed"));
    return;
  }

  const markdown = messageCopyText(message);
  if (!markdown) {
    showToast(t("toast.copyFailed"));
    return;
  }

  try {
    await copyTextToClipboard(markdown);
    showCopyButtonFeedback(button);
  } catch {
    showToast(t("toast.copyFailed"));
  }
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
bindModelSettings("schedule");
applyAgentOptions("submit", loadSavedAgentOptions());
applyAgentOptions("followUp", loadSavedAgentOptions());
applyModels(FALLBACK_MODELS, { id: "default" });
state.historyFilter = loadHistoryFilter();
state.archivedJobIds = loadArchivedJobIds();
state.notifyEnabled = loadNotifyEnabled();
updateFilterChips();
setupPullToRefresh();
bindComposerPanels();
updateNewTaskSendState();
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
