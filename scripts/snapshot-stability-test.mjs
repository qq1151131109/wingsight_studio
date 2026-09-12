/**
 * 快照稳定纯函数回归（lib/chat/snapshotStability.ts）：
 *  1. id 对齐——流式 id 与快照 id 不同源时，同内容消息沿用本地 id
 *  2. 瞬时回插——reasoning / progress_* 不在快照时按锚点放回；尾部瞬时追加
 *  3. 守卫——首条 user 不一致（线程切换）原样放行；空本地放行
 *  4. 入站过滤——reasoning 不回传服务端
 *  5. 不变性——同签名消息不重复认领（两条相同空 assistant 不串 id）
 * 运行：pnpm dlx tsx scripts/snapshot-stability-test.mjs（纯函数无 LLM）
 */
import { stabilizeSnapshotMessages, restoreServerMessageIds } from "../lib/chat/snapshotStability.ts";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const user = (id, text) => ({ id, role: "user", content: text });
const ai = (id, text, calls) => ({ id, role: "assistant", content: text, ...(calls ? { toolCalls: calls } : {}) });
const tool = (id, callId, text) => ({ id, role: "tool", toolCallId: callId, content: text });
const reasoning = (id, text) => ({ id, role: "reasoning", content: text });
const progress = (id, text) => ({ id, role: "assistant", content: text });

// ---------- 1. id 对齐 ----------
{
  const local = [
    user("u1", "拆剧本"),
    reasoning("r1", "先查画布"),
    ai("lc_run--AAA", "我先看一下画布。", [{ id: "call_00_x", function: { name: "canvas_query" } }]),
    tool("t1", "call_00_x", "命中 3 个节点"),
  ];
  // 服务端快照：同内容不同 id（lc_run--BBB / 状态 id）
  const snap = [
    user("u1", "拆剧本"),
    ai("lc_run--BBB", "我先看一下画布。", [{ id: "call_00_x", function: { name: "canvas_query" } }]),
    tool("t9", "call_00_x", "命中 3 个节点"),
  ];
  const out = stabilizeSnapshotMessages(local, snap);
  const gotAi = out.find((m) => m.role === "assistant" && m.content === "我先看一下画布。");
  const gotTool = out.find((m) => m.role === "tool");
  check("A1 id 对齐：assistant 沿用本地 id", gotAi?.id === "lc_run--AAA", `got ${gotAi?.id}`);
  check("A2 id 对齐：tool 沿用本地 id", gotTool?.id === "t1", `got ${gotTool?.id}`);
  check("A3 内容不变", gotAi?.toolCalls?.[0]?.id === "call_00_x" && gotTool?.toolCallId === "call_00_x");
}

// ---------- 2. 瞬时回插 ----------
{
  const local = [
    user("u1", "拆剧本"),
    reasoning("r1", "先查画布"),
    ai("a1", "看画布中。"),
    reasoning("r2", "第二次思考"),
    progress("progress_x1", "📋 后台任务完成"),
    ai("a2", "查完了，共 3 张卡。"),
  ];
  const snap = [user("u1", "拆剧本"), ai("a1", "看画布中。"), ai("a2", "查完了，共 3 张卡。")];
  const out = stabilizeSnapshotMessages(local, snap);
  const ids = out.map((m) => m.id);
  check("B1 reasoning r1 按锚点插回 a1 前", ids.indexOf("r1") === 1 && ids.indexOf("r1") < ids.indexOf("a1"), JSON.stringify(ids));
  check("B2 reasoning r2 + progress 按锚点插回 a2 前", ids.indexOf("r2") === 3 && ids.indexOf("progress_x1") === 4 && ids.indexOf("a2") === 5, JSON.stringify(ids));
  check("B3 顺序保持 r2 在 progress 前", ids.indexOf("r2") < ids.indexOf("progress_x1"));
}
{
  // 尾部瞬时（流式中，快照先到）：追加到末尾不丢
  const local = [user("u1", "问"), ai("a1", "答一"), reasoning("r_live", "正在想第二步")];
  const snap = [user("u1", "问"), ai("a1", "答一")];
  const out = stabilizeSnapshotMessages(local, snap);
  check("B4 尾部瞬时追加到末尾", out.length === 3 && out[2].id === "r_live");
}
{
  // 服务端补进的 reasoning（ag_ui_langgraph 已含）：不重复插
  const local = [user("u1", "问"), reasoning("r1", "思考"), ai("a1", "答")];
  const snap = [user("u1", "问"), reasoning("r1", "思考"), ai("a1", "答")];
  const out = stabilizeSnapshotMessages(local, snap);
  check("B5 快照已含瞬时时不重复", out.filter((m) => m.id === "r1").length === 1);
}

