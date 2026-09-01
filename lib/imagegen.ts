/** 图像模型目录 API（agent /models/image，清单经 DMX 实探验证，
 *  见 agent/models.py）。出图模型/分辨率/画幅切换的唯一前端入口。 */
import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/auth";
import { assetThumbUrl } from "@/lib/asset-thumb";

export type ImagegenParams = {
  model: string;
  resolution: string;
  /** 画幅 w:h；缺省 = 自动（有参考图跟随首位参考图比例，无参考图按
   *  资产类型默认幅面）。落 data.gen / meta.imagegen，agent 预检校验 */
  aspect?: string;
};

/** 项目级出图默认：gpt-image-2-03 · 1K（与 agent DEFAULT_MODEL_ID 一致） */
export const IMAGEGEN_DEFAULT: ImagegenParams = {
  model: "gpt-image-2-03",
  resolution: "1K",
};

export type ImageModelOption = {
  id: string;
  label: string;
  tag: string;
  resolutions: string[];
  /** 该模型支持的画幅枚举（agent/models.py：seedream-5-pro 无 21:9） */
  aspects?: string[];
  default_resolution: string;
  recommended?: boolean;
  /** 参考图上限（agent/models.py 声明：seedream-5-pro 10 张实测，其余保守 4） */
  max_references?: number;
};

export async function fetchImageModels(): Promise<ImageModelOption[]> {
  const r = await apiFetch("/agent-service/models/image");
  if (!r.ok) throw new Error(`模型目录加载失败（${r.status}）`);
  const data = (await r.json()) as { models?: ImageModelOption[] };
  if (!data.models?.length) throw new Error("模型目录为空（agent 未配置出图）");
  return data.models;
}

/** 项目 meta.imagegen 存值校验：形状不对（旧数据/脏数据）回默认 */
export function saneImagegen(
  raw: unknown,
): ImagegenParams {
  const v = raw as Partial<ImagegenParams> | null;
  if (
    v &&
    typeof v.model === "string" &&
    v.model.trim() &&
    typeof v.resolution === "string" &&
    v.resolution.trim()
  ) {
    const aspect = typeof v.aspect === "string" ? v.aspect.trim() : "";
    return { model: v.model, resolution: v.resolution, ...(aspect ? { aspect } : {}) };
  }
  return IMAGEGEN_DEFAULT;
}

/** 卡片级覆盖（WingNodeData.gen）存值校验：形状不对 = 未覆盖（null） */
export function saneGen(raw: unknown): ImagegenParams | null {
  if (!raw || typeof raw !== "object") return null;
  const v = saneImagegen(raw);
  const src = raw as Partial<ImagegenParams>;
  return v.model === src.model && v.resolution === src.resolution ? v : null;
}

// ---------- 模型目录共享加载（出图设置面板 / PromptBar chips / 卡片 popover） ----------

let modelsPromise: Promise<ImageModelOption[]> | null = null;

export function loadImageModels(): Promise<ImageModelOption[]> {
  modelsPromise ??= fetchImageModels();
  return modelsPromise;
}

export function useImageModels(): {
  models: ImageModelOption[] | null;
  error: string;
  reload: () => void;
} {
  const [models, setModels] = useState<ImageModelOption[] | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    loadImageModels()
      .then((m) => {
        if (cancelled) return;
        setModels(m);
        setError("");
      })
      .catch((e: unknown) => {
        modelsPromise = null; // 失败不缓存，重试真的重发
        if (!cancelled) setError(e instanceof Error ? e.message : "模型目录加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);
  return { models, error, reload: () => setTick((t) => t + 1) };
}

/** 目录里找模型；找不到回 null（调用方显示原 id 并提示已下架） */
export function findModelOption(
  modelId: string,
  models: ImageModelOption[] | null,
): ImageModelOption | null {
  return models?.find((m) => m.id === modelId) ?? null;
}

/** 「自动」画幅解析：跟随首位参考图的真实宽高比，吸附到该模型支持档里
 *  最近的一个（Storyboard-Copilot pickClosestAspectRatio 范式——在带图的
 *  卡上出图=改这张图，幅面自然跟原素材走）。无参考图/测量失败回空串
 *  （flow 按资产类型默认幅面）。用缩略图测量，免拉 4K 原图 */
export async function resolveAutoAspect(
  firstRefUrl: string | undefined,
  modelId: string,
): Promise<string> {
  if (!firstRefUrl) return "";
  const models = await loadImageModels().catch(() => null);
  const aspects = findModelOption(modelId, models)?.aspects ?? [];
  if (aspects.length === 0) return "";
  const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = assetThumbUrl(firstRefUrl);
  });
  if (!dims || dims.w <= 0 || dims.h <= 0) return "";
  const target = dims.w / dims.h;
  let best = "";
  let bestDiff = Infinity;
  for (const a of aspects) {
    const [w, h] = a.split(":").map(Number);
    if (!w || !h) continue;
    const diff = Math.abs(w / h - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = a;
    }
  }
  return best;
}
