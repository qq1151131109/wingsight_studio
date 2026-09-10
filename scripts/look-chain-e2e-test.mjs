/**
 * E2E 实测：造型图全自动链（本次改动的主体）。
 * 验证：角色卡带造型计划（looks）→ 点「造型图·N」→ 真出图 → 造型卡落卡
 *        + 角色→造型卡连线 + 回填 looks[i].imageUrl/nodeId（幂等标记）。
 * 前置：agent(8123) + 前端(8008) 在跑；参考图已在本机 agent/static/assets/。
 * 真出 1 张图（消耗额度）。
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;
const DING = "/agent-service/assets/40a1bab7a404.png"; // 角色定妆照（身份锚点）
const COS = "/agent-service/assets/65a2dc3ef213.png"; // 服饰结构图（形制锚点）

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
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---------- 建项目 + 造画布（剧本卡 / 角色卡带造型计划 / 服饰卡） ----------
const { body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-look-${Date.now()}` }),
});
const pid = proj.id ?? proj.project?.id;
if (!pid) { console.error("建项目失败", proj); process.exit(1); }

const SCRIPT_ID = "n_script_t";
const CHAR_ID = "n_char_t";
const COST_ID = "n_cost_t";
const nodes = [
  {
    id: SCRIPT_ID, type: "script", position: { x: 0, y: 700 },
    data: { nodeType: "script", title: "测试剧本", body: "第一场 日 内 太极殿\n冯太后身着朝服端坐御座，群臣俯首。" },
  },
  {
    id: CHAR_ID, type: "character", position: { x: 60, y: 420 },
    data: {
      nodeType: "character", title: "冯太后", body: "北魏太后，面容清瘦，黑发梳高髻。",
      assetSource: SCRIPT_ID, imageUrl: DING, status: "ready",
      // 造型计划（拆解产出形态）：无 imageUrl，等着出图
      looks: [
        {
          label: "朝服",
          description: "头戴十二旒冕冠，玄色上衣、纁色下裳，衣上织绣章纹，腰系朱组绶带，足着赤舄。",
          costume: "十二旒朝服",
          costumeId: COST_ID,
        },
      ],
    },
  },
  {
    id: COST_ID, type: "costume", position: { x: 620, y: 420 },
    data: {
      nodeType: "costume", title: "十二旒朝服",
      body: "北魏宫廷最高等级礼服，玄色大袖袍配十二旒冕冠。",
      assetSource: SCRIPT_ID, imageUrl: COS, status: "ready",
    },
  },
];
const put = await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    nodes, edges: [], viewport: { x: 0, y: 0, zoom: 0.7 },
    meta: { visualStyle: "古装真人纪录片 cinematic still，真实布景与服化道，35mm/50mm 摄影镜头感，克制调色" },
  }),
});
check("造画布成功（剧本卡+角色卡带 looks+服饰卡）", put.status < 300, `HTTP ${put.status}`);

// ---------- 打开页面 → 点「造型图」→ 等出图 ----------
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("dialog", (d) => void d.accept()); // 「消耗出图额度」确认
page.on("console", (m) => { if (m.type() === "error") console.log("  [浏览器错误]", m.text().slice(0, 160)); });
await page.goto(`${BASE}/project/${pid}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);

// 工具条是 NodeToolbar isVisible={selected}：先选中剧本卡，按钮才出现。
// 点标题栏右端（避开 Editable 正文区，避免误入编辑态）
const scriptNode = page
  .locator(".react-flow__node")
  .filter({ hasText: "测试剧本" })
  .first();
const sbox = await scriptNode.boundingBox();
console.log("剧本卡 boundingBox:", JSON.stringify(sbox));
if (sbox) await page.mouse.click(sbox.x + 30, sbox.y + sbox.height - 12);
await page.waitForTimeout(1500);
const diag = await page.evaluate(() => ({
  bbox: null,
  selected: document.querySelectorAll(".react-flow__node.selected").length,
  toolbars: document.querySelectorAll(".react-flow__node-toolbar").length,
  btns: [...document.querySelectorAll("button")]
    .map((b) => (b.textContent || "").trim())
    .filter(Boolean)
    .slice(0, 24),
}));
console.log("诊断:", JSON.stringify(diag));
await page.screenshot({ path: "/tmp/ws-review/e2e-selected.png" }).catch(() => {});

const btnText = await page.evaluate(() => {
  const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("造型图"));
  return el ? el.textContent.trim() : "";
});
check("「造型图·N」按钮出现（计数=待出造型数）", btnText.includes("造型图·1"), `按钮文案="${btnText}"`);

await page.evaluate(() => {
  const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("造型图"));
  el?.click();
});

// 真出图约 1 分钟：轮询画布直到造型卡落卡
let canvas = null;
let lastStatus = "";
for (let i = 0; i < 60; i += 1) {
  await page.waitForTimeout(3000);
  const r = await api(`/projects/${pid}/canvas`);
  canvas = r.body;
  const lc = (canvas?.nodes ?? []).find((n) => n?.data?.title === "冯太后·朝服");
  if (lc) lastStatus = `status=${lc.data.status} err=${String(lc.data.errorMessage ?? "").slice(0, 140)}`;
  if (lc?.data?.imageUrl) break;
}
console.log("造型卡最终状态:", lastStatus);
await page.screenshot({ path: "/tmp/ws-review/e2e-look-result.png" }).catch(() => {});
await browser.close();

const byId = new Map((canvas?.nodes ?? []).map((n) => [n.id, n]));
const lookCard = byId.get("n_look_placeholder") ?? (canvas?.nodes ?? []).find((n) => n?.data?.title === "冯太后·朝服");
check("造型卡落卡（`角色名·造型名`）", Boolean(lookCard?.data?.imageUrl),
  lookCard ? `标题=${lookCard.data.title} 图=${String(lookCard.data.imageUrl).slice(-24)}` : "未落卡");

const charCard = byId.get(CHAR_ID);
const looks = charCard?.data?.looks ?? [];
check("回填造型账（looks[0].imageUrl + nodeId）",
  Boolean(looks[0]?.imageUrl) && Boolean(looks[0]?.nodeId),
  JSON.stringify({ hasUrl: Boolean(looks[0]?.imageUrl), nodeId: looks[0]?.nodeId }));

const edges = canvas?.edges ?? [];
check("角色→造型卡连线",
  Boolean(lookCard) && edges.some((e) => e.source === CHAR_ID && e.target === lookCard.id),
  `边数=${edges.length}`);
check("服饰→造型卡连线（形制以服饰卡为准）",
  Boolean(lookCard) && edges.some((e) => e.source === COST_ID && e.target === lookCard.id));

// 清理
await api(`/projects/${pid}`, { method: "DELETE" }).catch(() => {});
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
