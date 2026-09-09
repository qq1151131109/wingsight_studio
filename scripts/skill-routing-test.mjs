/**
 * 回归：新搬运手册的自然语言触发（真实题材 / 拆镜自查 / 宣发）+ 新题材入口行为。
 * 四个场景各问一句自然语言（不点名技能）：
 *   R1「真实罪案题材想做纪录片，你打算怎么推进」→ read_skill real-documentary
 *   R2「分镜应该怎么切，有哪些自查规则」→ read_skill storyboard-director
 *   R3「帮这部片子规划抖音宣发文案」→ read_skill documentary-promotion
 *   R4「我想做一部关于敦煌藏经洞的历史纪录片」（只给题材的目标陈述，空画布；题面避开手册示例与历史测试句，考泛化不考背诵）
 *      → 入口行为：先读 real-documentary 的导览对话纪律，**不出方向清单**、
 *        反问意图、不建卡不出图（2026-09-08 090803 项目「直接输出方向菜单」事故回归）
 *   R5「我想拍一部古装短剧，还没想好具体拍什么」（非真实题材的开放性想法）
 *      → read_skill brainstorming，反问意图、批准前不动手（入口层另一半）
 *   R6「先给我列一批能拍的选题，越多越好」（探索委托）
 *      → 共创契约「先铺开再收敛」：候选给全（≥6 条）+ 带推荐 + 说明取舍 + 有来源
 * R1-R3 判据只看工具调用（read_skill 的入参）；R4/R5/R6 的行为本身就是回复措辞，
 * 措辞判据是概率性的，看失败形态。
 * 每场景独立 thread + 独立 HttpAgent（复用会串台，见 intent-routing 探针教训）。
 * 运行：node scripts/skill-routing-test.mjs（需 agent 在跑；真跑 LLM 约 5-6 分钟）
 */
import { HttpAgent, EventType } from "@ag-ui/client";
import fs from "node:fs";

const BASE = "http://127.0.0.1:8123";
const AUTH_PASSWORD = fs
  .readFileSync(".env.local", "utf-8")
  .match(/^AUTH_PASSWORD=(.*)$/m)?.[1]?.trim();
const TOKEN = (
  await (
    await fetch(`${BASE}/api/v1/auth/token`, {
      method: "POST",
      body: new URLSearchParams({ username: "admin", password: AUTH_PASSWORD }),
    })
  ).json()
).access_token;
const H = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const proj = await (
  await fetch(`${BASE}/projects`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: `e2e-skill-routing-${Date.now() % 100000}` }),
  })
).json();
const pid = proj.id ?? proj.project?.id;
console.log("✓ 测试项目", pid);

const jsonSchema = (props, required) => ({ type: "object", properties: props, required });
const frontendTools = [
  { name: "canvas_ops", description: "操作无限画布。", parameters: jsonSchema({ ops: { type: "array", items: { type: "object" } } }, ["ops"]) },
  { name: "canvas_query", description: "检索画布节点。", parameters: jsonSchema({ query: { type: "string" } }, []) },
  { name: "canvas_validate_ops", description: "干跑校验 ops。", parameters: jsonSchema({ ops: { type: "array", items: { type: "object" } } }, ["ops"]) },
  { name: "read_node", description: "读取画布节点内容。", parameters: jsonSchema({ node_id: { type: "string" } }, ["node_id"]) },
  { name: "propose_plan", description: "把多步任务的执行计划展示给用户。", parameters: jsonSchema({ title: { type: "string" }, steps: { type: "array", items: { type: "string" } } }, ["title", "steps"]) },
  { name: "update_plan", description: "计划每完成一步调用打勾。", parameters: jsonSchema({ planId: { type: "string" }, step: { type: "number" } }, ["planId", "step"]) },
];
const isFrontend = (name) => frontendTools.some((t) => t.name === name);

const CANVAS_CTX = [
  {
    description: "画布当前状态（真实题材纪录片项目，画布上有 1 张剧本卡《南洋悬案》）",
    value: "- n_probe_script [剧本] 南洋悬案（本集：分镜表 1 · 镜头图 2）",
  },
];

