/**
 * E2E：参考图自动采纳闭环（2026-09-06「你帮我选啊」被拒 +「为啥没自动选」
 * 两事故的防回归）。
 * 建项目 + 种 1 张角色卡 → 聊天「给黄志恒找参考图」→ research_asset_
 * references（真调研约 2-4 分钟，轮询 batch 端点等完成）→ 断言：**调研完成
 * 即自动采纳 top-3 推荐**（DB 落 adopted，无需任何人手勾）→「每个资产多带
 * 几张，带 5 张」→ adopt_asset_references 补齐到 5 → 断言 DB adopted=5。
 * 运行：node scripts/ref-adopt-tool-test.mjs（需 agent 在跑；真跑 LLM+搜图约 5 分钟）
 */
import { HttpAgent, EventType } from "@ag-ui/client";
import fs from "node:fs";

const BASE = "http://127.0.0.1:8123";
const AUTH_PASSWORD = fs
  .readFileSync(".env.local", "utf8")
  .match(/^AUTH_PASSWORD=(.*)$/m)?.[1]?.trim();

const form = new URLSearchParams({ username: "admin", password: AUTH_PASSWORD });
const TOKEN = (await (await fetch(`${BASE}/api/v1/auth/token`, { method: "POST", body: form })).json())
  .access_token;
const H = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

const threadId = Date.now().toString(16).padStart(12, "0");
const agent = new HttpAgent({ url: BASE, threadId });
const proj = await (
  await fetch(`${BASE}/projects`, { method: "POST", headers: H, body: JSON.stringify({ name: `e2e-adopt-${Date.now() % 100000}` }) })
).json();
const pid = proj.id ?? proj.project?.id;
await fetch(`${BASE}/projects/${pid}/threads`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ id: threadId, title: "参考采纳实测" }),
});
// 种画布：1 张角色卡（node id 固定，adopt 工具按它查候选）
const NODE_ID = "n_e2e_char_1";
await fetch(`${BASE}/projects/${pid}/canvas`, {
  method: "PUT",
  headers: H,
  body: JSON.stringify({
    nodes: [
      {
        id: NODE_ID,
        type: "character",
        position: { x: 0, y: 0 },
        data: { nodeType: "character", title: "黄志恒", body: "1985 年澳门八仙饭店案嫌疑人，五十岁上下男性。" },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 0.8 },
  }),
});
console.log("✓ 测试项目", pid, "角色卡", NODE_ID);

// SSE 事件流（agent/eventbus.py 常开通道）：订阅先于任务发起，断言终态
// 事件实时到达（TaskEvents 通知/自动续跑的信号源）
const sseEvents = [];
const sseAbort = new AbortController();
(async () => {
  try {
    const res = await fetch(`${BASE}/api/v1/events/stream`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: sseAbort.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try { sseEvents.push(JSON.parse(line.slice(6))); } catch { /* 残帧 */ }
      }
    }
  } catch { /* 结束时 abort */ }
})();

const frontendTools = [
  { name: "canvas_ops", description: "操作无限画布。", parameters: { type: "object", properties: { ops: { type: "array", items: { type: "object" } } }, required: ["ops"] } },
  { name: "canvas_query", description: "检索画布节点。", parameters: { type: "object", properties: { query: { type: "string" } }, required: [] } },
  { name: "read_node", description: "读取画布节点。", parameters: { type: "object", properties: { node_id: { type: "string" } }, required: ["node_id"] } },
  { name: "propose_plan", description: "展示执行计划。", parameters: { type: "object", properties: { title: { type: "string" }, steps: { type: "array", items: { type: "string" } } }, required: ["title", "steps"] } },
  { name: "update_plan", description: "计划打勾。", parameters: { type: "object", properties: { planId: { type: "string" }, step: { type: "number" } }, required: ["planId", "step"] } },
];

let text = "";
const toolCalls = new Map();
const toolOrder = [];
let seq = 0;
agent.subscribe({
  onEvent: ({ event }) => {
    if (event.type === EventType.TEXT_MESSAGE_CONTENT) text += event.delta;
    if (event.type === EventType.TOOL_CALL_START) {
      toolCalls.set(event.toolCallId, { name: event.toolCallName, args: "" });
      toolOrder.push(event.toolCallId);
      console.log(`    · 工具调用 ${event.toolCallName}`);
    }
    if (event.type === EventType.TOOL_CALL_ARGS) {
      const tc = toolCalls.get(event.toolCallId);
      if (tc) tc.args += event.delta;
    }
  },
});

async function respondFrontendTools() {
  const pending = toolOrder.filter((id) => !toolCalls.get(id).answered);
  for (const id of pending) {
    const tc = toolCalls.get(id);
    tc.answered = true;
    let result;
    if (tc.name === "canvas_ops") {
      let ops = [];
      try { ops = JSON.parse(tc.args).ops ?? []; } catch { /* 流式残片 */ }
      const adds = ops.filter((o) => o.op === "add_node");
      result = { applied: ops.length, createdIds: adds.map((o, i) => o.id ?? `n_probe_${++seq}_${i}`), errors: [] };
    } else if (tc.name === "canvas_query") {
      result = { nodes: [{ id: NODE_ID, nodeType: "character", title: "黄志恒" }] };
    } else if (tc.name === "read_node") {
      result = { title: "黄志恒", nodeType: "character", body: "1985 年澳门八仙饭店案嫌疑人。" };
    } else if (tc.name === "propose_plan") {
      result = `用户已确认计划（planId=p1）。按顺序执行，每完成一步调 update_plan 打勾。`;
    } else if (tc.name === "update_plan") {
      result = "已记录。继续。";
    } else {
      result = { ok: true };
    }
    agent.addMessage({ id: `tr_${Date.now()}_${++seq}`, role: "tool", content: JSON.stringify(result), toolCallId: id });
  }
  return pending.length > 0;
}

