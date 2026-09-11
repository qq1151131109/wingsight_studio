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

// 主体是**全库按 era 共享**的（2026-09-11 主体化）：测试必须用当次唯一的 era，
// 否则 fixture 会与真实项目的主体同名同域——既覆盖别人的事实，
// 清理时还会按 project_id 把共用的那条一起删掉。
const ERA = `e2e-era-${Date.now().toString(36)}`;
const BRIEF_FENG = "北魏早期服饰为窄袖交领，鲜卑辫发；常见误用：套用唐宋圆领袍。";
const BRIEF_HALL = "平城宫殿为夯土台基木构，少见后世彩画琉璃。";
const REF_URL = "/agent-service/assets/e2e00000ref1.png";
const TOPIC_URL1 = "/agent-service/assets/e2e00000topic1.png";
const TOPIC_URL2 = "/agent-service/assets/e2e00000topic2.png";

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
# 时代参考池：主题图集两张（对账应物化成参考卡、连到 N_FENG 与 N_HALL）
_tk = ir.topic_subject(${JSON.stringify(ERA)}, ${JSON.stringify(pid)}, "北魏早期服制")
ir.add_subject_refs(${JSON.stringify(ERA)}, _tk, [
  {"assetUrl": ${JSON.stringify(TOPIC_URL1)}, "title": "e2e 时代参考图壹", "sourceUrl": "https://t.example/1", "sourceDomain": "t.example"},
  {"assetUrl": ${JSON.stringify(TOPIC_URL2)}, "title": "e2e 时代参考图贰", "sourceUrl": "https://t.example/2", "sourceDomain": "t.example"},
])
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
check("A3b 真待办清单 = 缺已采纳参考图的资产（含「有文无图」那类）",
  JSON.stringify(rep.body?.pendingAssets ?? []) ===
    JSON.stringify([
      { nodeId: "N_HALL", name: "平城朝堂", type: "scene" },
      { nodeId: "N_SWORD", name: "环首刀", type: "prop" },
    ]),
  JSON.stringify(rep.body?.pendingAssets));
check("A3c 有文无图的资产在报告里标注「只缺参考图」",
  String(rep.body?.text ?? "").includes("· 平城朝堂（场景）——已有文字考据，只缺参考图"),
  JSON.stringify(String(rep.body?.text ?? "").split("\n").filter((l) => l.includes("平城朝堂")).slice(-2)));
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
  String(reportCards[0]?.data?.body ?? "").includes("待补清单"),
  `len=${String(reportCards[0]?.data?.body ?? "").length}`);
check("B5b 报告卡带真待办清单（补调研按钮的数据源）",
  JSON.stringify(reportCards[0]?.data?.reportPending ?? []) ===
    JSON.stringify([
      { nodeId: "N_HALL", name: "平城朝堂", type: "scene" },
      { nodeId: "N_SWORD", name: "环首刀", type: "prop" },
    ]),
  JSON.stringify(reportCards[0]?.data?.reportPending));

const outlineCards = (canvas?.nodes ?? []).filter((n) => n.data?.reportKind === "ref-outline");
check("B9 大纲卡建了一张", outlineCards.length === 1, `count=${outlineCards.length}`);
check("B10 大纲卡正文是计划与进度（含服务范围与图集张数，不含事实正文）",
  String(outlineCards[0]?.data?.body ?? "").includes("■ 北魏早期服制（服务 2 张卡 · 已完成 · 图 2 张）") &&
  !String(outlineCards[0]?.data?.body ?? "").includes("窄袖交领左衽"),
  String(outlineCards[0]?.data?.body ?? "").slice(0, 140));

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
check("B8b 参考卡带候选 id（删除=取消采纳的凭据）",
  Boolean(refCards[0]?.data?.refCandidateId),
  `refCandidateId=${refCards[0]?.data?.refCandidateId}`);
// B8c 组框收纳：参考卡不摊在画布上，全收进「考据参考」组框（2026-09-11 用户
// 拍板默认展开——参考图是要核对的原料，收起等于藏起来；行距按真实卡高算，
// 见 ref-group-layout-test）
const refGroup = (canvas?.nodes ?? []).find(
  (n) => n.data?.nodeType === "group" && n.data?.refGroup === "research",
);
check("B8c 考据参考组框存在且默认展开", Boolean(refGroup) && refGroup.data?.collapsed === false,
  `collapsed=${refGroup?.data?.collapsed}`);
check("B8d 参考卡全部 parent 进组且可见",
  refCards.every((c) => c.parentId === refGroup?.id && c.hidden === false),
  `parentId 命中 ${refCards.filter((c) => c.parentId === refGroup?.id).length}/${refCards.length}, hidden ${refCards.filter((c) => c.hidden).length}/${refCards.length}`);
check("B8e 组框尺寸包住全部参考卡（{w,h} 写 style 的旧实现会让末行挂框外）",
  refCards.every((c) => c.position.x + (c.style?.width ?? 256) + 20 <= (refGroup?.style?.width ?? 0) &&
    c.position.y + (c.style?.height ?? 200) + 20 <= (refGroup?.style?.height ?? 0)),
  `${refGroup?.style?.width}×${refGroup?.style?.height}`);

