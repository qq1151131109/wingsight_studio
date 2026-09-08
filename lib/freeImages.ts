/** 自由生图工作台 API（juben ImageStudioPage 移植，2026-09-07）。
 *  与资产/分镜出图隔离：不读画风、不进画布；批次多模型并行，画廊 3s 轮询。 */
import { apiFetch } from "@/lib/auth";

export interface FreeImageItem {
  id: string;
  projectId?: string;
  batchId: string;
  prompt: string;
  aspect: string;
  resolution: string;
  modelId: string;
  referenceUrls: string[];
  status: "queued" | "running" | "done" | "error";
  imageUrl: string | null;
  /** 仅详情端点返回（列表轮询不带——每行最多 3000 字是纯流量浪费） */
  finalPrompt?: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function generateFreeImages(req: {
  projectId: string;
  prompt: string;
  aspect?: string;
  resolution?: string;
  models: string[];
  referenceImages?: string[];
}): Promise<{ batchId: string; items: { id: string; modelId: string }[] }> {
  const r = await apiFetch("/agent-service/free-images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: req.projectId,
      prompt: req.prompt,
      aspect: req.aspect ?? "",
      resolution: req.resolution ?? "",
      models: req.models,
      reference_images: req.referenceImages ?? [],
    }),
  });
  if (!r.ok) {
    throw new Error((await r.text()) || `提交失败（HTTP ${r.status}）`);
  }
  return r.json();
}

/** 单条详情（含 finalPrompt）：Lightbox 打开时按条拉，不随轮询下发 */
export async function getFreeImageDetail(id: string): Promise<FreeImageItem> {
  const r = await apiFetch(`/agent-service/free-images/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`详情加载失败（HTTP ${r.status}）`);
  return r.json();
}

export async function listFreeImages(projectId: string): Promise<FreeImageItem[]> {
  const r = await apiFetch(
    `/agent-service/free-images?project_id=${encodeURIComponent(projectId)}`,
  );
  if (!r.ok) throw new Error(`画廊加载失败（HTTP ${r.status}）`);
  const data = (await r.json()) as { items?: FreeImageItem[] };
  return data.items ?? [];
}
