/**
 * E2E：分镜行出图的两条连贯/造型规则（route mock，不出真图）。
 *  A. 相邻镜头连贯——同场次上一镜的镜头图进参考（type=shotref 标签）；
 *     跨场次不配（上一镜在别的场，调子不同，配了反而拖偏）。
 *  B. 近景造型闸——角色有 Look 图而本行未指定用哪套时点名；远景不点名
 *     （看不清服装的景别提示只会变成噪音）。
 * 隔离：自建测试项目（直连 API 落画布 + ?pid= 直达），结束删除。
 *
 * 前置：agent(8123) + 前端(8008) 在跑；⚠ 前端必须**开发模式**
 * （__wsCanvasStore 仅在 NODE_ENV!=production 暴露，`./start_wingsight.sh dev`）。
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;
const png1px =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const IMG_PREV = `${API.replace("/agent-service", "")}/agent-service/assets/prev-shot.webp`;
const IMG_CHAR = "/agent-service/assets/char-sheet.webp";
const IMG_LOOK = "/agent-service/assets/look-rain.webp";

function envLocal(key) {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return "";
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
    headers: {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-shot-continuity-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;
console.log(`测试项目: ${pid}`);

// 四行：r1/r2 同场（御书房·夜）+ 近景；r3 换场；r4 回到御书房但远景
const rows = [
  { rid: "r1", scene: "御书房·夜", shotSize: "近景", action: "@小雨 在案前展开密信", imageNodeId: "n_img1" },
  { rid: "r2", scene: "御书房·夜", shotSize: "近景", action: "@小雨 把密信按在灯上" },
  { rid: "r3", scene: "街市·清晨", shotSize: "近景", action: "@小雨 穿过街市" },
  { rid: "r4", scene: "御书房·夜", shotSize: "远景", action: "@小雨 伏在案上" },
];
const nodes = [
  { id: "n_sc", type: "script", position: { x: 0, y: 0 }, data: { nodeType: "script", title: "测试剧本", body: "雨夜，小雨在御书房看密信。" } },
  { id: "n_sl", type: "shotlist", position: { x: 300, y: 0 }, data: { nodeType: "shotlist", title: "分镜表", rows, status: "ready" } },
  { id: "n_char", type: "character", position: { x: 0, y: 300 }, data: { nodeType: "character", title: "小雨", body: "十七岁，短发，青色常服。", imageUrl: IMG_CHAR, status: "ready" } },
  // Look 卡：image 卡 + 来自资产卡的连线（isLookCard 判定）
  { id: "n_look", type: "image", position: { x: 300, y: 300 }, data: { nodeType: "image", title: "小雨·雨夜装", body: "青色常服外披蓑衣。", imageUrl: IMG_LOOK, status: "ready" } },
  { id: "n_img1", type: "image", position: { x: 600, y: 0 }, data: { nodeType: "image", title: "镜头 01 图", body: "", imageUrl: IMG_PREV, status: "ready" } },
];
await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    nodes,
    edges: [
      { id: "e1", source: "n_sc", target: "n_sl" },
      { id: "e2", source: "n_char", target: "n_look" },
      { id: "e3", source: "n_sl", target: "n_img1" },
    ],
    viewport: { x: 0, y: 0, zoom: 0.6 },
    meta: { visualStyle: "水墨写意" },
  }),
});

// ---------- route mock：抓出图请求 + 回一个立即完成的 job ----------
let posted = null;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
const dialogs = [];
page.on("dialog", (d) => {
  dialogs.push(d.message());
  void d.accept();
});

await page.route("**/agent-service/storyboard/images", async (route) => {
  if (route.request().method() !== "POST") return route.fallback();
  posted = JSON.parse(route.request().postData() ?? "{}");
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "e2e_imgjob" }) });
});
await page.route("**/agent-service/storyboard/images/e2e_imgjob", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      status: "done",
      images: ["r1", "r2", "r3", "r4"].map((rid) => ({
        rid,
        ok: true,
        imageUrl: png1px,
        // r1 带未考证留痕：图出了但补考据软失败——批次条上要能看见
        ...(rid === "r1" ? { researchNote: "未考证：补考据失败（模拟）" } : {}),
      })),
    }),
  }),
);

