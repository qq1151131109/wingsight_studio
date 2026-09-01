/** 文本模型目录 API（agent /models/text，清单经智谱官方端点探针验证，
 *  见 agent/models.py）。剧本/分镜表/拆解等文本生成的模型选择唯一前端入口。 */
import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/auth";

export type TextModelOption = {
  id: string;
  label: string;
  tag: string;
  recommended?: boolean;
};

export const TEXT_MODEL_DEFAULT_ID = "glm-5.3-flash";

export async function fetchTextModels(): Promise<TextModelOption[]> {
  const r = await apiFetch("/agent-service/models/text");
  if (!r.ok) throw new Error(`文本模型目录加载失败（${r.status}）`);
  const data = (await r.json()) as { models?: TextModelOption[] };
  if (!data.models?.length) throw new Error("文本模型目录为空");
  return data.models;
}

// ---------- 目录共享加载（分镜表卡/剧本卡的模型 chip） ----------

let modelsPromise: Promise<TextModelOption[]> | null = null;

export function loadTextModels(): Promise<TextModelOption[]> {
  modelsPromise ??= fetchTextModels();
  return modelsPromise;
}

export function useTextModels(): {
  models: TextModelOption[] | null;
  error: string;
  reload: () => void;
} {
  const [models, setModels] = useState<TextModelOption[] | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    loadTextModels()
      .then((m) => {
        if (cancelled) return;
        setModels(m);
        setError("");
      })
      .catch((e: unknown) => {
        modelsPromise = null; // 失败不缓存，重试真的重发
        if (!cancelled) setError(e instanceof Error ? e.message : "文本模型目录加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);
  return { models, error, reload: () => setTick((t) => t + 1) };
}

/** 目录里找模型；找不到回 null（调用方显示原 id 并提示已下架） */
export function findTextModelOption(
  modelId: string,
  models: TextModelOption[] | null,
): TextModelOption | null {
  return models?.find((m) => m.id === modelId) ?? null;
}