async function run(userContent, label, maxWaves = 8) {
  if (userContent) agent.addMessage({ id: `u_${Date.now()}`, role: "user", content: userContent });
  text = "";
  toolCalls.clear();
  toolOrder.length = 0;
  console.log(`—— ${label} ——`);
  for (let wave = 0; wave < maxWaves; wave++) {
    await agent.runAgent({ threadId, tools: frontendTools, state: { canvasSummary: `- ${NODE_ID} [角色] 黄志恒` }, context: [], forwardedProps: {} });
    if (!(await respondFrontendTools())) break;
  }
  console.log("  文字:", (text || "（无）").replace(/\n+/g, " ").slice(0, 220));
  return { text, calls: toolOrder.map((id) => toolCalls.get(id)) };
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

// 轮 1：发起参考图调研（真实搜图，后台串行；消息带真实节点 id——@ 引用
// 语义，真实前端本来就会传 id，别赌模型从摘要里挑对）
const r1 = await run(`给画布上的角色卡黄志恒（${NODE_ID}）做参考图考据调研，他是 1985 年澳门八仙饭店案的嫌疑人`, "轮1 发起考据");
const started = r1.calls.some((c) => c.name === "research_asset_references");
check("轮1 发起参考图调研", started, r1.calls.map((c) => c.name).join(","));

// 等调研完成并自动采纳：轮询候选端点直到出现 adopted——auto_adopt_top 在
// 终选后一次性落库（adopted>0 即全部落完），张数由终选 adopt_count 判断
// （1-3 张：一张够就一张、图间矛盾只取最可信，2026-09-12 起不再固定 3）。
// 不解析 agent 措辞取任务号（上一版靠「任务 ID：」正则，agent 说成 batch_id 就全盘脱锚）
let autoAdopted = 0;
let seenTotal = 0;
for (let i = 0; i < 120 && autoAdopted < 1; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const verify = await (await fetch(`${BASE}/projects/${pid}/refs/candidates?nodeId=${NODE_ID}`, { headers: H })).json().catch(() => null);
  const cands = verify?.candidates ?? verify ?? [];
  autoAdopted = cands.filter((c) => c.adopted).length;
  seenTotal = cands.length;
  if (i % 10 === 0) console.log(`    · adopted=${autoAdopted} total=${seenTotal}`);
}
check("完成即自动采纳（终选判张数 1-3）", autoAdopted >= 1 && autoAdopted <= 3, `adopted=${autoAdopted} / 候选 ${seenTotal} 张`);

// SSE 终态事件：事件发布在自动采纳之后（batch 状态翻转处），轮询可能先
// 看见 adopted，给事件几秒到达窗口
let refEvt = null;
for (let i = 0; i < 10 && !refEvt; i++) {
  refEvt = sseEvents.find((e) => e.kind === "ref_research" && e.project_id === pid && e.status === "done");
  if (!refEvt) await new Promise((r) => setTimeout(r, 1000));
}
check("SSE 终态事件实时到达", Boolean(refEvt), refEvt?.summary || `收到 ${sseEvents.length} 帧`);

// 轮 2：用户要调整张数 → adopt_asset_references 补齐到 5
const r2 = await run("参考图每个资产多带几张，黄志恒带 5 张", "轮2 调整到 5 张");
const adopted = r2.calls.find((c) => c.name === "adopt_asset_references");
check("轮2 调用采纳工具", Boolean(adopted), r2.calls.map((c) => c.name).join(","));
check("轮2 不再回绝", !/没有.{0,6}能力|不能替你|无法替你/.test(r2.text), r2.text.replace(/\n+/g, " ").slice(0, 100));

// DB 侧核实补齐到 5（总量语义：3 自动 + 2 补 = 5，不是 3+5=8）
const verify = await (await fetch(`${BASE}/projects/${pid}/refs/candidates?nodeId=${NODE_ID}`, { headers: H })).json();
const cands = verify.candidates ?? verify ?? [];
const adoptedCount = cands.filter((c) => c.adopted).length;
check("补齐到 5 张落库", adoptedCount >= 5 && adoptedCount <= 6, `${adoptedCount} 张 adopted（总量语义，不是叠加）`);

const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "✓✓ 参考自动采纳闭环通过" : "✗ 有环节未过"}（${results.filter((r) => r.ok).length}/${results.length}）`);
sseAbort.abort();
await fetch(`${BASE}/projects/${pid}`, { method: "DELETE", headers: H });
console.log("✓ 测试项目已删除");
process.exit(pass ? 0 : 1);