// G. 时代参考池物化：主题图集 → 参考卡，连到该主题的两个成员卡（N_FENG/N_HALL）
const topicCards = (canvas?.nodes ?? []).filter((n) => n.data?.topicRefId);
check("G1 主题图集物化成时代参考卡（带 topicRefId）", topicCards.length === 2,
  `count=${topicCards.length}`);
check("G2 时代参考卡不带候选 id（不进采纳/取消通道）",
  topicCards.every((c) => !c.data?.refCandidateId),
  JSON.stringify(topicCards.map((c) => c.data?.refCandidateId)));
{
  const tids = new Set(topicCards.map((c) => c.id));
  const targets = (canvas?.edges ?? [])
    .filter((e) => tids.has(e.source))
    .map((e) => e.target)
    .sort();
  check("G3 每张时代参考卡连到全部成员卡",
    JSON.stringify(targets) === JSON.stringify(["N_FENG", "N_FENG", "N_HALL", "N_HALL"]),
    JSON.stringify(targets));
}
check("G4 时代参考卡收进考据参考组框且可见",
  topicCards.every((c) => c.parentId === refGroup?.id && c.hidden === false),
  `in=${topicCards.filter((c) => c.parentId === refGroup?.id).length}/2`);

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
check("C4 时代参考卡不重复建",
  (canvas2?.nodes ?? []).filter((n) => n.data?.topicRefId).length === 2,
  `count=${(canvas2?.nodes ?? []).filter((n) => n.data?.topicRefId).length}`);

// D. 前端保存周期不抹掉 era 口径：装载没读进来的话，前端下一次 debounce 保存
//    会用 store 里的空值覆盖 meta——这一步专门盯那个（era 是复用的作用域键）
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const { body: c4 } = await api(`/projects/${pid}/canvas`);
check("D1 前端保存周期保住了 era 口径", c4?.meta?.era === ERA, `era=${c4?.meta?.era}`);

// E. 删掉参考卡 = 这张参考不要了：服务端取消采纳，重载不再长回来
//    （真实交互：选中卡片 → 工具条「删除」；画布卡有 data-id，工具条按钮有
//     aria-label。组框 2026-09-11 起默认展开，卡片直接在 DOM；若被折叠过也
//     兜一步展开）
const refId = refCards[0].id;
if (await page.locator('[aria-label="展开分组"]').count()) {
  await page.locator('[aria-label="展开分组"]').first().click();
  await page.waitForTimeout(800);
}
await page.locator(`[data-id="${refId}"]`).first().click();
await page.waitForTimeout(600);
await page
  .locator('.react-flow__node-toolbar [aria-label="删除"]:visible')
  .first()
  .click();
await page.waitForTimeout(3000); // 落库 debounce 1.2s
const { body: afterDel } = await api(`/projects/${pid}/canvas`);
check("E1 参考卡已从画布删除",
  !(afterDel?.nodes ?? []).some((n) => n.id === refId),
  `still=${(afterDel?.nodes ?? []).filter((n) => n.id === refId).length}`);
const { body: cands } = await api(`/projects/${pid}/refs/candidates?nodeId=N_FENG`);
check("E2 服务端已取消采纳（删卡=不要这张参考）",
  (cands ?? []).some((c) => c.id === refCards[0].data.refCandidateId && !c.adopted),
  JSON.stringify((cands ?? []).map((c) => [c.id, c.adopted])));

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const { body: afterReload } = await api(`/projects/${pid}/canvas`);
check("E3 重载后参考卡没有被长回来（对账不重建已取消采纳的）",
  !(afterReload?.nodes ?? []).some(
    (n) => n.data?.refSource === "research" && n.data?.imageUrl === REF_URL,
  ),
  `count=${(afterReload?.nodes ?? []).filter((n) => n.data?.imageUrl === REF_URL).length}`);

// F. 删掉报告卡 = 不要这张视图了：重载不再长回来（2026-09-10 用户拍板，
//    与参考卡同语义；报告卡没有服务端凭据，故标记记在 meta.dismissedReports）
const reportCard = (afterReload?.nodes ?? []).find(
  (n) => n.data?.reportKind === "ref-research",
);
check("F0 报告卡在画布上（前置条件）", !!reportCard, `id=${reportCard?.id}`);
if (reportCard) {
  await page.locator(`[data-id="${reportCard.id}"]`).first().click();
  await page.waitForTimeout(600);
  await page
    .locator('.react-flow__node-toolbar [aria-label="删除"]:visible')
    .first()
    .click();
  await page.waitForTimeout(3000);
  const { body: afterDelReport } = await api(`/projects/${pid}/canvas`);
  check("F1 报告卡已从画布删除",
    !(afterDelReport?.nodes ?? []).some((n) => n.id === reportCard.id));
  check("F2 meta 记住了删过的报告卡 kind",
    (afterDelReport?.meta?.dismissedReports ?? []).includes("ref-research"),
    JSON.stringify(afterDelReport?.meta?.dismissedReports));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  const { body: afterReloadReport } = await api(`/projects/${pid}/canvas`);
  check("F3 重载后报告卡没有被长回来",
    !(afterReloadReport?.nodes ?? []).some(
      (n) => n.data?.reportKind === "ref-research",
    ),
    `count=${(afterReloadReport?.nodes ?? []).filter((n) => n.data?.reportKind === "ref-research").length}`);
}

