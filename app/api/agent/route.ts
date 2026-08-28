/**
 * AG-UI ↔ Langflow 网关
 *
 * CopilotKit 的 HttpAgent 发标准 AG-UI RunAgentInput（POST），而 langflow
 * v2 workflow 端点吃自己的 WorkflowRunRequest。本网关做最小转换：
 *   - 最后一条 user 消息 → input_value
 *   - threadId → session_id（复用 langflow 会话记忆）
 *   - 注入 flow_id 与 API key（key 不下发到浏览器）
 *   - langflow 的 AG-UI SSE 事件流原样透传回客户端
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LANGFLOW_URL = process.env.LANGFLOW_URL ?? "http://localhost:7860";
const LANGFLOW_API_KEY = process.env.LANGFLOW_API_KEY ?? "";
const LANGFLOW_FLOW_ID = process.env.LANGFLOW_FLOW_ID ?? "";

interface AguiMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }>;
}

function extractInputValue(body: Record<string, unknown>): string {
  const messages = (body.messages as AguiMessage[] | undefined) ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  const content = lastUser.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

export async function POST(req: Request) {
  if (!LANGFLOW_FLOW_ID) {
    return Response.json(
      { error: "未配置 LANGFLOW_FLOW_ID：请在 .env.local 里填写要对话的 langflow flow UUID" },
      { status: 500 },
    );
  }

  let aguiBody: Record<string, unknown>;
  try {
    aguiBody = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const input_value = extractInputValue(aguiBody);
  const threadId = typeof aguiBody.threadId === "string" ? aguiBody.threadId : undefined;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (LANGFLOW_API_KEY) headers["x-api-key"] = LANGFLOW_API_KEY;

  let upstream: Response;
  try {
    upstream = await fetch(`${LANGFLOW_URL}/api/v2/workflows`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        flow_id: LANGFLOW_FLOW_ID,
        input_value,
        session_id: threadId,
        mode: "stream",
        stream_protocol: "agui",
      }),
    });
  } catch (exc) {
    return Response.json({ error: `连不上 langflow（${LANGFLOW_URL}）：${exc}` }, { status: 502 });
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    return Response.json(
      { error: `langflow 返回 ${upstream.status}：${detail.slice(0, 500)}` },
      { status: upstream.status },
    );
  }
  if (!upstream.body) {
    return Response.json({ error: "langflow 未返回事件流" }, { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function GET() {
  // AG-UI 客户端偶尔探测端点；langflow 无 per-agent info 语义，回 204 即可
  return new Response(null, { status: 204 });
}
