/** 分镜表生成 API：shotlist 卡一键生成（剧本 → rows）。
 *  链路：前端 → 同源代理 /agent-service → agent /storyboard/generate
 *  → langflow「分镜表生成」flow（agent/flows/shotlist-generate.json）。 */
import { apiFetch } from "@/lib/auth";
import type { ShotRow } from "@/lib/canvas/store";

export async function generateShotlist(
  script: string,
  opts?: {
    shotCount?: number;
    durationSeconds?: number;
    visualStyle?: string;
    /** 画布已有资产名单（类型化）：分镜 @名称 引用 + 角色硬约束 */
    assets?: { type: string; name: string }[];
  },
): Promise<ShotRow[]> {
  const r = await apiFetch("/agent-service/storyboard/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script, ...opts }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 160);
    throw new Error(detail || `生成失败（${r.status}）`);
  }
  const data = (await r.json()) as { rows?: ShotRow[] };
  return data.rows ?? [];
}

/** 剧本/分镜稿 → 结构化资产清单（直连拆解 flow）。 */
export type DecomposedAsset = {
  type: "character" | "scene" | "prop";
  name: string;
  description: string;
  visual_notes: string;
};

export async function decomposeAssets(
  script: string,
  existing?: { type: string; name: string }[],
): Promise<{ assets: DecomposedAsset[]; errors: Record<string, string> }> {
  const r = await apiFetch("/agent-service/assets/decompose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script, existing }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 160);
    throw new Error(detail || `拆解失败（${r.status}）`);
  }
  const data = (await r.json()) as {
    assets?: DecomposedAsset[];
    errors?: Record<string, string>;
  };
  return { assets: data.assets ?? [], errors: data.errors ?? {} };
}

/** 分镜行批量出图请求（直连 imagegen flow，不经聊天）。
 *  description 传最终提示词或按行字段合成；visualNotes 并入一致性参考描述；
 *  referenceImages 传角色定妆照 URL（一致性锚点，flow 下载作参考图）；
 *  assetType 决定出图幅面与布局契约（角色 16:9 四格 / 道具 4:3，缺省 scene）。 */
export type ShotImageRequest = {
  rid: string;
  name: string;
  description: string;
  visualNotes?: string;
  assetType?: "character" | "scene" | "prop";
  referenceImages?: string[];
};

export type ShotImageResult = {
  rid: string;
  ok: boolean;
  imageUrl?: string;
  error?: string;
};

/** 启动批量出图任务：Next 同源代理 30s 掐断长请求，必须异步任务 + 轮询 */
export async function startShotImageJob(
  shots: ShotImageRequest[],
): Promise<string> {
  const r = await apiFetch("/agent-service/storyboard/images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shots }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 160);
    throw new Error(detail || `批量出图启动失败（${r.status}）`);
  }
  const data = (await r.json()) as { jobId?: string };
  if (!data.jobId) throw new Error("批量出图任务启动失败");
  return data.jobId;
}

export async function getShotImageJob(jobId: string): Promise<{
  status: "running" | "done";
  images: ShotImageResult[];
}> {
  const r = await apiFetch(`/agent-service/storyboard/images/${jobId}`);
  if (!r.ok) throw new Error(`出图任务查询失败（${r.status}）`);
  return (await r.json()) as { status: "running" | "done"; images: ShotImageResult[] };
}

/** 资产设定图生成：复用批量出图任务通道，按资产类型定幅面与布局。 */
export async function startCharacterImageJob(opts: {
  rid: string;
  name: string;
  description: string;
  assetType?: "character" | "scene" | "prop";
  visualNotes?: string;
}): Promise<string> {
  return startShotImageJob([{ ...opts, assetType: opts.assetType ?? "character" }]);
}
