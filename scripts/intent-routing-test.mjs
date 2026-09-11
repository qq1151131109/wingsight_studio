/**
 * E2E：意图路由回归（会话行为场景组，改宪法前后各跑一遍）。
 * S1 只上传成品剧本、零指令 → 问清意图且问句带默认推荐（「我默认按标准链
 *    做，可只做前几步」），绝不发起调研（八仙饭店 2df41a741460 事故）。
 * S2 「上面是剧本，直接开始制作吧」→ 标准链：read_skill script-to-assets
 *    → 建 script 卡 → 拆资产（四类正经卡型，无 note 前缀）→ 分镜表落地。
 * S3 资产上下文里「走调研了吗」→ 问一句或走 research_asset_references，
 *    绝不抢答 start_deep_research（a768423e2069 事故：调研二义性）。
 * S4 「帮我调研X」受理开题后「算了别调研了，直接建剧本卡」→ 不
 *    confirm_research_plan、按新指令 canvas_ops 建卡（改道不是确认）。
 * S5 「给资产做参考图考据调研」不点名范围 → research_asset_references
 *    一次带画布全部资产卡，不自挑「重点」子集（090602 事故：55 只调研 16）。
 * S6 「把资产考据这一站做掉」不点名走哪条 → 文字（考证大纲）与参考图
 *    （research_asset_references）**两条都发起**（091101 事故：只跑大纲，
 *    52 张卡文字考据全到、参考图 0 张，全片没有实物参考）。
 * 运行：node scripts/intent-routing-test.mjs（需 agent 在跑；真跑 LLM+拆解/分镜 flow 约 6-8 分钟）
 */
import { HttpAgent, EventType } from "@ag-ui/client";
import fs from "node:fs";

const BASE = "http://127.0.0.1:8123";
const AUTH_PASSWORD = fs
  .readFileSync(".env.local", "utf-8")
  .match(/^AUTH_PASSWORD=(.*)$/m)?.[1]?.trim();

const form = new URLSearchParams({ username: "admin", password: AUTH_PASSWORD });
const TOKEN = (await (await fetch(`${BASE}/api/v1/auth/token`, { method: "POST", body: form })).json())
  .access_token;
const H = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

const threadId = Date.now().toString(16).padStart(12, "0");
const agent = new HttpAgent({ url: BASE, threadId });
const proj = await (
  await fetch(`${BASE}/projects`, { method: "POST", headers: H, body: JSON.stringify({ name: `e2e-intent-${Date.now() % 100000}` }) })
).json();
const pid = proj.id ?? proj.project?.id;
await fetch(`${BASE}/projects/${pid}/threads`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ id: threadId, title: "意图路由实测" }),
});
console.log("✓ 测试项目", pid);

// —— 模拟前端工具（与 planCards/toolCards 的回传契约同款）——
const jsonSchema = (props, required) => ({
  type: "object",
  properties: props,
  required,
});
const frontendTools = [
  { name: "canvas_ops", description: "操作无限画布。ops 数组（add_node/connect_nodes/update_node 等）。", parameters: jsonSchema({ ops: { type: "array", items: { type: "object" } } }, ["ops"]) },
  { name: "canvas_query", description: "检索画布节点。", parameters: jsonSchema({ query: { type: "string" }, types: { type: "array", items: { type: "string" } } }, []) },
  { name: "canvas_validate_ops", description: "干跑校验 ops。", parameters: jsonSchema({ ops: { type: "array", items: { type: "object" } } }, ["ops"]) },
  { name: "read_node", description: "读取画布节点内容。", parameters: jsonSchema({ node_id: { type: "string" } }, ["node_id"]) },
  { name: "propose_plan", description: "把多步任务的执行计划展示给用户（展示后直接开始执行）。", parameters: jsonSchema({ title: { type: "string" }, steps: { type: "array", items: { type: "string" } } }, ["title", "steps"]) },
  { name: "update_plan", description: "计划每完成一步调用打勾。", parameters: jsonSchema({ planId: { type: "string" }, step: { type: "number" } }, ["planId", "step"]) },
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
      console.log(`    · 工具调用 ${event.toolCallName}`);
    }
    if (event.type === EventType.TOOL_CALL_ARGS) {
      const tc = toolCalls.get(event.toolCallId);
      if (tc) tc.args += event.delta;
    }
  },
});

