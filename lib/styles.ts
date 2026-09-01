/** 我的画风 API：用户自建画风预设（名称 + 画风描述 + 可选封面）+ 从参考图反推。
 *  链路：前端 → 同源代理 /api/v1/* → agent /api/v1/styles（topics 同款前缀，/agent-service 映射的是 agent 根路径，不匹配）（CRUD 按用户隔离）；
 *  反推走画风反推 flow（gemini 视觉），异步任务轮询（同 prompt-optimize）。 */
import { apiFetch } from "@/lib/auth";

export interface MyStyle {
  id: string;
  name: string;
  /** 画风描述：选中 = 填进项目画风（projectStyle 自由文本） */
  prompt: string;
  /** 封面参考图（/agent-service/assets/…，可选） */
  coverUrl: string;
  createdAt: string;
  updatedAt: string;
}

export async function listMyStyles(): Promise<MyStyle[]> {
  const r = await apiFetch("/api/v1/styles");
  if (!r.ok) throw new Error(`画风列表加载失败（${r.status}）`);
  const data = (await r.json()) as { styles?: MyStyle[] };
  return data.styles ?? [];
}

export async function createMyStyle(opts: {
  name: string;
  prompt: string;
  coverUrl?: string;
}): Promise<MyStyle> {
  const r = await apiFetch("/api/v1/styles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 160) || `保存失败（${r.status}）`);
  const data = (await r.json()) as { style: MyStyle };
  return data.style;
}

export async function updateMyStyle(
  id: string,
  opts: { name?: string; prompt?: string; coverUrl?: string },
): Promise<MyStyle> {
  const r = await apiFetch(`/agent-service/styles/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 160) || `保存失败（${r.status}）`);
  const data = (await r.json()) as { style: MyStyle };
  return data.style;
}

export async function deleteMyStyle(id: string): Promise<void> {
  const r = await apiFetch(`/agent-service/styles/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`删除失败（${r.status}）`);
}

/** 从参考图反推画风描述（异步任务轮询；gemini 视觉可到数十秒） */
export async function reverseStyle(imageUrls: string[]): Promise<string> {
  const start = await apiFetch("/api/v1/styles/reverse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrls }),
  });
  if (!start.ok) {
    const detail = (await start.text()).slice(0, 160);
    throw new Error(detail || `反推任务启动失败（${start.status}）`);
  }
  const { jobId } = (await start.json()) as { jobId?: string };
  if (!jobId) throw new Error("反推任务启动失败");

  const deadline = Date.now() + 120 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await apiFetch(`/agent-service/styles/reverse/${jobId}`);
    if (!r.ok) throw new Error(`反推任务查询失败（${r.status}）`);
    const data = (await r.json()) as {
      status: "running" | "done";
      result?: string | null;
      error?: string | null;
    };
    if (data.status === "done") {
      if (data.error) throw new Error(data.error);
      return data.result ?? "";
    }
    if (Date.now() > deadline) throw new Error("画风反推超时，请重试");
  }
}