// ---------- 3. 守卫 ----------
{
  const local = [user("u1", "旧会话的第一句"), ai("a1", "旧回答")];
  const snap = [user("u2", "新会话的第一句"), ai("a2", "新回答")];
  const out = stabilizeSnapshotMessages(local, snap);
  check("C1 跨会话（首 user 不一致）原样放行", out === snap);
  check("C2 空本地放行", stabilizeSnapshotMessages([], snap) === snap);
}

// ---------- 4. 出站 id 还原（服务端按 id 合并历史，本地 id 会被当新消息重复插入 → DeepSeek 400） ----------
{
  const local = [
    user("u1", "问"),
    reasoning("r1", "思考"),
    ai("lc_run--AAA", "回答", [{ id: "call_00_x", function: { name: "canvas_query" } }]),
    tool("t1", "call_00_x", "结果"),
  ];
  const snap = [
    user("u1", "问"),
    reasoning("r1", "思考"),
    ai("state_id_1", "回答", [{ id: "call_00_x", function: { name: "canvas_query" } }]),
    tool("state_t9", "call_00_x", "结果"),
  ];
  const idMap = new Map();
  stabilizeSnapshotMessages(local, snap, idMap);
  check("D1 对齐命中记 localId→serverId", idMap.get("lc_run--AAA") === "state_id_1" && idMap.get("t1") === "state_t9", JSON.stringify([...idMap]));
  const outbound = restoreServerMessageIds(local, idMap);
  const outAi = outbound.find((m) => m.content === "回答");
  const outTool = outbound.find((m) => m.role === "tool");
  check("D2 出站还原 assistant id", outAi?.id === "state_id_1", `got ${outAi?.id}`);
  check("D3 出站还原 tool id", outTool?.id === "state_t9", `got ${outTool?.id}`);
  check("D4 reasoning 原样回传（服务端靠它重建 reasoning_content，DeepSeek 硬要求）", outbound.some((m) => m.id === "r1" && m.role === "reasoning"));
  check("D5 progress 播报不回传（无 reasoning 的 assistant 历史 → DeepSeek 400）", !restoreServerMessageIds([progress("progress_new", "播报")], idMap).some((m) => m.id === "progress_new"));
  check("D6 未见过的普通 id 原样放行", restoreServerMessageIds([user("u_new", "新问")], idMap)[0].id === "u_new");
}

// ---------- 5. 不重复认领 ----------
{
  const local = [
    user("u1", "问"),
    ai("a1", "", []), // 两条同签名的空 assistant
    ai("a2", "", []),
  ];
  const snap = [user("u1", "问"), ai("s1", "", []), ai("s2", "", [])];
  const out = stabilizeSnapshotMessages(local, snap);
  const ids = out.map((m) => m.id).sort();
  check("E1 同签名不重复认领（a1/a2 各归其位）", ids.join() === ["a1", "a2", "u1"].sort().join(), JSON.stringify(ids));
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? `\n全部通过（${results.length} 项）` : `\n${failed.length} 项失败`);
process.exit(failed.length === 0 ? 0 : 1);
