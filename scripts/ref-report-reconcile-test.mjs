/**
 * 调研产物对账回归（2026-09-10）：服务端条目 → 画布（报告卡 / 资产卡简报 /
 * 参考卡物化），且不依赖前端轮询窗口。
 *
 * 这是「调研花钱产出的东西却看不见」那组事故的回归：此前画布上的一切产物
 * 只在前端轮询回调里写（卡带 refBatchJobId 锚 → 轮询 → 顺手落卡），agent 从
 * 聊天发起调研没人写锚，产物就永久留在库里。现在条目表是权威落点，打开项目
 * 对账一次即自愈——本测试正是断言「只把条目放进库、然后打开项目」这条路径。
 *
 * 前置：agent(8123) + 前端(8008) 在跑。无 LLM：条目用 python 直连写入（服务端
 * 真实写入口 imgresearch.upsert_entry），不跑调研 flow。
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;
const AGENT_DIR = fileURLToPath(new URL("../agent", import.meta.url));

function envLocal(key) {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf-8").split("\n")) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return "";
}

/** 直连服务端写入口造条目/采纳（与调研落库同一条路，不重复实现 SQL） */
function py(code) {
  return execFileSync("uv", ["run", "python", "-c", code], {
    cwd: AGENT_DIR,
    encoding: "utf-8",
  }).trim();
}

let TOKEN = "";
{
  const r = await fetch(`${BASE}/api/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: envLocal("AUTH_USERNAME") || "admin",
      password: envLocal("AUTH_PASSWORD"),
    }),
  });
  if (r.ok) TOKEN = (await r.json()).access_token ?? "";
}
async function api(path, init) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const ERA = "北魏·平城时期";
const BRIEF_FENG = "北魏早期服饰为窄袖交领，鲜卑辫发；常见误用：套用唐宋圆领袍。";
const BRIEF_HALL = "平城宫殿为夯土台基木构，少见后世彩画琉璃。";
const REF_URL = "/agent-service/assets/e2e00000ref1.png";

// ---------- 建项目 + 画布（3 资产，其中 1 个无考据） ----------
const { body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-ref-report-${Date.now()}` }),
});
const pid = proj.id ?? proj.project?.id;

await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    nodes: [
      { id: "N_FENG", type: "character", position: { x: 0, y: 0 },
        data: { nodeType: "character", title: "冯太后", body: "" } },
      { id: "N_HALL", type: "scene", position: { x: 400, y: 0 },
        data: { nodeType: "scene", title: "平城朝堂", body: "" } },
      { id: "N_SWORD", type: "prop", position: { x: 800, y: 0 },
        data: { nodeType: "prop", title: "环首刀", body: "" } },
    ],
    edges: [],
    viewport: { x: 40, y: 40, zoom: 0.6 },
    meta: { era: ERA },
  }),
});

// ---------- 只往库里放条目与采纳（模拟「agent 从聊天发起的调研」） ----------
py(`
import imgresearch as ir
ir.init_ref_research_db()   # 表由 agent 启动建；这里兜一道，测试不依赖 agent 重启过
ir.upsert_entry(${JSON.stringify(pid)}, body=${JSON.stringify(BRIEF_FENG)}, node_id="N_FENG",
                asset_name="冯太后", asset_type="character", era=${JSON.stringify(ERA)},
                sources=[{"title":"北魏服饰","url":"https://a.example/1","domain":"a.example"}])
ir.upsert_entry(${JSON.stringify(pid)}, body=${JSON.stringify(BRIEF_HALL)}, node_id="N_HALL",
                asset_name="平城朝堂", asset_type="scene", era=${JSON.stringify(ERA)})
# 考证大纲：一个主题服务两张卡 + 一条主题事实（大纲卡与报告卡都该出现）
ir.replace_topics(${JSON.stringify(pid)}, [
  {"title":"北魏早期服制","rationale":"角色与服饰共享同一套形制",
   "queries":["北魏 服饰 形制"],"nodeIds":["N_FENG","N_HALL"]},
])
ir.upsert_entry(${JSON.stringify(pid)}, body="北魏早期服制：窄袖交领左衽，鲜卑辫发。",
                asset_name="北魏早期服制", asset_type="topic",
                era=${JSON.stringify(ERA)}, topic_key="北魏早期服制")
import sqlite3, uuid
db = sqlite3.connect(str(ir.DB_PATH))
db.execute("""INSERT INTO ref_candidates (id,project_id,node_id,query,provider,title,
   page_url,source_domain,source_url,asset_url,width,height,adopted,recommended,
   rec_reason,created_at,idx_total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,'',?,0)""",
   (uuid.uuid4().hex[:12], ${JSON.stringify(pid)}, "N_FENG", "q", "google", "北魏冯太后复原像",
    "https://page", "commons.wikimedia.org", "https://commons.wikimedia.org/src",
    ${JSON.stringify(REF_URL)}, 800, 600, "2026-09-10T00:00:00.000Z"))
db.commit(); db.close()
`);

