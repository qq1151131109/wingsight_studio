/**
 * 调研主体库与显式复用回归（2026-09-11）：主体化（era + subject_key 全库唯一）、
 * 主体图集（参考图跨项目复用）、显式引用（import）、报告与出图载荷的复用标注。
 *
 * 这一组解决的是用户口径「形成能复用的调研报告，下个项目不用每次调研」：
 * 此前文字靠「撞名」隐式命中、图完全绑在项目节点上，而报告是项目视图——
 * 没有任何地方能看见「库里有什么」。
 *
 * 前置：agent(8123) 在跑。**无 LLM**：主体/图集/主题用 python 直连服务端写入口
 * （imgresearch.upsert_entry / add_subject_refs / replace_topics，与调研落库同一条路）。
 * 用独立的 era 串（e2e-era-*）保证不污染真实复用域，跑完连项目带主体一并删。
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

/** 直连服务端写入口（与调研落库同一条路，不重复实现 SQL） */
function py(code) {
  return execFileSync("uv", ["run", "python", "-c", code], {
    cwd: AGENT_DIR,
    encoding: "utf-8",
    env: { ...process.env, ALL_PROXY: "", all_proxy: "", HTTP_PROXY: "", http_proxy: "", HTTPS_PROXY: "", https_proxy: "" },
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

// 独立 era：不碰真实复用域（跑完按它整批清掉）
const ERA = `e2e-era-${Date.now().toString(36)}`;
const NAME_A = `e2e-库A-${Date.now().toString(36)}`;
const NAME_B = `e2e-库B-${Date.now().toString(36)}`;
const ASSET = "三品官服";
const FACT = "唐制：三品以上服紫，佩金玉带；常见误用：套用明清补服。";
const REF_URL = "/agent-service/assets/e2e_lib_ref1.png";

async function makeProject(name, era, nodeId, nodeTitle, secondNodeId) {
  const { body: proj } = await api("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const pid = proj.id ?? proj.project?.id;
  const nodes = [
    { id: nodeId, type: "costume", position: { x: 0, y: 0 }, data: { nodeType: "costume", title: nodeTitle } },
  ];
  if (secondNodeId) {
    nodes.push({ id: secondNodeId, type: "costume", position: { x: 320, y: 0 }, data: { nodeType: "costume", title: "紫袍" } });
  }
  await api(`/projects/${pid}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 }, meta: { era } }),
  });
  return pid;
}

// ---------- 前置：A 项目产出主体 + 图集（照调研落库那条路） ----------
const A = await makeProject(NAME_A, ERA, "N_A1", ASSET);
const B = await makeProject(NAME_B, ERA, "N_B1", ASSET, "N_B2");
const C = await makeProject(`e2e-库C-${Date.now().toString(36)}`, "", "N_C1", ASSET);

py(`
import imgresearch as ir
sk = ir.asset_subject(${JSON.stringify(ERA)}, ${JSON.stringify(A)}, ${JSON.stringify(ASSET)})
ir.upsert_entry(${JSON.stringify(A)}, body=${JSON.stringify(FACT)},
                node_id="N_A1", asset_name=${JSON.stringify(ASSET)}, asset_type="costume",
                era=${JSON.stringify(ERA)},
                sources=[{"title": "唐会要", "url": "http://ex.com/t", "domain": "ex.com"}])
ir.add_subject_refs(${JSON.stringify(ERA)}, sk, [
    {"assetUrl": ${JSON.stringify(REF_URL)}, "title": "紫袍图", "sourceUrl": "http://ex.com/p", "sourceDomain": "ex.com"},
])
print("seeded")
`);

// ---------- A. 库读面：跨项目列主体，标出处与图集张数 ----------
{
  const { status, body } = await api(`/projects/${B}/refs/library`);
  const item = (body.items ?? []).find((i) => i.assetName === ASSET);
  check("A1 库读面：B 项目能看到 A 产出的主体", status === 200 && Boolean(item),
        `status=${status} items=${(body.items ?? []).length}`);
  check("A2 库条目带出处与图集张数",
        item?.fromProject === NAME_A && item?.refCount === 1 && item?.used === false,
        JSON.stringify({ from: item?.fromProject, refs: item?.refCount, used: item?.used }));
  check("A3 库条目不返回正文以外的实现细节（id/subjectKey 齐备）",
        typeof item?.id === "string" && item.id.length > 0 && typeof item?.subjectKey === "string",
        JSON.stringify({ id: item?.id, key: item?.subjectKey }));
  const { body: own } = await api(`/projects/${A}/refs/library`);
  const ownItem = (own.items ?? []).find((i) => i.assetName === ASSET);
  check("A4 产出方自己也算已引用（落主体时就记了引用，报告才看得见自己的考据）",
        Boolean(ownItem) && ownItem.used === true, JSON.stringify(ownItem?.used));
}

// ---------- B. 显式引用：挂到画布卡，之后报告与载荷都带上 ----------
{
  const { body: before } = await api(`/projects/${B}/refs/library`);
  const entryId = (before.items ?? []).find((i) => i.assetName === ASSET)?.id;
  const { status, body } = await api(`/projects/${B}/refs/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId, targetKind: "node", targetKey: "N_B1" }),
  });
  check("B1 引用成功（挂到画布卡）", status === 200 && body.ok === true, `status=${status}`);
  const { body: after } = await api(`/projects/${B}/refs/library`);
  const item = (after.items ?? []).find((i) => i.assetName === ASSET);
  check("B2 引用后 used=true", item?.used === true, String(item?.used));

  const uses = py(`
import sqlite3, imgresearch as ir
db = sqlite3.connect(str(ir.DB_PATH))
print(db.execute("SELECT COUNT(*) FROM research_uses WHERE project_id = ? AND target_kind='node' AND target_key='N_B1'",
                 (${JSON.stringify(B)},)).fetchone()[0])
`);
  check("B3 引用幂等：重复引用只留一条 uses", uses === "1", `rows=${uses}`);
  await api(`/projects/${B}/refs/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId, targetKind: "node", targetKey: "N_B1" }),
  });
  const uses2 = py(`
import sqlite3, imgresearch as ir
db = sqlite3.connect(str(ir.DB_PATH))
print(db.execute("SELECT COUNT(*) FROM research_uses WHERE project_id = ? AND target_kind='node' AND target_key='N_B1'",
                 (${JSON.stringify(B)},)).fetchone()[0])
`);
  check("B4 再引用一次仍只有一条（INSERT OR IGNORE）", uses2 === "1", `rows=${uses2}`);

  const { body: rep } = await api(`/projects/${B}/refs/report`);
  check("B5 报告带上事实并标注复用出处",
        String(rep.text).includes("三品以上服紫") && String(rep.text).includes(`复用自《${NAME_A}》`),
        String(rep.text).slice(0, 200));
  check("B6 报告标注主体图集张数（跨项目可复用）",
        String(rep.text).includes("主体图集"), String(rep.text).split("\n").slice(0, 3).join(" / "));
  const head = (rep.entries ?? []).find((e) => e.assetName === ASSET);
  check("B7 报告条目的归属是主体键（不是项目+节点）",
        head?.subjectKey === `asset:${ASSET}`,
        String(head?.subjectKey));
}

// ---------- C. 出图载荷：事实进提示词、图集进参考序列且标出处 ----------
{
  const out = py(`
import json, skills
shots = [{"rid": "N_B1", "name": ${JSON.stringify(ASSET)}, "assetType": "costume", "visual_notes": ""}]
out = skills._inject_research_briefs(shots, ${JSON.stringify(B)})[0]
refs = skills._inject_canvas_refs(shots, ${JSON.stringify(B)})[0]
print(json.dumps({
  "notes": out.get("visual_notes", ""),
  "images": refs.get("reference_images") or refs.get("referenceImages") or [],
  "labels": refs.get("reference_labels") or refs.get("referenceLabels") or [],
}, ensure_ascii=False))
`);
  const payload = JSON.parse(out);
  check("C1 引用后出图提示词带上主体事实",
        payload.notes.includes("考据依据") && payload.notes.includes("三品以上服紫"),
        payload.notes.slice(0, 120));
  check("C2 主体图集进参考序列", payload.images.includes(REF_URL), JSON.stringify(payload.images));
  check("C3 参考标签写明复用出处",
        JSON.stringify(payload.labels).includes(`复用《${NAME_A}》`),
        JSON.stringify(payload.labels));
}

// ---------- D. 主题复用：库命中即标 reused、记引用、不重搜 ----------
{
  py(`
import imgresearch as ir
ir.replace_topics(${JSON.stringify(A)}, [{"title": "唐制官服品级", "queries": ["唐 官服 品级"], "nodeIds": ["N_A1"]}])
ir.upsert_entry(${JSON.stringify(A)}, body="唐制官服按品级分色：三品以上紫。",
                asset_name="唐制官服品级", asset_type="topic", era=${JSON.stringify(ERA)},
                topic_key="唐制官服品级")
ir.replace_topics(${JSON.stringify(B)}, [{"title": "唐制官服品级", "queries": ["唐 官服 品级"], "nodeIds": ["N_B2"]}])
print("topics ready")
`);
  const { status, body } = await api(`/projects/${B}/refs/outline/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topicKeys: ["唐制官服品级"] }),
  });
  check("D1 主题执行受理（库命中路径）", status === 200 && Array.isArray(body.started), `status=${status}`);
  await new Promise((r) => setTimeout(r, 3000));
  const { body: outline } = await api(`/projects/${B}/refs/outline`);
  const t = (outline.topics ?? []).find((x) => x.topicKey === "唐制官服品级");
  check("D2 库命中标「复用自《A》」且不重搜",
        String(t?.status) === "reused" && String(t?.reusedFrom) === NAME_A,
        JSON.stringify({ status: t?.status, from: t?.reusedFrom }));
  check("D3 复用主题把事实分发给成员卡",
        String(outline.text).includes("三品以上紫") || JSON.stringify(t?.entry).includes("三品以上紫"),
        String(outline.text).slice(0, 160));
}

