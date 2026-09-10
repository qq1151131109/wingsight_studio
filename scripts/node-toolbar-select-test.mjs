/**
 * 卡上悬浮工具条的显隐语义回归（2026-09-10「多选时每张卡都浮一条工具条」事故）。
 *
 * 根因：CardShell 显式传了 `isVisible={selected}`，整体覆盖了 xyflow NodeToolbar
 * 的默认守卫（默认 = 本卡是唯一选中卡时才显示：nodes.size===1 && selected &&
 * selectedNodesCount===1）。于是「已选 102」时画布上并排浮出 102 条工具条。
 *
 * 断言：
 *   A 单选一张 → 恰 1 条工具条，且按钮真能点（点「节点信息」开弹窗，防"整体失效"假绿）
 *   B Cmd+A 全选 → 0 条卡上工具条（NodeToolbar 非 active 时直接返回 null，DOM 无残留）
 *   C 多选工具条（选区工具条）同时在位（「已选 N」+ 成组按钮）——隐藏的是逐卡工具条，
 *     不是把多选能力一起藏了
 *   D 点空白清空 → 0 条
 *   E 回到单选 → 工具条复现 1 条（显隐可逆，不是一次性消失）
 *
 * 前置：agent(8123) + 前端在跑。无 LLM。自建临时项目，结束删除。
 *   （选中数断言走 DOM `.ws-node.is-selected`，不依赖 __wsCanvasStore 调试钩子，
 *    生产模式前端也能跑；工具条在 NodeToolbar 非 active 时 DOM 里根本不渲染）
 * 运行：node scripts/node-toolbar-select-test.mjs
 *      WS_BASE=http://127.0.0.1:8010 node scripts/...   # 指到别的前端实例
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.WS_BASE || "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;

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

// ---------- 临时项目：四张 note 卡横排 ----------
const { body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-toolbar-select-${Date.now()}` }),
});
const pid = proj.id ?? proj.project?.id;
if (!pid) {
  console.error("建项目失败：", JSON.stringify(proj).slice(0, 300));
  process.exit(1);
}
const IDS = ["n_tb_1", "n_tb_2", "n_tb_3", "n_tb_4"];
await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    nodes: IDS.map((id, i) => ({
      id,
      type: "note",
      position: { x: i * 480, y: 0 },
      data: { nodeType: "note", title: `工具条卡 ${i + 1}`, body: "选中语义回归夹具" },
    })),
    edges: [],
    viewport: { x: 60, y: 320, zoom: 0.5 },
    meta: {},
  }),
});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
if (TOKEN)
  await ctx.addInitScript(
    ([k, v]) => window.localStorage.setItem(k, v),
    ["wingsight_studio_token", TOKEN],
  );
const page = await ctx.newPage();
await page.goto(`${BASE}/project/${pid}`, { waitUntil: "domcontentloaded" });

/** 卡上工具条条数：NodeToolbar 非 active 时不渲染（DOM 里就是没有） */
const cardToolbars = () => page.locator(".react-flow__node-toolbar").count();
/** 多选工具条的在位标志（SelectionToolbar 自绘，非 node-toolbar） */
const selBar = () => page.getByText(/^已选 \d+$/).count();

try {
  await page.waitForSelector(".react-flow__node", { timeout: 20000 });
  await page.waitForTimeout(800);

  // A. 单选一张：工具条恰 1 条
  await page.locator(`[data-id="${IDS[0]}"]`).first().click();
  await page.waitForTimeout(400);
  const a1 = await cardToolbars();
  check("A1 单选一张卡 → 恰 1 条悬浮工具条", a1 === 1, `toolbars=${a1}`);
  check("A2 单选态没有多选工具条", (await selBar()) === 0);

  // A3 按钮真能点（口径：防「工具条整体失效」被当通过）。注意节点信息弹窗
  //    只认背板点击关闭（没有 Esc 路径），必须点角落背板——留着它会把后面
  //    所有点击都吃掉（本测试首版就在这栽过：Esc 没关掉 → D 假通过）
  await page
    .locator('.react-flow__node-toolbar [aria-label="节点信息"]:visible')
    .first()
    .click({ timeout: 6000 });
  await page.waitForTimeout(500);
  const infoTitle = page.locator("h3", { hasText: "节点信息" });
  const infoOpen = await infoTitle.count();
  await page.mouse.click(20, 20);
  await page.waitForTimeout(400);
  const infoClosed = await infoTitle.count();
  check("A3 单选工具条「节点信息」可点开、可关闭", infoOpen === 1 && infoClosed === 0,
    `open=${infoOpen} afterClose=${infoClosed}`);

  // B. 全选（用户截图那条路径：已选 N）：逐卡工具条应清零
  await page.keyboard.press("Meta+a");
  await page.waitForTimeout(500);
  const selected = await page.locator(".ws-node.is-selected").count();
  const b1 = await cardToolbars();
  check(`B1 全选（${selected} 张）→ 卡上工具条清零`, b1 === 0 && selected === IDS.length,
    `toolbars=${b1} selected=${selected}`);

  // C. 多选工具条必须在位（隐藏的是逐卡工具条，批量能力不能一起没）
  const c1 = await selBar();
  const c2 = await page.locator("button", { hasText: /^成组$/ }).count();
  check("C1 多选工具条在位（已选 N）", c1 === 1, `hits=${c1}`);
  check("C2 多选工具条批量动作在位（成组）", c2 >= 1, `hits=${c2}`);
  // 视觉留证（WS_SHOT=/tmp/x.png 时抓多选态整屏，人眼复核画布干净不干净）
  if (process.env.WS_SHOT) await page.screenshot({ path: process.env.WS_SHOT });

  // D. 清空选择：0 条。点空白画布用裸鼠标坐标（locator.click 会被 xyflow
  //    内部层挡成 not stable）；坐标取画布下半部空处，避开浮层与底坞
  const paneBox = await page.locator(".react-flow__pane").first().boundingBox();
  await page.mouse.click(paneBox.x + 700, paneBox.y + 700);
  await page.waitForTimeout(400);
  const d1 = await cardToolbars();
  const dSel = await page.locator(".ws-node.is-selected").count();
  check("D1 点空白清空选择 → 选择为空且 0 条工具条", d1 === 0 && dSel === 0,
    `toolbars=${d1} selected=${dSel}`);

  // E. 回到单选：工具条复现（显隐可逆）
  await page.locator(`[data-id="${IDS[2]}"]`).first().click();
  await page.waitForTimeout(600);
  const e1 = await cardToolbars();
  const eSel = await page.locator(".ws-node.is-selected").count();
  check("E1 多选回到单选 → 工具条复现 1 条", e1 === 1 && eSel === 1,
    `toolbars=${e1} selected=${eSel}`);

  await browser.close();
  await api(`/projects/${pid}`, { method: "DELETE" });
} catch (e) {
  check("工具条选中语义回归", false, String(e).slice(0, 300));
  try { await browser.close(); } catch { /* 已关 */ }
  await api(`/projects/${pid}`, { method: "DELETE" });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
