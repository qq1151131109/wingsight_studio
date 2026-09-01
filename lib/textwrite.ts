/** 文本撰写/改写 API：画布文本卡/剧本卡底部输入条的直连管线。卡片级模型
 *  （data.textModel）在此生效——不经聊天主循环（AGENT_MODEL 与卡片选择无关）。
 *  链路：前端 → /agent-service → agent /text/rewrite（异步任务）→ langflow
 *  「文本撰写」flow（正文+指令+参考上下文 → 处理后全文）。 */
import { apiFetch } from "@/lib/auth";

export async function rewriteText(opts: {
  /** 必填：对正文执行的指令（续写/改写/润色/摘要/翻译/自由指令） */
  instruction: string;
  /** 当前正文；空 = 直接按指令创作 */
  body: string;
  /** 参考上下文（引用卡/上游内容的拼装文本），AI 必须遵守 */
  context?: string;
  /** 卡片级文本模型 id（data.textModel）；空 = 出厂默认 */
  model?: string;
}): Promise<string> {
  const start = await apiFetch("/agent-service/text/rewrite", {
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

  // 异步轮询（长文改写可到数十秒，代理 30s 掐断长请求）
  const deadline = Date.now() + 180 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await apiFetch(`/agent-service/text/rewrite/${jobId}`);
    if (!r.ok) throw new Error(`任务查询失败（${r.status}）`);
    const data = (await r.json()) as {
      status: "running" | "done";
      result?: string | null;
      error?: string | null;
    };
    if (data.status === "done") {
      if (data.error) throw new Error(data.error);
      return (data.result ?? "").trim();
    }
    if (Date.now() > deadline) throw new Error("文本生成超时，请重试");
  }
}