let seq = 0;
// 模拟画布状态（跨轮一致）：canvas_ops 建的卡进 mockNodes，canvas_query
// 如实返回——此前 query 恒返空 + summary 只认剧本卡，画布「说谎」把 agent
// 搞糊涂（它诚实拒绝凭空补写），测的是路由不是画布所以别让它出戏
const mockNodes = [];
async function respondFrontendTools() {
  // 前端工具由 LangGraph 以 END 收敛等待回传（与浏览器同契约）——
  // 探针补工具结果进消息，返回是否有待答调用（有则外层续跑下一波）。
  // **只答前端工具**：后端工具（read_skill/decompose_script/generate_storyboard…）
  // 由服务端自己执行，浏览器没有它们的 handler——混发轮次里服务端 END 等前端，
  // 后端调用当轮不执行、下一轮由 sanitize 补「本轮未执行」占位；探针若也去
  // 答它们（旧版落到 else 分支回 {ok:true}），模型会把假结果当真
  //（「decompose_script 只返回了 ok」就是这么来的）。
  const isFrontend = (name) => frontendTools.some((t) => t.name === name);
  const pending = toolOrder.filter(
    (id) => !toolCalls.get(id).answered && isFrontend(toolCalls.get(id).name),
  );
  for (const id of pending) {
    const tc = toolCalls.get(id);
    tc.answered = true;
    let result;
    if (tc.name === "canvas_ops") {
      let ops = [];
      try { ops = JSON.parse(tc.args).ops ?? []; } catch { /* 流式残片 */ }
      // 保真：真实 applyOps 的 normalizeOps 拒绝缺 op 的操作（模型偶发把键
      // 写成 type），探针不校验就等于把错 op 当成功——模型一路错到底、
      // 断言才报「没执行」。这里照契约回错，模型下一轮能自纠
      const bad = ops.findIndex((o) => !o || typeof o.op !== "string");
      if (bad >= 0) {
        result = { applied: 0, createdIds: [], errors: [`#${bad}: 缺少 op 字段`] };
      } else {
        const adds = ops.filter((o) => o.op === "add_node");
        const createdIds = adds.map((o, i) => o.id ?? `n_probe_${++seq}_${i}`);
        for (const [i, o] of adds.entries()) {
          mockNodes.push({ id: createdIds[i], nodeType: o.nodeType ?? "note", title: o.title ?? "" });
        }
        result = { applied: ops.length, createdIds, errors: [] };
      }
      agent.canvasSummary = mockNodes
        .map((n) => `- ${n.id} [${n.nodeType}] ${n.title}`)
        .join("\n");
    } else if (tc.name === "canvas_query") {
      let nodes = mockNodes;
      try {
        const args = JSON.parse(tc.args || "{}");
        if (Array.isArray(args.types) && args.types.length) {
          nodes = mockNodes.filter((n) => args.types.includes(n.nodeType));
        }
      } catch { /* 流式残片 */ }
      result = { nodes };
    } else if (tc.name === "canvas_validate_ops") {
      result = { issues: [], errors: [] };
    } else if (tc.name === "read_node") {
      // 如实作答：mockNodes 里有的卡按卡答（S5 资产卡曾被谎报成剧本正文，
      // 模型被逼着往工具参数里塞「留意」说明、随后生成退化成 11 万字符垃圾）
      let id = "";
      try {
        id = (JSON.parse(tc.args || "{}").node_id ?? "").toString();
      } catch { /* 流式残片 */ }
      const mock = mockNodes.find((n) => n.id === id);
      result = mock
        ? { title: mock.title, nodeType: mock.nodeType, body: mock.body ?? `${mock.title}的设定正文（测试夹具）。` }
        : { title: "《南洋悬案》第一集：橡胶园双尸案", nodeType: "script", body: SCRIPT_BODY };
    } else if (tc.name === "propose_plan") {
      result = `用户已确认计划（planId=p1）。现在按顺序执行：每完成一步就调用 update_plan(planId="p1", step=步程序号) 打勾后再继续下一步；全部完成后简短汇报结果。`;
    } else if (tc.name === "update_plan") {
      result = `已记录：第 ${(JSON.parse(tc.args || "{}").step) ?? "?"} 步完成。继续执行下一步。`;
    } else {
      result = { ok: true };
    }
    agent.addMessage({
      id: `tr_${Date.now()}_${++seq}`,
      role: "tool",
      content: JSON.stringify(result),
      toolCallId: id,
    });
  }
  return pending.length > 0;
}