/** 空画布：新题材目标陈述必须在这种状态下测（有素材在场会触发别的路由） */
const EMPTY_CTX = [
  { description: "画布当前状态（空画布，还没有任何卡片）", value: "- （画布为空）" },
];

/** 跑一个场景（独立 thread + 独立 agent），返回 { calls, text } */
async function run(message, label, ctx = CANVAS_CTX) {
  const threadId = `${Date.now().toString(16)}${Math.floor(Math.random() * 65536)
    .toString(16)
    .padStart(4, "0")}`.slice(0, 12);
  await fetch(`${BASE}/projects/${pid}/threads`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ id: threadId, title: label }),
  });
  const agent = new HttpAgent({ url: BASE, threadId });
  const byId = new Map();
  let seq = 0;
  let text = "";
  agent.subscribe({
    onEvent: ({ event }) => {
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) text += event.delta;
      if (event.type === EventType.TOOL_CALL_START)
        byId.set(event.toolCallId, { name: event.toolCallName, args: "", answered: false });
      if (event.type === EventType.TOOL_CALL_ARGS) {
        const tc = byId.get(event.toolCallId);
        if (tc) tc.args += event.delta;
      }
    },
  });
  console.log(`—— ${label} ——`);
  agent.addMessage({ id: `u_${Date.now()}`, role: "user", content: message });
  for (let wave = 0; wave < 6; wave += 1) {
    await agent.runAgent({
      threadId,
      tools: frontendTools,
      context: ctx,
      forwardedProps: {},
    });
    const pending = [...byId.entries()].filter(
      ([, tc]) => isFrontend(tc.name) && !tc.answered,
    );
    if (pending.length === 0) break;
    for (const [id, tc] of pending) {
      tc.answered = true;
      agent.addMessage({
        id: `tr_${Date.now()}_${++seq}`,
        role: "tool",
        toolCallId: id,
        content:
          tc.name === "canvas_query"
            ? JSON.stringify({ nodes: [] })
            : JSON.stringify({ ok: true }),
      });
    }
  }
  const calls = [...byId.values()].map((tc) => ({ name: tc.name, args: tc.args }));
  console.log(`   工具: ${calls.map((c) => c.name).join(",") || "（无）"}`);
  return { calls, text };
}

