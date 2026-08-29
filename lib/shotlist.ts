/** 分镜表生成 API：shotlist 卡一键生成（剧本 → rows）。
 *  链路：前端 → 同源代理 /agent-service → agent /storyboard/generate
 *  → langflow「分镜表生成」flow（agent/flows/shotlist-generate.json）。 */
import { apiFetch } from "@/lib/auth";
import type { ShotRow } from "@/lib/canvas/store";

export async function generateShotlist(
  script: string,
  opts?: { shotCount?: number; durationSeconds?: number },
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