async function run(userContent, label, maxWaves = 30) {
  if (userContent)
    agent.addMessage({ id: `u_${Date.now()}`, role: "user", content: userContent });
  text = "";
  toolCalls.clear();
  toolOrder.length = 0;
  console.log(`—— ${label} ——`);
  let waves = 0;
  for (let wave = 0; wave < maxWaves; wave++) {
    waves += 1;
    await agent.runAgent({
      threadId,
      tools: frontendTools,
      state: { canvasSummary: agent.canvasSummary ?? "（画布为空）" },
      context: [],
      forwardedProps: {},
    });
    const continued = await respondFrontendTools();
    if (!continued) break;
  }
  // 波次打点：模型逐张 read_node 读资产详情时波次会涨——预算吃紧导致的
  // 「没轮到发起调研」是探针容量问题，不是行为退化（上限 8 时 S5 曾因此假红）
  console.log(`  （${waves}/${maxWaves} 波）`);
  console.log("  文字:", (text || "（无）").replace(/\n+/g, " ").slice(0, 260));
  return { text, calls: toolOrder.map((id) => toolCalls.get(id)) };
}

const SCRIPT_BODY = `《南洋悬案》第1集：橡胶园双尸案

全案事实权威来源：1947 年海峡殖民地验尸庭记录、《南洋商报》《星洲日报》当年连续报道、殖民地警察厅档案；全文剔除影视杜撰猎奇情节，所有叙事以官方记录为唯一依据。

第一段：开篇黄金 30 秒（强标题钩子）
【解说词】1.1、马来亚橡胶园里一夜双尸！园主夫妇双双陈尸晒场，头部创伤诡异一致；案件尘封七十年，唯一嫌疑人当庭释放，档案至今封存。本案的都市传说版本数不胜数，但多为艺术虚构。今天就让我们从验尸庭记录、当年报纸中揭开真实面目。
旁白同步镜头：30 秒
运镜：快速闪切，轻微手持晃动，复古胶片颗粒滤镜
全景：40 年代马来亚橡胶园清晨外景，雾气弥漫
特写：晒场上散落的胶杯，晨露未干`;

const SCRIPT_UPLOAD = `（见附件与引用的画布卡片）

附件：
- 文档「《南洋悬案》第一集：橡胶园双尸案.txt」内容：
<<<
${SCRIPT_BODY}
>>>`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

// —— 轮 1：只传剧本，零指令 ——
const r1 = await run(SCRIPT_UPLOAD, "轮1 只传剧本无指令");
const r1Names = r1.calls.map((c) => c.name);
check("轮1 不发起调研", !r1Names.includes("start_deep_research") && !r1Names.includes("confirm_research_plan"), r1Names.join(",") || "无工具");
check("轮1 问清意图", !r1Names.some((n) => n === "canvas_ops") && /[？?]|想让我|需要我|帮你|请告诉/.test(r1.text));
check("轮1 问题带默认推荐", /默认|建议|全流程/.test(r1.text), "问句应是「我默认按…做」而非开放式菜单");
check("轮1 真实题材问句提考据调研出口", /考据|参考图/.test(r1.text), "素材含卷宗/真实案信号，问句应顺带「出设定图前可先做资产参考图考据调研」——史实核查不算，用户指的调研是资产图考据");

// —— 轮 2：明确改道制作 ——
const r2 = await run("上面是剧本，直接开始制作吧", "轮2 直接开始制作");
const r2Names = r2.calls.map((c) => c.name);
check("轮2 不碰调研", !r2Names.includes("start_deep_research") && !r2Names.includes("confirm_research_plan"), r2Names.join(","));
const readSkill = r2.calls.find((c) => c.name === "read_skill");
const r2Ops = r2.calls
  .filter((c) => c.name === "canvas_ops")
  .flatMap((c) => {
    try { return JSON.parse(c.args).ops ?? []; } catch { return []; }
  });