/** read_skill 的入参里是否含技能名（args 为流式累积 JSON，反转义后匹配） */
const readSkill = (calls, skill) =>
  calls.some(
    (c) => c.name === "read_skill" && c.args.replace(/\\"/g, '"').includes(skill),
  );

{
  const { calls } = await run(
    "我手上有个真实的南洋罪案题材，想做成纪录片，你打算怎么推进？",
    "R1 真实题材",
  );
  check("R1 真实题材触发 real-documentary 手册", readSkill(calls, "real-documentary"), calls.map((c) => c.name).join(","));
}

{
  const { calls } = await run(
    "分镜到底应该怎么切？把拆镜时要过的自查规则讲给我听。",
    "R2 拆镜自查",
  );
  check("R2 拆镜自查触发 storyboard-director 手册", readSkill(calls, "storyboard-director"), calls.map((c) => c.name).join(","));
}

{
  const { calls } = await run(
    "帮这部片子规划一下抖音和小红书的宣发文案怎么写。",
    "R3 宣发",
  );
  check("R3 宣发触发 documentary-promotion 手册", readSkill(calls, "documentary-promotion"), calls.map((c) => c.name).join(","));
}

{
  // 目标陈述（只给题材、空画布）：入口层应把 agent 拦在「先问意图」这一步
  const { calls, text } = await run(
    "我想做一部关于敦煌藏经洞的历史纪录片",
    "R4 只给题材",
    EMPTY_CTX,
  );
  const names = calls.map((c) => c.name).join(",");
  check("R4a 只给题材仍先读 real-documentary 手册", readSkill(calls, "real-documentary"), names);
  const hasList = /(方向|方案|选项)\s*[A-CＡ-Ｃ1-3]/.test(text) || /(方向|方案|选项)[一二三]/.test(text);
  check("R4b 不出方向清单（目标陈述先问意图）", !hasList, text.slice(0, 60).replace(/\n/g, " "));
  const asksIntent =
    /[？?]/.test(text) &&
    (/(你|您)[^。？！?\n]{0,80}(想|希望|打算|倾向|期待|为什么|心里)/.test(text) ||
      /心里想|早想放进去|哪种感觉/.test(text));
  check("R4c 反问导演意图（不是让导演对菜单盲选）", asksIntent, text.slice(-120).replace(/\n/g, " "));
  const EXEC_TOOLS = [
    "canvas_ops",
    "generate_asset_images",
    "generate_storyboard",
    "generate_free_image",
    "start_deep_research",
    "research_asset_references",
    "decompose_script",
  ];
  const execCalled = calls.filter((c) => EXEC_TOOLS.includes(c.name)).map((c) => c.name);
  check("R4d 不建卡不出图不发起调研", execCalled.length === 0, execCalled.join(",") || "无执行类调用");
  const anchorHit =
    /锚点|动机|参照|对标|喜欢的?(片子|作品|节目|播客|账号)|心里想|想放进去|哪种感觉|具体的?(案子|案例|事件|题材)|为什么(想|是|做|这个|对)/.test(text);
  check("R4e 问到锚点（参照/动机/必放案例类高信息量提问）", anchorHit, text.slice(-160).replace(/\n/g, " "));
}

{
  // 入口层的另一半：非真实题材的开放性想法归 brainstorming（真实题材归 real-documentary）
  const { calls, text } = await run(
    "我想拍一部古装短剧，还没想好具体拍什么",
    "R5 虚构开放想法",
    EMPTY_CTX,
  );
  const names = calls.map((c) => c.name).join(",");
  check("R5a 虚构开放想法触发 brainstorming 手册", readSkill(calls, "brainstorming"), names);
  const asked = /[？?]/.test(text) && /(你|您)/.test(text);
  check("R5b 反问意图（不直接开工）", asked, text.slice(-100).replace(/\n/g, " "));
  const EXEC_TOOLS = [
    "canvas_ops",
    "generate_asset_images",
    "generate_storyboard",
    "generate_free_image",
    "decompose_script",
  ];
  const execCalled = calls.filter((c) => EXEC_TOOLS.includes(c.name)).map((c) => c.name);
  check("R5c 批准前不动手（不建卡不出图）", execCalled.length === 0, execCalled.join(",") || "无执行类调用");
}

{
  // 共创契约「先铺开再收敛」：点名要候选清单（探索委托）→ 先给全集再推荐，
  // 不是筛成 3 个再让用户选（2026-09-09「只有这 6 个可以讲的吗」事故回归）
  const { text } = await run(
    "我想做一部中国近现代骗局的纪录片，先给我列一批能拍的选题，越多越好",
    "R6 探索委托给全集",
    EMPTY_CTX,
  );
  // 候选计数：编号行 / 项目符号行 / 加粗标题行（取三者最大，避免重复计）
  const bullets = (text.match(/^\s*(?:[-*]|\d+[.、)]|#{2,4})\s*\S/gm) ?? []).length;
  check("R6a 候选给全（≥6 条清单项）", bullets >= 6, `清单项=${bullets}`);
  check("R6b 带推荐（推荐/建议/首选）", /推荐|建议选|首选|优先选/.test(text), text.slice(-120).replace(/\n/g, " "));
  check(
    "R6c 说明取舍（放弃/没放进/排除/不选）",
    /放弃|没放进|不选|排除|未纳入|取舍/.test(text),
    "",
  );
  check("R6d 数量诚实或来源依据", /来源|出处|https?:\/\//.test(text), "");
}

await fetch(`${BASE}/projects/${pid}`, { method: "DELETE", headers: H }).catch(() => undefined);
const pass = results.every((r) => r.ok);
console.log(
  `\n${pass ? "✓✓ 手册触发回归通过" : "✗ 手册触发回归未过"}（${results.filter((r) => r.ok).length}/${results.length}）`,
);
process.exit(pass ? 0 : 1);