await page.goto(`${BASE}/project/${pid}`);
// dev 模式首访要现编，等钩子挂上再动（固定 sleep 在冷启动时会假失败）
await page.waitForFunction(() => Boolean(window.__wsCanvasStore), null, { timeout: 60000 });
await page.waitForTimeout(1200);
await page.evaluate(() => window.__wsSetViewport?.({ x: 0, y: 0, zoom: 0.6 }));
await page.evaluate(() => {
  const st = window.__wsCanvasStore.getState();
  const shot = st.nodes.find((n) => n.data.nodeType === "shotlist");
  if (shot) st.selectNodes([shot.id]);
});
await page.waitForTimeout(500);

const btn = page.locator('button[aria-label^="勾选行批量出图"]');
check("出图按钮可见（4 镜全选）", (await btn.count()) === 1, await btn.getAttribute("aria-label").catch(() => ""));
await btn.click();
await page.waitForTimeout(6000); // 弹窗 → 确认 → 请求发出

// ---------- B. 近景造型闸 ----------
const ask = dialogs.join("\n");
check("B1 近景行被点名「有造型图未指定用哪套」", /镜1、镜2、镜3/.test(ask) || /有造型图但本行未指定/.test(ask), ask.slice(0, 200));
check("B2 点名到角色名", ask.includes("小雨"), ask.slice(0, 200));
check("B3 远景行不点名（看不清服装不提示）", !/镜4/.test(ask), ask.slice(0, 200));

// ---------- A. 相邻镜头连贯 ----------
check("A0 出图请求已发出", Boolean(posted) && Array.isArray(posted.shots), JSON.stringify(Object.keys(posted ?? {})));
const shotOf = (rid) => (posted?.shots ?? []).find((s) => s.rid === rid);
const labelsOf = (rid) => (shotOf(rid)?.referenceLabels ?? []).map((l) => l.type);
const refsOf = (rid) => shotOf(rid)?.referenceImages ?? [];

check("A1 同场 r2 带上 r1 的镜头图", refsOf("r2").includes(IMG_PREV), JSON.stringify(refsOf("r2")));
check("A2 且带 shotref 职责标签", labelsOf("r2").includes("shotref"), JSON.stringify(shotOf("r2")?.referenceLabels));
check(
  "A3 shotref 标签位次与图对齐",
  (shotOf("r2")?.referenceLabels ?? []).length === refsOf("r2").length,
  `refs=${refsOf("r2").length} labels=${(shotOf("r2")?.referenceLabels ?? []).length}`,
);
check("A4 shotref 名写明场次", /上一镜（御书房·夜）/.test(JSON.stringify(shotOf("r2")?.referenceLabels ?? [])), JSON.stringify(shotOf("r2")?.referenceLabels));
check("A5 换场 r3 不带上一镜（跨场不配）", !refsOf("r3").includes(IMG_PREV), JSON.stringify(refsOf("r3")));
check("A6 远景 r4 同场但不带（r3 在别的场）", !refsOf("r4").includes(IMG_PREV), JSON.stringify(refsOf("r4")));
check("A7 首镜 r1 没有上一镜可带", !refsOf("r1").includes(IMG_PREV), JSON.stringify(refsOf("r1")));
check("A8 角色定妆照仍是参考（资产优先于连贯）", refsOf("r2").includes(IMG_CHAR), JSON.stringify(refsOf("r2")));

// ---------- C. 未考证留痕（真实题材补考据软失败不许无声） ----------
await page.waitForTimeout(4000); // 等轮询把结果落卡
const bar = await page
  .locator('[data-id="n_sl"]')
  .innerText()
  .catch(() => "");
check("C1 批次条统计未考证 N", /未考证\s*1/.test(bar), bar.replace(/\n/g, " ").slice(-160));
const noted = await page.evaluate(() => {
  const st = window.__wsCanvasStore.getState();
  const rows = st.nodes.find((n) => n.id === "n_sl")?.data.rows ?? [];
  const r1 = rows.find((r) => r.rid === "r1");
  const img = st.nodes.find((n) => n.id === r1?.imageNodeId);
  return String(img?.data?.genShot?.researchNote ?? "");
});
check("C2 留痕落进图卡 genShot（节点信息可见）", noted.startsWith("未考证"), noted || "(空)");

await browser.close();
await api(`/projects/${pid}`, { method: "DELETE" });

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? "✗" : "✅"} 分镜连贯/造型闸 ${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
