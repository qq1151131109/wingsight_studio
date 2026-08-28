/**
 * E2E：剧本 → 剧本卡上画布 → 拆解 → 资产卡 + 连回剧本卡。
 * 模拟浏览器行为：每轮 canvas_ops 执行后回传 ToolMessage，自动续跑到完成。
 */
import { HttpAgent, EventType } from "@ag-ui/client";

const agent = new HttpAgent({ url: "http://127.0.0.1:8123" });
const threadId = `script-canvas-${Date.now()}`;
const tools = [{
  name: "canvas_ops",
  description: "操作无限画布。ops 是操作数组",
  parameters: { type: "object", properties: { ops: { type: "array", items: { type: "object" } } }, required: ["ops"] },
}];

const canvas = { nodes: [], edges: [] }; // 模拟画布状态
let text = "";
const toolCalls = new Map();
const log = [];

agent.subscribe({
  onEvent: ({ event }) => {
    if (event.type === EventType.TEXT_MESSAGE_CONTENT) text += event.delta;
    if (event.type === EventType.TOOL_CALL_START) toolCalls.set(event.toolCallId, { name: event.toolCallName, args: "" });
    if (event.type === EventType.TOOL_CALL_ARGS) { const c = toolCalls.get(event.toolCallId); if (c) c.args += event.delta; }
  },
});

async function round() {
  text = ""; toolCalls.clear();
  await agent.runAgent({ threadId, tools, state: { canvasSummary: summarize() }, context: [], forwardedProps: {} });
  return [...toolCalls.entries()].filter(([, c]) => c.name === "canvas_ops");
}

function summarize() {
  if (canvas.nodes.length === 0) return "（画布为空）";
  const lines = canvas.nodes.map((n) => `- ${n.id} [${n.type}] ${n.title}`);
  for (const e of canvas.edges) lines.push(`- 连线 ${e.from} → ${e.to}`);
  return lines.join("\n");
}

/** 模拟浏览器执行 canvas_ops */
function execute(ops) {
  const createdIds = [];
  for (const op of ops) {
    if (op.op === "add_node") {
      const id = `n_sim_${canvas.nodes.length + 1}`;
      canvas.nodes.push({ id, type: op.nodeType, title: op.title || "" });
      createdIds.push(id);
    } else if (op.op === "connect_nodes") {
      canvas.edges.push({ from: op.fromId, to: op.toId });
    }
  }
  return { applied: ops.length, createdIds, errors: [] };
}

const SCRIPT = "雨夜。老式茶馆里，侦探老陈对着一份泛黄的名单抽烟。门帘掀开，穿红雨衣的少女小林走进来，手里攥着一把生锈的铜钥匙。茶馆掌柜在柜台后擦一只青瓷茶碗。";

agent.addMessage({ id: "u1", role: "user", content: `帮我把这个剧本变成画布上的资产结构：${SCRIPT}` });

for (let i = 1; i <= 6; i++) {
  const pending = await round();
  log.push(`R${i}: 工具[${[...toolCalls.values()].map((c) => c.name).join(",") || "无"}] ${text.slice(0, 60)}`);
  if (pending.length === 0) break; // 无画布操作 → 完成
  for (const [tcId, tc] of pending) {
    const ops = JSON.parse(tc.args).ops;
    const result = execute(ops);
    agent.addMessage({ id: `tr_${i}_${tcId.slice(-6)}`, role: "tool", content: JSON.stringify(result), toolCallId: tcId });
  }
}

console.log("=== 各轮记录 ===");
for (const l of log) console.log(l);
console.log("=== 画布最终状态 ===");
console.log("节点:", canvas.nodes.map((n) => `${n.id}[${n.type}]${n.title.slice(0, 10)}`).join(" | "));
console.log("连线:", canvas.edges.map((e) => `${e.from}→${e.to}`).join(" | "));
const scriptNode = canvas.nodes.find((n) => n.type === "script");
const connected = scriptNode ? canvas.edges.filter((e) => e.from === scriptNode.id || e.to === scriptNode.id).length : 0;
console.log(
  scriptNode && canvas.nodes.length >= 6 && connected >= 5
    ? `\n✓✓ 通过：剧本卡已上画布，${canvas.nodes.length - 1} 张资产卡，${connected} 条连线挂到剧本卡`
    : `\n✗ 未达预期（剧本卡:${!!scriptNode} 节点数:${canvas.nodes.length} 连线:${connected}）`,
);
process.exit(scriptNode && canvas.nodes.length >= 6 && connected >= 5 ? 0 : 2);