// ---------- E. 边界：无 era 无库、幻觉目标被拒 ----------
{
  const { body: noEra } = await api(`/projects/${C}/refs/library`);
  check("E1 未设 era 的项目库为空且明说原因",
        noEra.era === "" && (noEra.items ?? []).length === 0,
        JSON.stringify({ era: noEra.era, n: (noEra.items ?? []).length }));
  const { body: libA } = await api(`/projects/${A}/refs/library`);
  const entryId = (libA.items ?? []).find((i) => i.assetName === ASSET)?.id;
  const { status: s400 } = await api(`/projects/${B}/refs/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId, targetKind: "node", targetKey: "N_不存在" }),
  });
  check("E2 引用不存在的画布卡 → 400（不静默找回）", s400 === 400, `status=${s400}`);
  const { status: s404 } = await api(`/projects/${B}/refs/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId: "nope", targetKind: "node", targetKey: "N_B1" }),
  });
  check("E3 引用不存在的主体 → 404", s404 === 404, `status=${s404}`);

  // 迁移/维护幂等：初始化跑第二遍不报错、不重复回填
  const again = py(`
import imgresearch as ir
before = None
import sqlite3
db = sqlite3.connect(str(ir.DB_PATH))
before = db.execute("SELECT COUNT(*) FROM research_subject_refs").fetchone()[0]
ir.init_ref_research_db()
after = db.execute("SELECT COUNT(*) FROM research_subject_refs").fetchone()[0]
print(f"{before}:{after}")
`);
  check("E4 初始化/迁移幂等（图集不重复回填）",
        again.split(":")[0] === again.split(":")[1], again);
}

