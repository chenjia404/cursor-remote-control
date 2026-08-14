import { Cursor, type ModelListItem, type ModelParameterValue, type ModelSelection } from "@cursor/sdk";
import { config } from "./config.js";

export type AgentModelSelection = {
  id: string;
  params?: ModelParameterValue[];
};

const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const PARAM_TEXT_PATTERN = /^[a-zA-Z0-9._:-]{1,64}$/;
const CACHE_TTL_MS = 5 * 60 * 1000;

const FALLBACK_MODELS: ModelListItem[] = [
  { id: "auto", displayName: "Auto" },
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

let catalogCache: { at: number; items: ModelListItem[] } | null = null;

function isValidModelId(id: string): boolean {
  return MODEL_ID_PATTERN.test(id);
}

function sanitizeParams(params: unknown): ModelParameterValue[] {
  if (!Array.isArray(params)) return [];
  const next: ModelParameterValue[] = [];
  for (const item of params.slice(0, 16)) {
    if (!item || typeof item !== "object") continue;
    const id = String((item as { id?: unknown }).id || "").trim();
    const value = String((item as { value?: unknown }).value ?? "").trim();
    if (!PARAM_TEXT_PATTERN.test(id) || !PARAM_TEXT_PATTERN.test(value)) continue;
    next.push({ id, value });
  }
  return next;
}

function findModel(catalog: ModelListItem[], id: string): ModelListItem | undefined {
  return catalog.find((item) => item.id === id || item.aliases?.includes(id));
}

function defaultParamsForModel(model: ModelListItem): ModelParameterValue[] {
  const preset = model.variants?.find((item) => item.isDefault) ?? model.variants?.[0];
  if (preset?.params?.length) return preset.params.map((item) => ({ id: item.id, value: item.value }));

  return (model.parameters ?? []).flatMap((parameter) => {
    const value = parameter.values[0]?.value;
    return value ? [{ id: parameter.id, value }] : [];
  });
}

function constrainParams(model: ModelListItem, params: ModelParameterValue[]): ModelParameterValue[] {
  const definitions = model.parameters ?? [];
  if (definitions.length === 0) {
    if (model.variants?.length) {
      const match = model.variants.find(
        (variant) =>
          variant.params.length === params.length &&
          variant.params.every((item) => params.some((param) => param.id === item.id && param.value === item.value)),
      );
      return match ? match.params.map((item) => ({ id: item.id, value: item.value })) : defaultParamsForModel(model);
    }
    return params;
  }

  const byId = new Map(params.map((item) => [item.id, item.value]));
  return definitions.flatMap((parameter) => {
    const allowed = new Set(parameter.values.map((item) => item.value));
    const requested = byId.get(parameter.id);
    const value = requested && allowed.has(requested) ? requested : parameter.values[0]?.value;
    return value ? [{ id: parameter.id, value }] : [];
  });
}

export function defaultModelSelection(catalog: ModelListItem[] = FALLBACK_MODELS): AgentModelSelection {
  const configured = config.cursorModel.trim() || "auto";
  const model = findModel(catalog, configured) ?? findModel(catalog, "auto") ?? catalog[0];
  if (!model) return { id: configured };
  const params = defaultParamsForModel(model);
  return params.length ? { id: model.id, params } : { id: model.id };
}

export function normalizeModelSelection(input: unknown, catalog: ModelListItem[]): AgentModelSelection {
  const fallback = defaultModelSelection(catalog);
  if (!input || typeof input !== "object") return fallback;

  const rawId = String((input as { id?: unknown }).id || "").trim();
  const params = sanitizeParams((input as { params?: unknown }).params);
  if (!isValidModelId(rawId)) return fallback;

  const model = findModel(catalog, rawId);
  if (!model) {
    return params.length ? { id: rawId, params } : { id: rawId };
  }

  const nextParams = constrainParams(model, params);
  return nextParams.length ? { id: model.id, params: nextParams } : { id: model.id };
}

export function formatModelSelection(selection: AgentModelSelection | undefined, catalog: ModelListItem[] = []): string {
  if (!selection?.id) return "";
  const model = findModel(catalog, selection.id);
  const name = model?.displayName || selection.id;
  const extras = (selection.params ?? [])
    .map((param) => {
      const definition = model?.parameters?.find((item) => item.id === param.id);
      const value = definition?.values.find((item) => item.value === param.value);
      const label = value?.displayName || param.value;
      if (!label || label === "false") return "";
      if (param.value === "true") return definition?.displayName || param.id;
      return label;
    })
    .filter(Boolean);
  return extras.length ? `${name} · ${extras.join(" / ")}` : name;
}

function asModelList(value: unknown): ModelListItem[] {
  if (Array.isArray(value)) return value as ModelListItem[];
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: ModelListItem[] }).items;
  }
  return [];
}

export async function listCursorModels(): Promise<ModelListItem[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.at < CACHE_TTL_MS) {
    return catalogCache.items;
  }

  try {
    const listed = await Cursor.models.list({ apiKey: config.cursorApiKey });
    const items = asModelList(listed).filter((item) => item?.id && isValidModelId(item.id));
    const catalog = items.length > 0 ? items : FALLBACK_MODELS;
    catalogCache = { at: now, items: catalog };
    return catalog;
  } catch (error) {
    console.warn("获取 Cursor 模型列表失败，使用本地回退目录", error);
    if (catalogCache) return catalogCache.items;
    catalogCache = { at: now, items: FALLBACK_MODELS };
    return FALLBACK_MODELS;
  }
}

export async function resolveModelSelection(input: unknown): Promise<AgentModelSelection> {
  const catalog = await listCursorModels();
  return normalizeModelSelection(input, catalog);
}

export function toSdkModel(selection: AgentModelSelection): ModelSelection {
  return selection.params?.length ? { id: selection.id, params: selection.params } : { id: selection.id };
}
