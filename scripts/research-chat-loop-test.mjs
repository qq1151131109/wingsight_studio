/**
 * 深度调研聊天链路实测：真实 LangGraph 主循环多轮驱动。
 * 轮1「帮我调研X」→ start_deep_research(后端) + 讲开题；
 * 轮2「直接开始」→ confirm_research_plan(后端)；
 * 轮3 → canvas_ops 建调研卡（前端工具，客户端模拟执行回传）；
 * 轮4「调研怎么样了」→ get_research_result 报进行中。
 * 运行：node scripts/research-chat-loop-test.mjs（需 agent 在跑）
 */
import { HttpAgent, EventType } from "@ag-ui/client";
import fs from "node:fs";

const BASE = "http://127.0.0.1:8123";
const AUTH_PASSWORD = fs
  .readFileSync(".env.local", "utf8")
  .match(/^AUTH_PASSWORD=(.*)$/m)?.[1]?.trim();

// 登录 + 建测试项目 + 绑定 thread（真实前端在建会话时同款契约）
const form = new URLSearchParams({ username: "admin", password: AUTH_PASSWORD });
const login = await fetch(`${BASE}/api/v1/auth/token`, { method: "POST", body: form });
const TOKEN = (await login.json()).access_token;

const threadId = Date.now().toString(16).padStart(12, "r").replace(/r/g, "a"); // hex 契约
const agent = new HttpAgent({ url: BASE, threadId });
{
  const proj = await fetch(`${BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ name: `聊天实测-${Date.now() % 100000}` }),
  }).then((r) => r.json());
  const pid = proj.id ?? proj.project?.id;
  await fetch(`${BASE}/projects/${pid}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ id: threadId, title: "调研链路实测" }),
  });
  console.log("✓ 测试项目", pid, "已绑定 thread", threadId.slice(0, 24));
}

const frontendTools = [
  {
    name: "canvas_ops",
    description: "操作无限画布。ops 数组，元素带 op 字段（add_node/connect_nodes/update_node 等）。",
    parameters: {
      type: "object",
      properties: { ops: { type: "array", items: { type: "object" } } },
      required: ["ops"],
    },
  },
  {
    name: "read_node",
    description: "读取画布节点内容。",
    parameters: { type: "object", properties: { node_id: { type: "string" } }, required: ["node_id"] },
  },
];

let text = "";
const toolCalls = new Map();
const toolOrder = [];

agent.subscribe({
  onEvent: ({ event }) => {
    if (event.type === EventType.TEXT_MESSAGE_CONTENT) text += event.delta;
    if (event.type === EventType.TOOL_CALL_START) {
      toolCalls.set(event.toolCallId, { name: event.toolCallName, args: "" });
      toolOrder.push(event.toolCallId);
    }
    if (event.type === EventType.TOOL_CALL_ARGS) {
      const tc = toolCalls.get(event.toolCallId);
      if (tc) tc.args += event.delta;
    }
  },
});

const runs = [];
async function run(userContent, label) {
  if (userContent)
    agent.addMessage({ id: `u_${Date.now()}`, role: "user", content: userContent });
  text = "";
  toolCalls.clear();
  toolOrder.length = 0;
  await agent.runAgent({
    threadId,
    tools: frontendTools,
    state: { canvasSummary: agent.canvasSummary },
    context: [],
    forwardedProps: {},
  });
  runs.push(label);
  console.log(`—— ${label} ——`);
  console.log("  工具:", toolOrder.map((id) => toolCalls.get(id).name).join(", ") || "（无）");
  console.log("  文字:", (text || "（无）").replace(/\n+/g, " ").slice(0, 300));
  return { text, calls: toolOrder.map((id) => toolCalls.get(id)) };
}

async function main() {
  agent.canvasSummary = "（画布为空）";

  // 轮 1：发起调研（后端工具 start_deep_research 会被服务端执行并返回开题）
  const r1 = await run("帮我调研一下曾侯乙编钟的发现经过，快查就行", "轮1 发起");
  const started = r1.calls.some((c) => c.name === "start_deep_research");
  const planShown = r1.text.includes("观看问题") || /方向|查证|开题/.test(r1.text);
  console.log(started ? "  ✓ start_deep_research 被调用" : "  ✗ 未调用 start_deep_research");
  console.log(planShown ? "  ✓ 开题已讲给用户" : "  ✗ 开题未呈现");
  if (!started) process.exit(1);

  // 轮 2：确认
  const r2 = await run("直接开始吧，不用再问我", "轮2 确认");
  const confirmed = r2.calls.some((c) => c.name === "confirm_research_plan");
  console.log(confirmed ? "  ✓ confirm_research_plan 被调用" : "  ✗ 未确认");
  if (!confirmed) process.exit(1);

  // 轮 3：建调研卡（前端工具——模拟浏览器执行）
  const r3 = await run("好", "轮3 建卡");
  const cardOp = r3.calls.find((c) => c.name === "canvas_ops");
  let researchCardId = null;
  let researchJobId = null;
  if (cardOp) {
    const ops = JSON.parse(cardOp.args).ops;
    const add = ops.find((o) => o.op === "add_node" && o.nodeType === "research");
    if (add) {
      researchJobId = add.researchId;
      researchCardId = `n_itest_research_1`;
      agent.canvasSummary = `- ${researchCardId} [调研] ${add.title}`;
    }
  }
  if (cardOp && researchJobId) {
    agent.addMessage({
      id: `tr_${Date.now()}`,
      role: "tool",
      content: JSON.stringify({ applied: 1, createdIds: [researchCardId], errors: [] }),
      toolCallId: toolOrder.find((id) => toolCalls.get(id).name === "canvas_ops"),
    });
    console.log(`  ✓ 调研卡建立（researchId=${researchJobId}）`);
  } else {
    console.log("  △ 第 3 轮未建调研卡（模型可能在等下一轮指令）");
  }

  // 轮 4：查进度
  const r4 = await run("调研现在怎么样了？", "轮4 进度");
  const asked = r4.calls.some((c) => c.name === "get_research_result");
  const progressText = /进行中|第 \d 轮|正在/.test(r4.text);
  console.log(asked ? "  ✓ get_research_result 被调用" : "  ✗ 未查进度");
  console.log(progressText ? "  ✓ 进度已播报" : "  △ 进度表述未命中预期句式");

  const pass = started && confirmed && asked;
  console.log(pass ? "\n✓✓ 聊天链路实测通过（发起→确认→进度）" : "\n✗ 聊天链路有环节未过");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