const addNodes = r2Ops.filter((o) => o.op === "add_node");
const madeScriptCard = addNodes.some((o) => o.nodeType === "script");
check("轮2 走制作链", Boolean(readSkill && /script-to-assets/.test(readSkill.args)) || madeScriptCard || r2Names.includes("propose_plan"));
const assetAdds = addNodes.filter((o) => ["character", "scene", "prop", "costume"].includes(o.nodeType));
const prefixedNotes = addNodes.filter((o) => o.nodeType === "note" && /^(场景|道具|服饰)[:：]/.test(o.title ?? ""));
check("轮2 资产用正经卡型", assetAdds.length >= 3 && prefixedNotes.length === 0, `${assetAdds.length} 张四类卡，${prefixedNotes.length} 张前缀 note`);
const storyboardDone = r2Names.includes("generate_storyboard") || addNodes.some((o) => o.nodeType === "shotlist") || r2Ops.some((o) => o.op === "update_node" && Array.isArray(o.rows));
check("轮2 文字链跑到分镜表", storyboardDone, "标准链第三步 generate_storyboard/shotlist 应落地");
// 项目自有画布快照（轮2 模型自建的卡）：S5 的「全量」断言用它们。
// 换一组新 id 等于把画布掉包——模型按矛盾对质规则会停下问「和我建的对不上」，
// 夹具不能制造真实产品造不出的状态（同一项目画布是持久的）
const projectCanvas = mockNodes.map((n) => ({ ...n }));

// —— S3：调研二义（资产上下文里问「走调研了吗」）——
// a768423e2069 事故防回归：应问一句或走资产参考考据，不许抢答史实深度调研
// S3 换画布：八仙饭店资产在场（直接喂 summary + mockNodes 保持一致）
mockNodes.length = 0;
mockNodes.push(
  { id: "n_script_probe", nodeType: "script", title: "八仙饭店" },
  { id: "n_ch1", nodeType: "character", title: "黄志恒" },
  { id: "n_sc1", nodeType: "scene", title: "八仙饭店" },
);
agent.canvasSummary = "- n_script_probe [剧本] 八仙饭店\n- n_ch1 [角色] 黄志恒\n- n_sc1 [场景] 八仙饭店";
const r3 = await run("走调研了吗", "S3 调研二义");
const r3Names = r3.calls.map((c) => c.name);
check("S3 不抢答深度调研", !r3Names.includes("start_deep_research") && !r3Names.includes("confirm_research_plan"), r3Names.join(",") || "无工具");
// 「走调研了吗」是状态问句：事实作答（分清两种调研）= 对；直接问 = 对；走资产考据 = 对
const askedOrAssetRoute =
  r3Names.includes("research_asset_references") ||
  /[？?]/.test(r3.text) ||
  (/调研/.test(r3.text) && /深度|史实/.test(r3.text) && /资产|参考/.test(r3.text));
check("S3 作答分清两种调研", askedOrAssetRoute, "问一句/走资产考据/事实作答皆可");

// —— S4：改道（调研开题后用户改主意）——
const r4a = await run("帮我调研一下曾侯乙编钟的发现经过", "S4a 发起调研");
check("S4a 明确调研请求被受理", r4a.calls.map((c) => c.name).includes("start_deep_research"));
const r4b = await run("算了别调研了，直接建一张剧本卡，标题曾侯乙编钟", "S4b 用户改道");
const r4bNames = r4b.calls.map((c) => c.name);
check("S4b 不确认被放弃的调研", !r4bNames.includes("confirm_research_plan"), r4bNames.join(","));
const madeScript4 = r4b.calls.some((c) => {
  if (c.name !== "canvas_ops") return false;
  try {
    const ops = JSON.parse(c.args).ops ?? [];
    // add_node 直接带标题，或先建空卡再 update_node 补标题都算「执行了新指令」
    return (
      ops.some(
        (o) =>
          o.op === "add_node" &&
          o.nodeType === "script" &&
          (o.title ?? "").includes("曾侯乙编钟"),
      ) || ops.some((o) => o.op === "update_node" && (o.title ?? "").includes("曾侯乙编钟"))
    );
  } catch {
    return false;
  }
});
check(
  "S4b 改道执行新指令",
  madeScript4,
  madeScript4
    ? ""
    : `canvas_ops args: ${r4b.calls
        .filter((c) => c.name === "canvas_ops")
        .map((c) => c.args.slice(0, 200))
        .join(" || ") || "（无 canvas_ops 调用）"}`,
);

