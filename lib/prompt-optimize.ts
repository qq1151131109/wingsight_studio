/** 提示词 AI 辅助 API：面板 ✦ 双态按钮（优化扩写 / 看图反推），mode 由前端
 *  按按钮态显式路由到各自 flow。直连不经聊天；产物回填面板输入框草稿，
 *  用户确认后随「生成」才落卡。链路：前端 → /agent-service → agent
 *  /prompt/optimize（异步任务）→ langflow flow（文本按卡片选择路由 / gemini 视觉）。 */
import { apiFetch } from "@/lib/auth";

export async function optimizePrompt(opts: {
  /** optimize=优化扩写（prompt 必填）；reversal=看图反推（imageUrls 必填） */
  mode: "optimize" | "reversal";
  /** 当前提示词（optimize 态必填） */
  prompt: string;
  /** 参考图 URL（卡上当前图 / @引用与连线的资产设定图）；reversal 态必填 */
  imageUrls: string[];
  /** 上下文设定（引用卡描述、画风等），AI 必须遵守 */
  contextNotes: string;
}): Promise<string> {
  const start = await apiFetch("/agent-service/prompt/optimize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!start.ok) {
    const detail = (await start.text()).slice(0, 160);
    throw new Error(detail || `任务启动失败（${start.status}）`);
  }
  const { jobId } = (await start.json()) as { jobId?: string };
  if (!jobId) throw new Error("任务启动失败");

  // 异步轮询（视觉模型看图可到数十秒，代理 30s 掐断长请求）
  const deadline = Date.now() + 120 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await apiFetch(`/agent-service/prompt/optimize/${jobId}`);
    if (!r.ok) throw new Error(`任务查询失败（${r.status}）`);
    const data = (await r.json()) as {
      status: "running" | "done";
      result?: string | null;
      error?: string | null;
    };
    if (data.status === "done") {
      if (data.error) throw new Error(data.error);
      return data.result ?? "";
    }
    if (Date.now() > deadline) throw new Error("AI 辅助超时，请重试");
  }
}
