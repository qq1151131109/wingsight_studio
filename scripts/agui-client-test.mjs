/**
 * 集成测试：@ag-ui/client 0.0.57 HttpAgent × wingsight-agent 全链路两轮工具调用。
 * 按 CopilotKit 真实行为驱动：agent.addMessage() 管理历史，await agent.runAgent()。
 */
import { HttpAgent, EventType } from "@ag-ui/client";

const agent = new HttpAgent({ url: "http://127.0.0.1:8123" });
const threadId = `itest-${Date.now()}`;

const tools = [{
  name: "canvas_ops",
  description:
    "操作无限画布。ops 是操作数组，每个元素必须带 op 字段标明操作类型（缺 op 的操作会被拒绝）。" +
    '示例：{op:"add_node",nodeType:"script|character",title,body} / {op:"connect_nodes",fromId,toId}',
  parameters: {
    type: "object",
    properties: { ops: { type: "array", items: { type: "object" } } },
    required: ["ops"],
  },
}];

const seenTypes = [];
let text = "";
const toolCalls = new Map();

agent.subscribe({
  onEvent: ({ event }) => {
    seenTypes.push(event.type);
    if (event.type === EventType.TEXT_MESSAGE_CONTENT) text += event.delta;
    if (event.type === EventType.TOOL_CALL_START)
      toolCalls.set(event.toolCallId, { name: event.toolCallName, args: "" });
    if (event.type === EventType.TOOL_CALL_ARGS) {
      const tc = toolCalls.get(event.toolCallId);
      if (tc) tc.args += event.delta;
    }
  },
});

function snapshot(label) {
  console.log(`—— ${label} ——`);
  console.log("事件类型:", [...new Set(seenTypes)].join(" "));
  console.log("文字:", text || "（无）");
  for (const [id, tc] of toolCalls)
    console.log(`工具 ${tc.name}(${id.slice(0, 24)}…):`, tc.args.slice(0, 260));
  console.log("客户端消息历史:", agent.messages.map((m) => m.role).join(" → "));
}

function reset() {
  seenTypes.length = 0;
  text = "";
  toolCalls.clear();
}

async function run() {
  await agent.runAgent({
    threadId,
    tools,
    state: { canvasSummary: agent.canvasSummary },
    context: [],
    forwardedProps: {},
  });
}

// —— 第 1 轮 ——
agent.addMessage({
  id: "u1",
  role: "user",
  content: "建一个剧本卡《雨夜追凶》和一个角色卡：侦探老陈，然后把角色连到剧本上",
});
agent.canvasSummary = "（画布为空）";
await run();
snapshot("第 1 轮");

if (toolCalls.size === 0) {
  console.log("✗ 模型未调用工具");
  process.exit(1);
}

// —— 模拟浏览器执行 canvas_ops（与前端 normalizeOps 同契约：缺 op 硬拒并把错误回传）——
const [tcId, tc] = [...toolCalls.entries()][0];
const rawOps = JSON.parse(tc.args).ops;
const badIdx = rawOps
  .map((o, i) => (typeof o?.op !== "string" ? i : -1))
  .filter((i) => i >= 0);
const ops = rawOps.filter((o) => typeof o?.op === "string");
let n = 0;
const createdIds = [];
for (const op of ops)
  if (op.op === "add_node") createdIds.push({ id: `n_itest_${++n}`, op });
const errors = badIdx.map((i) => `#${i}: 缺少 op 字段`);

agent.addMessage({
  id: `tr_${Date.now()}`,
  role: "tool",
  content: JSON.stringify({
    applied: errors.length ? 0 : ops.length,
    createdIds: errors.length ? [] : createdIds.map((c) => c.id),
    errors,
  }),
  toolCallId: tcId,
});

// —— 第 2 轮 ——
reset();
agent.canvasSummary = createdIds
  .map((c) => `- ${c.id} [${c.op.nodeType}] ${c.op.title}`)
  .join("\n") || "（画布为空）";
await run();
snapshot("第 2 轮");

const added = ops.filter((o) => o.op === "add_node").length;
const connected = [...toolCalls.values()].some((t) =>
  t.args.includes("connect_nodes"),
);
console.log(
  connected
    ? `\n✓✓ 两轮闭环通过：新增 ${added} 卡 → ToolMessage 回传 → connect_nodes 续跑`
    : added >= 2
      ? `\n✓ 协议闭环通过（新增 ${added} 卡 + 工具结果回传正常），第 2 轮模型未连线（随机性）`
      : `\n△ 第 1 轮操作数量不足`,
);
process.exit(connected || added >= 2 ? 0 : 2);
