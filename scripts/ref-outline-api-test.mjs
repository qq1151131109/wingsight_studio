/**
 * 考证报告/大纲服务端契约回归（2026-09-10）：条目表 → 报告/大纲 API。
 *
 * 不依赖前端构建、不跑浏览器、不用 LLM：条目与主题用 python 直连服务端写入口
 * （imgresearch.upsert_entry / replace_topics）造，然后打真实 HTTP 端点断言契约。
 * 浏览器侧的对账（简报/参考卡/报告卡落画布）在 ref-report-reconcile-test.mjs。
 *
 * 前置：agent(8123) 在跑。
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;
const AGENT_DIR = fileURLToPath(new URL("../agent", import.meta.url));

function envLocal(key) {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf-8").split("\n")) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return "";
}
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
const PID_NAME = `e2e-ref-api-${Date.now().toString(36)}`;
const REF_URL = "/agent-service/assets/e2e00000api1.png";

const { body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: PID_NAME }),
});
const pid = proj.id ?? proj.project?.id;

await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    nodes: [
      { id: "N_FENG", type: "character", position: { x: 0, y: 0 },
        data: { nodeType: "character", title: "冯太后" } },
      { id: "N_ROBE", type: "costume", position: { x: 400, y: 0 },
        data: { nodeType: "costume", title: "太后朝服" } },
      { id: "N_SWORD", type: "prop", position: { x: 800, y: 0 },
        data: { nodeType: "prop", title: "环首刀" } },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    meta: { era: ERA },
  }),
});

// 造数据：一条资产条目 + 一条主题条目 + 一个已采纳候选 + 两个主题
py(`
import sqlite3, uuid, imgresearch as ir
ir.init_ref_research_db()
ir.upsert_entry(${JSON.stringify(pid)}, body="北魏早期服饰窄袖交领，鲜卑辫发。",
                node_id="N_FENG", asset_name="冯太后", asset_type="character",
                era=${JSON.stringify(ERA)},
                sources=[{"title":"北魏服饰","url":"https://a.example/1","domain":"a.example"}])
ir.replace_topics(${JSON.stringify(pid)}, [
  {"title":"北魏早期服制","rationale":"角色与服饰共享同一套形制",
   "queries":["北魏 服饰 形制"],"nodeIds":["N_FENG","N_ROBE"]},
  {"title":"北魏兵器","queries":["北魏 环首刀"],"nodeIds":["N_SWORD"]},
])
ir.upsert_entry(${JSON.stringify(pid)}, body="北魏早期服制：窄袖交领左衽，鲜卑辫发。",
                asset_name="北魏早期服制", asset_type="topic",
                era=${JSON.stringify(ERA)}, topic_key="北魏早期服制")
db = sqlite3.connect(str(ir.DB_PATH))
db.execute("""INSERT INTO ref_candidates (id,project_id,node_id,query,provider,title,
   page_url,source_domain,source_url,asset_url,width,height,adopted,recommended,
   rec_reason,created_at,idx_total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,'',?,0)""",
   (uuid.uuid4().hex[:12], ${JSON.stringify(pid)}, "N_FENG", "q", "google", "北魏冯太后复原像",
    "https://page", "commons.wikimedia.org", "https://commons.wikimedia.org/src",
    ${JSON.stringify(REF_URL)}, 800, 600, "2026-09-10T00:00:00.000Z"))
db.commit(); db.close()
`);

// ---------- A. 报告 API ----------
const rep = await api(`/projects/${pid}/refs/report`);
check("A1 报告 API 通", rep.status === 200, `status=${rep.status}`);
check("A2 条目两条（资产 + 主题）", rep.body?.entries?.length === 2, `entries=${rep.body?.entries?.length}`);
check("A3 era 口径读出", rep.body?.era === ERA, `era=${rep.body?.era}`);
check("A4 待补点名无考据的资产",
  rep.body?.missing?.length === 1 && rep.body.missing[0].title === "环首刀",
  JSON.stringify(rep.body?.missing));
const text = String(rep.body?.text ?? "");
check("A5 报告首节是考证大纲", text.includes("一、考证大纲（2 个主题 · 已完成 1）"), text.slice(0, 120));
check("A6 资产段顺移且带来源", text.includes("二、考据事实") && text.includes("a.example"));
check("A7 底账段含采纳域名", text.includes("三、参考图底账") && text.includes("commons.wikimedia.org"));
check("A8 待补段在末节", text.includes("四、待补清单（缺参考图 2 个资产）"), text.slice(-220));
check("A8b 待补含「有文无图」并标注只缺参考图（091101 盲区）",
  text.includes("· 太后朝服（服饰）——已有文字考据，只缺参考图"),
  JSON.stringify(text.split("\n").filter((l) => l.includes("太后朝服")).slice(-2)));
check("A8c 待办清单 = 缺参考图的资产（覆盖 + 待补 = 3）",
  JSON.stringify((rep.body?.pendingAssets ?? []).map((p) => p.nodeId)) === '["N_ROBE","N_SWORD"]',
  JSON.stringify(rep.body?.pendingAssets));
check("A9 主题考据指向（不重复正文）",
  text.includes("＋主题考据〈北魏早期服制〉（全文见考证大纲）"));
check("A10 cardBriefs 合成（资产条目 + 主题条目）",
  String(rep.body?.cardBriefs?.N_FENG ?? "").includes("鲜卑辫发") &&
  String(rep.body?.cardBriefs?.N_FENG ?? "").includes("〈北魏早期服制〉"),
  String(rep.body?.cardBriefs?.N_FENG ?? "").slice(0, 60));
check("A11 改名/无条目卡不进 cardBriefs", !(rep.body?.cardBriefs ?? {}).N_SWORD);

// ---------- B. 大纲 API ----------
const out = await api(`/projects/${pid}/refs/outline`);
check("B1 大纲 API 通", out.status === 200, `status=${out.status}`);
check("B2 主题两个且带服务范围",
  out.body?.topics?.length === 2 && out.body.topics[0].serves?.length === 2,
  JSON.stringify(out.body?.topics?.map((t) => [t.title, t.serves?.length])));
check("B3 主题条目挂在主题上（doneCount=1）", out.body?.doneCount === 1, `done=${out.body?.doneCount}`);
const otext = String(out.body?.text ?? "");
check("B4 大纲正文不含事实正文（计划与进度板）",
  otext.includes("■ 北魏早期服制（服务 2 张卡 · 已完成）") && !otext.includes("窄袖交领左衽"),
  otext.slice(0, 200));
check("B5 缺口清单点名未覆盖资产",
  otext.includes("未被任何主题覆盖") === false && (out.body?.uncovered ?? []).length === 0,
  JSON.stringify(out.body?.uncovered));

// ---------- C. 大纲写入的防幻觉与整份替换 ----------
const bad = await api(`/projects/${pid}/refs/outline`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ topics: [{ title: "X", nodeIds: ["N_BOGUS"] }] }),
});
check("C1 不存在的 node id → 400 并列出可用卡",
  bad.status === 400 && String(bad.body).includes("N_BOGUS") && String(bad.body).includes("冯太后"),
  String(bad.body).slice(0, 120));
const empty = await api(`/projects/${pid}/refs/outline`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ topics: [] }),
});
check("C2 空大纲 → 400", empty.status === 400, String(empty.body).slice(0, 80));
const notArray = await api(`/projects/${pid}/refs/outline`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ topics: "x" }),
});
check("C3 非数组 → 400", notArray.status === 400);
const replaced = await api(`/projects/${pid}/refs/outline`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    topics: [{ title: "北魏早期服制", queries: ["北魏 服饰"], nodeIds: ["N_FENG"] }],
  }),
});
check("C4 整份替换生效（旧主题被删）",
  replaced.status === 200 && replaced.body?.topics?.length === 1,
  `topics=${replaced.body?.topics?.length}`);
check("C5 被移出大纲的主题不再分发（uncovered 增加）",
  (replaced.body?.uncovered ?? []).length === 2,
  JSON.stringify(replaced.body?.uncovered?.map((a) => a.title)));

// ---------- D. 执行端点的参数校验（走库命中路径：零搜索，不烧额度） ----------
// 主题执行现在会连带搜该时代的实物参考池，所以这里**不能**让它真跑：先用另一个
// 项目在同 era 下落一条主题事实，执行就命中库（status=reused）——既验证了「显式
// 点名被接受」，又验证了复用路径，且一次网络调用都不发。
const unknown = await api(`/projects/${pid}/refs/outline/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ topicKeys: ["不存在的主题"] }),
});
check("D1 未知主题 → 400 并列出现有主题",
  unknown.status === 400 && String(unknown.body).includes("北魏早期服制"),
  String(unknown.body).slice(0, 120));
const { body: proj2 } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `${PID_NAME}-src` }),
});
const pid2 = proj2.id ?? proj2.project?.id;
py(`
import imgresearch as ir
ir.upsert_entry(${JSON.stringify(pid2)}, body="北魏早期服制：窄袖交领左衽，鲜卑辫发。",
                asset_name="北魏早期服制", asset_type="topic", era=${JSON.stringify(ERA)},
                topic_key="北魏早期服制")
`);
const dup = await api(`/projects/${pid}/refs/outline/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ topicKeys: ["北魏早期服制"] }),
});
check("D2 显式点名合法主题 → 202/200 且返回 started",
  dup.status === 200 && Array.isArray(dup.body?.started) && dup.body.started.includes("北魏早期服制"),
  `status=${dup.status} started=${JSON.stringify(dup.body?.started)}`);
await new Promise((r) => setTimeout(r, 2500));
const { body: afterRun } = await api(`/projects/${pid}/refs/outline`);
const ranTopic = (afterRun.topics ?? []).find((t) => t.topicKey === "北魏早期服制");
check("D2b 命中同题材库：标 reused 且零搜索（不烧额度）",
  String(ranTopic?.status) === "reused",
  JSON.stringify({ status: ranTopic?.status, from: ranTopic?.reusedFrom }));
check("D2c 大纲主题带图集张数字段（产物可见）",
  typeof ranTopic?.refCount === "number",
  `refCount=${ranTopic?.refCount}`);

// ---------- E. 取消采纳（删参考卡 = 这张参考不要了） ----------
const cands0 = await api(`/projects/${pid}/refs/candidates?nodeId=N_FENG`);
const first = (cands0.body ?? []).find((c) => c.adopted);
check("E1 已采纳候选在位", Boolean(first), JSON.stringify((cands0.body ?? []).map((c) => [c.id, c.adopted])));
const un = await api(`/projects/${pid}/refs/unadopt`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ nodeId: "N_FENG", ids: [first.id] }),
});
const after = (un.body?.candidates ?? []).find((c) => c.id === first.id);
check("E2 取消采纳生效且候选行保留",
  un.status === 200 && after && after.adopted === false,
  `status=${un.status} adopted=${after?.adopted}`);
const rep2 = await api(`/projects/${pid}/refs/report`);
const stillAdopted = (rep2.body?.adopted ?? [])
  .flatMap((g) => g.candidates.map((c) => c.id))
  .includes(first.id);
check("E3 报告底账里不再算作采纳（对账不会重建它）",
  !stillAdopted && rep2.body?.text?.includes("参考图底账（已采纳 0 张）"),
  `adopted 里仍有=${stillAdopted}`);
const badUn = await api(`/projects/${pid}/refs/unadopt`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ nodeId: "", ids: [] }),
});
check("E4 缺参数 → 400", badUn.status === 400, `status=${badUn.status}`);

// ---------- 清理 ----------
await api(`/projects/${pid}`, { method: "DELETE" });
await api(`/projects/${pid2}`, { method: "DELETE" });
py(`
import sqlite3, imgresearch as ir
db = sqlite3.connect(str(ir.DB_PATH))
for t in ("research_entries", "research_topics", "ref_candidates"):
    db.execute(f"DELETE FROM {t} WHERE project_id = ?", (${JSON.stringify(pid)},))
# 主体/图集按 era 清（全库共享，按 project_id 删不干净也不该冒删别人的）
db.execute("DELETE FROM research_entries WHERE era = ?", (${JSON.stringify(ERA)},))
db.execute("DELETE FROM research_subject_refs WHERE era = ?", (${JSON.stringify(ERA)},))
db.execute("DELETE FROM research_uses WHERE project_id = ?", (${JSON.stringify(pid)},))
db.commit(); db.close()
`);

const bads = results.filter((r) => !r.ok);
console.log(`\n${bads.length ? "✗" : "✅"} 考证报告/大纲服务端契约 ${results.length - bads.length}/${results.length} 项通过`);
if (bads.length) {
  console.log("失败：" + bads.map((b) => b.name).join("、"));
  process.exit(1);
}