// —— S5：考据调研范围默认全量 ——
// 090602 事故防回归：画布 55 个资产 agent 只挑 16 个「重点」调研，用户以为
// 全做了。不点名范围时 research_asset_references 必须一次带上画布全部资产卡。
// 夹具 = 轮2 模型自建的画布（同项目持久画布的真实语义）：此前用另一组
// n_s5_* 节点掉包，模型按矛盾对质规则停下问「画布和我建的对不上」——
// 真实产品里画布是持久的，夹具不能制造不可能状态把模型带出戏。
mockNodes.length = 0;
mockNodes.push(...projectCanvas.map((n) => ({ ...n })));
agent.canvasSummary = mockNodes.map((n) => `- ${n.id} [${n.nodeType}] ${n.title}`).join("\n");
const s5Assets = mockNodes.filter((n) =>
  ["character", "scene", "prop", "costume"].includes(String(n.nodeType)),
);
const r5 = await run("好，给画布上的资产做参考图考据调研吧", "S5 调研范围全量");
const r5Research = r5.calls.filter((c) => c.name === "research_asset_references");
const r5Ids = new Set();
for (const c of r5Research) {
  // args 是 {"assets_json":"[\"node_id\":…]"} 的转义内嵌字符串——先反转义
  // 再按 node_id 键提取；宽容处理模型偶发的尾部说明文字（口径断言只关心覆盖面）
  const normalized = c.args.replace(/\\"/g, '"');
  for (const m of normalized.matchAll(/"node_id"\s*:\s*"([^"]+)"/g)) r5Ids.add(m[1]);
}
const wantIds = s5Assets.map((n) => n.id);
const allCovered = wantIds.length >= 3 && wantIds.every((id) => r5Ids.has(id));
check("S5 未点名范围 → 一次带全部资产", allCovered, `覆盖 ${wantIds.filter((id) => r5Ids.has(id)).length}/${wantIds.length}（${[...r5Ids].join(",")}；args 长度 ${r5Research.map((c) => c.args.length).join(",") || "无调用"}）——不许自挑「重点」子集`);

// —— S6：考据这一站两条都要走（091101 武则天项目事故防回归）——
// 事故形态：52 张卡的**文字**考据全到（考证大纲跑完），**参考图**候选 0 行——
// 手册当时把「考证大纲」与「参考图调研」写成二选一，agent 选了大纲后以为参考图
// 会自动跟上。现在两条是正交维度、都要发起；用户不点名走哪条时（「把资产考据
// 做掉」）两条都得动。S6 画布 = 一组资产卡（真实历史题材语境）。
mockNodes.length = 0;
mockNodes.push(
  { id: "n_script_wz", nodeType: "script", title: "《凤临天下—武则天》" },
  { id: "n_wz_char1", nodeType: "character", title: "武则天" },
  { id: "n_wz_char2", nodeType: "character", title: "王皇后" },
  { id: "n_wz_scene1", nodeType: "scene", title: "感业寺 大殿" },
  { id: "n_wz_prop1", nodeType: "prop", title: "茶盏" },
  { id: "n_wz_cost1", nodeType: "costume", title: "昭仪宫装" },
);
agent.canvasSummary = mockNodes.map((n) => `- ${n.id} [${n.nodeType}] ${n.title}`).join("\n");
const r6 = await run("画布上的资产卡都建好了，接着把资产考据这一站做掉", "S6 考据两条都走");
const r6Names = r6.calls.map((c) => c.name);
const r6Ref = r6Names.includes("research_asset_references");
const r6Text = r6Names.some((n) =>
  ["get_research_material", "propose_research_outline", "run_research_outline"].includes(n),
);
check(
  "S6 参考图那一路发起（research_asset_references）",
  r6Ref,
  `调用：${r6Names.join(",") || "无"}——只跑文字考据会让全片没有一张实物参考`,
);
check(
  "S6 文字那一路也发起（考证大纲）",
  r6Text,
  `调用：${r6Names.join(",") || "无"}——只跑参考图会漏掉年代形制的文字约束`,
);

const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "✓✓ 意图路由实测通过" : "✗ 意图路由有环节未过"}（${results.filter((r) => r.ok).length}/${results.length}）`);
await fetch(`${BASE}/projects/${pid}`, { method: "DELETE", headers: H });
console.log("✓ 测试项目已删除");
process.exit(pass ? 0 : 1);