// A. 服务端报告 API（落点本身）
const rep = await api(`/projects/${pid}/refs/report`);
check("A1 报告 API 通", rep.status === 200, `status=${rep.status}`);
check("A2 条目两条（资产 + 主题）",
  (rep.body?.entries ?? []).filter((e) => e.assetType !== "topic").length === 2 &&
  (rep.body?.entries ?? []).some((e) => e.assetType === "topic"),
  `entries=${JSON.stringify((rep.body?.entries ?? []).map((e) => [e.assetName, e.assetType]))}`);
check("A3 待补点名叫环首刀",
  rep.body?.missing?.length === 1 && rep.body.missing[0].title === "环首刀",
  JSON.stringify(rep.body?.missing));
check("A4 era 口径读出", rep.body?.era === ERA, `era=${rep.body?.era}`);
check("A5 报告正文含条目与来源",
  String(rep.body?.text ?? "").includes("鲜卑辫发") && String(rep.body?.text ?? "").includes("a.example"));
check("A6 采纳图在底账里",
  JSON.stringify(rep.body?.adopted ?? []).includes("commons.wikimedia.org"));

// ---------- 打开项目：对账应把产物落到画布 ----------
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
if (TOKEN)
  await ctx.addInitScript(([k, v]) => window.localStorage.setItem(k, v), ["wingsight_studio_token", TOKEN]);
const page = await ctx.newPage();
await page.goto(`${BASE}/project/${pid}`, { waitUntil: "domcontentloaded" });

/** 轮询服务端画布直到条件成立（落库有 1.2s debounce，对账本身要等 hydration） */
async function untilCanvas(pred, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await api(`/projects/${pid}/canvas`);
    last = r.body;
    try {
      if (pred(last)) return last;
    } catch { /* 断言函数在数据不全时会抛，继续等 */ }
    await page.waitForTimeout(700);
  }
  return last;
}
/** 卡面简报是合成结果（本资产条目 + 服务它的主题条目），按包含断言 */
const briefOn = (c, id, text) =>
  String(c?.nodes?.find((n) => n.id === id)?.data?.researchBrief ?? "").includes(text);

const canvas = await untilCanvas(
  (c) =>
    briefOn(c, "N_FENG", BRIEF_FENG) &&
    (c.nodes ?? []).some((n) => n.data?.reportKind === "ref-research") &&
    (c.nodes ?? []).some((n) => n.data?.reportKind === "ref-outline"),
);

check("B1 简报落资产卡（此前恒零）", briefOn(canvas, "N_FENG", BRIEF_FENG),
  `researchBrief=${JSON.stringify(canvas?.nodes?.find((n) => n.id === "N_FENG")?.data?.researchBrief)?.slice(0, 60)}`);
check("B2 第二个资产也落简报", briefOn(canvas, "N_HALL", BRIEF_HALL));
check("B2b 卡面简报含服务它的主题考据（卡上显示的=出图发出去的）",
  briefOn(canvas, "N_FENG", "〈北魏早期服制〉"),
  `researchBrief=${JSON.stringify(canvas?.nodes?.find((n) => n.id === "N_FENG")?.data?.researchBrief)?.slice(0, 80)}`);