// ---------- F. 浏览器：报告卡正文只读 + 「同题材库」入口在位 ----------
{
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(`${BASE}/project/${B}`, { waitUntil: "domcontentloaded" });
  // 打开项目会对账一次 → 报告卡落到画布上
  const card = page.locator(".react-flow__node", { hasText: "资产考证报告" }).first();
  let cardOk = false;
  try {
    await card.waitFor({ state: "attached", timeout: 15000 });
    cardOk = true;
  } catch {
    cardOk = false;
  }
  check("F1 打开项目对账后报告卡在位（复用事实已上卡）", cardOk);
  if (cardOk) {
    const info = await card.evaluate((el) => ({
      // 只读判定：报告卡正文不再是可编辑 textarea（手改会被对账覆盖，改了个寂寞）
      textareas: el.querySelectorAll("textarea").length,
      hasReadonlyHint: (el.textContent ?? "").includes("系统生成 · 只读"),
      mentionsReuse: (el.textContent ?? "").includes("复用自《"),
    }));
    check("F2 报告卡正文只读（无 textarea）+ 明示只读", info.textareas === 0 && info.hasReadonlyHint,
          JSON.stringify(info));
    check("F3 报告卡上能看到复用出处", info.mentionsReuse, String(info.mentionsReuse));
    // 工具条「同题材库」：选中卡后才上浮（NodeToolbar）
    await card.click();
    await page.waitForTimeout(600);
    const libBtn = page.locator('.react-flow__node-toolbar button:has-text("同题材库")');
    const libCount = await libBtn.count();
    check("F4 工具条有「同题材库」入口", libCount > 0, `count=${libCount}`);
    if (libCount > 0) {
      await libBtn.first().click();
      await page.waitForTimeout(1200);
      const dialog = page.locator("text=同题材可复用考据");
      const dCount = await dialog.count();
      check("F5 库面板打开并列出可引用主体", dCount > 0, `count=${dCount}`);
      if (dCount > 0) {
        const body = await page.locator("body").innerText();
        check("F6 面板标出处与图集张数",
              body.includes("来自《") && body.includes("参考图 1 张"),
              body.slice(0, 120).replace(/\n/g, " / "));
      }
      await page.keyboard.press("Escape").catch(() => {});
      await page.locator('button[aria-label="关闭"]').first().click().catch(() => {});
    }
  }
  await browser.close();
}

// ---------- 清理 ----------
for (const pid of [A, B, C]) await api(`/projects/${pid}`, { method: "DELETE" });
py(`
import sqlite3, imgresearch as ir
db = sqlite3.connect(str(ir.DB_PATH))
era = ${JSON.stringify(ERA)}
db.execute("DELETE FROM research_entries WHERE era = ?", (era,))
db.execute("DELETE FROM research_subject_refs WHERE era = ?", (era,))
for pid in (${JSON.stringify(A)}, ${JSON.stringify(B)}, ${JSON.stringify(C)}):
    db.execute("DELETE FROM research_uses WHERE project_id = ?", (pid,))
    db.execute("DELETE FROM research_topics WHERE project_id = ?", (pid,))
    db.execute("DELETE FROM research_entries WHERE project_id = ?", (pid,))
db.commit(); db.close()
print("cleaned")
`);

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? "✗" : "✅"} 调研主体库 ${results.length - bad.length}/${results.length} 项通过`);
if (bad.length) {
  console.log("失败：" + bad.map((b) => b.name).join("、"));
  process.exit(1);
}