// H. 删掉时代参考卡 = 这张时代参考不要了：记 meta.dismissedTopicRefs，
//    重载只少这一张（同主题其余图照常物化）；不触发 /refs/unadopt（它不在候选表）
{
  const { body: cur } = await api(`/projects/${pid}/canvas`);
  const tCards = (cur?.nodes ?? []).filter((n) => n.data?.topicRefId);
  const victim = tCards.find((n) => n.data?.imageUrl === TOPIC_URL1);
  check("H0 两张时代参考卡都在（前置）", tCards.length === 2 && Boolean(victim),
    `count=${tCards.length}`);
  if (victim) {
    // E 组可能已把组展开（collapsed 持久化）——只在折叠态才需要展开
    const expandBtn = page.locator('[aria-label="展开分组"]');
    if (await expandBtn.count()) {
      await expandBtn.first().click();
      await page.waitForTimeout(800);
    }
    await page.locator(`[data-id="${victim.id}"]`).first().click();
    await page.waitForTimeout(600);
    await page
      .locator('.react-flow__node-toolbar [aria-label="删除"]:visible')
      .first()
      .click();
    await page.waitForTimeout(3000);
    const { body: afterH } = await api(`/projects/${pid}/canvas`);
    check("H1 时代参考卡已删除",
      !(afterH?.nodes ?? []).some((n) => n.id === victim.id));
    check("H2 meta 记住了删过的 subject-ref id",
      (afterH?.meta?.dismissedTopicRefs ?? []).includes(victim.data.topicRefId),
      JSON.stringify(afterH?.meta?.dismissedTopicRefs));
    check("H2b 不在候选表里的卡没走 unadopt（另一张完好）",
      (afterH?.nodes ?? []).filter((n) => n.data?.topicRefId).length === 1);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);
    const { body: afterHReload } = await api(`/projects/${pid}/canvas`);
    check("H3 重载后被删的不长回来、其余照常",
      (afterHReload?.nodes ?? []).filter((n) => n.data?.topicRefId).length === 1 &&
      !(afterHReload?.nodes ?? []).some((n) => n.data?.imageUrl === TOPIC_URL1),
      `count=${(afterHReload?.nodes ?? []).filter((n) => n.data?.topicRefId).length}`);
  }
}

await browser.close();

// 退出兜底：主体按 era 全库共享，崩溃残留会污染真实复用域（实测：E2E 在
// playwright 处崩掉后留下 6 批 e2e-era 主体）。exit 钩子里尽力清研究行。
process.on("exit", () => {
  try {
    py(`
import sqlite3, imgresearch as ir
db = sqlite3.connect(str(ir.DB_PATH))
db.execute("DELETE FROM research_entries WHERE era = ?", (${JSON.stringify(ERA)},))
db.execute("DELETE FROM research_subject_refs WHERE era = ?", (${JSON.stringify(ERA)},))
for pid in (${JSON.stringify(pid)},):
    for t in ("research_entries", "research_topics", "ref_candidates", "research_uses"):
        db.execute(f"DELETE FROM {t} WHERE project_id = ?", (pid,))
db.commit(); db.close()
`);
  } catch {
    /* 尽力而为 */
  }
});

// ---------- 清理 ----------
await api(`/projects/${pid}`, { method: "DELETE" });
py(`
import sqlite3, imgresearch as ir
db = sqlite3.connect(str(ir.DB_PATH))
for t in ("research_entries", "research_topics", "ref_candidates"):
    db.execute(f"DELETE FROM {t} WHERE project_id = ?", (${JSON.stringify(pid)},))
db.execute("DELETE FROM research_subject_refs WHERE era = ?", (${JSON.stringify(ERA)},))
# 主体/图集按 era 清（全库共享，按 project_id 删不干净也不该冒删别人的）
db.execute("DELETE FROM research_entries WHERE era = ?", (${JSON.stringify(ERA)},))
db.execute("DELETE FROM research_subject_refs WHERE era = ?", (${JSON.stringify(ERA)},))
db.execute("DELETE FROM research_uses WHERE project_id = ?", (${JSON.stringify(pid)},))
db.commit(); db.close()
`);

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? "✗" : "✅"} 调研产物对账 ${results.length - bad.length}/${results.length} 项通过`);
if (bad.length) {
  console.log("失败：" + bad.map((b) => b.name).join("、"));
  process.exit(1);
}