const reportCards = (canvas?.nodes ?? []).filter((n) => n.data?.reportKind === "ref-research");
check("B3 报告卡建了一张", reportCards.length === 1, `count=${reportCards.length}`);
check("B4 报告卡标题带项目名",
  String(reportCards[0]?.data?.title ?? "").includes("资产考证报告"),
  reportCards[0]?.data?.title);
check("B5 报告卡正文是服务端报告",
  String(reportCards[0]?.data?.body ?? "").includes("鲜卑辫发") &&
  String(reportCards[0]?.data?.body ?? "").includes("待补考据"),
  `len=${String(reportCards[0]?.data?.body ?? "").length}`);

const outlineCards = (canvas?.nodes ?? []).filter((n) => n.data?.reportKind === "ref-outline");
check("B9 大纲卡建了一张", outlineCards.length === 1, `count=${outlineCards.length}`);
check("B10 大纲卡正文是计划与进度（含服务范围，不含事实正文）",
  String(outlineCards[0]?.data?.body ?? "").includes("■ 北魏早期服制（服务 2 张卡 · 已完成）") &&
  !String(outlineCards[0]?.data?.body ?? "").includes("窄袖交领左衽"),
  String(outlineCards[0]?.data?.body ?? "").slice(0, 120));

const refCards = (canvas?.nodes ?? []).filter(
  (n) => n.data?.refSource === "research" && n.data?.imageUrl === REF_URL,
);
check("B6 已采纳参考图物化成参考卡（此前零物化）", refCards.length === 1, `count=${refCards.length}`);
check("B7 参考卡连线到资产卡",
  (canvas?.edges ?? []).some((e) => e.source === refCards[0]?.id && e.target === "N_FENG"),
  JSON.stringify((canvas?.edges ?? []).slice(0, 4)));
check("B8 参考卡带来源域名",
  String(refCards[0]?.data?.body ?? "").includes("commons.wikimedia.org"),
  refCards[0]?.data?.body);

// C. 幂等：重新打开项目不重复建卡
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const canvas2 = await untilCanvas(() => true, 6000);
const reportCards2 = (canvas2?.nodes ?? []).filter((n) => n.data?.reportKind === "ref-research");
const refCards2 = (canvas2?.nodes ?? []).filter(
  (n) => n.data?.refSource === "research" && n.data?.imageUrl === REF_URL,
);
check("C1 报告卡不重复建", reportCards2.length === 1, `count=${reportCards2.length}`);
check("C2 参考卡不重复建", refCards2.length === 1, `count=${refCards2.length}`);
check("C3 大纲卡不重复建",
  (canvas2?.nodes ?? []).filter((n) => n.data?.reportKind === "ref-outline").length === 1);

// D. 前端保存周期不抹掉 era 口径：装载没读进来的话，前端下一次 debounce 保存
//    会用 store 里的空值覆盖 meta——这一步专门盯那个（era 是复用的作用域键）
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const { body: c4 } = await api(`/projects/${pid}/canvas`);
check("D1 前端保存周期保住了 era 口径", c4?.meta?.era === ERA, `era=${c4?.meta?.era}`);

await browser.close();

// ---------- 清理 ----------
await api(`/projects/${pid}`, { method: "DELETE" });
py(`
import sqlite3, imgresearch as ir
db = sqlite3.connect(str(ir.DB_PATH))
for t in ("research_entries", "research_topics", "ref_candidates"):
    db.execute(f"DELETE FROM {t} WHERE project_id = ?", (${JSON.stringify(pid)},))
db.commit(); db.close()
`);

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? "✗" : "✅"} 调研产物对账 ${results.length - bad.length}/${results.length} 项通过`);
if (bad.length) {
  console.log("失败：" + bad.map((b) => b.name).join("、"));
  process.exit(1);
}
