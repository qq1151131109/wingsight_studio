/**
 * 回归：分集（一张剧本卡 = 一集）。
 * 纯函数段：nodesOfEpisode / episodeStatsLine / applyOps 归属继承（同批连线源卡
 *   继承、显式 episode_id、资产卡不继承）/ 复制粘贴继承 / sanitize 悬空清理。
 * 浏览器段：摘要「本集：…」与 ⟨集名⟩ 标记、剧本卡「下载本集」按集打包 zip
 *   （python3 zipfile 解包断言只含本集媒体）。
 * 前置：agent(8123) + 前端(8008) 在跑。
 * 运行：pnpm dlx tsx scripts/episode-inherit-test.mjs
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { chromium } from "playwright";
import {
  applyOps,
  useCanvasStore,
} from "../lib/canvas/ops.ts";
import {
  episodeStatsLine,
  nodesOfEpisode,
  summarizeCanvas,
} from "../lib/canvas/store.ts";
import { sanitizeCanvas } from "../lib/canvas/sanitize.ts";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

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

const mkNode = (id, nodeType, data = {}) => ({
  id,
  type: nodeType,
  position: { x: 0, y: 0 },
  data: { nodeType, title: "", body: "", ...data },
});

// ---------- 纯函数段 ----------
{
  const nodes = [
    mkNode("n_ep1", "script", { title: "第一集 潮起" }),
    mkNode("n_ep2", "script", { title: "第二集 潮落" }),
    mkNode("n_sl1", "shotlist", { title: "分镜表1", episodeId: "n_ep1", rows: [{ rid: "r1" }] }),
    mkNode("n_img1", "image", { title: "镜头01图", episodeId: "n_ep1", imageUrl: "/a.png" }),
    mkNode("n_img2", "image", { title: "镜头01图", episodeId: "n_ep2", imageUrl: "/b.png" }),
    mkNode("n_asset", "character", { title: "老陈", imageUrl: "/c.png" }),
  ];
  const ep1 = nodesOfEpisode(nodes, "n_ep1").map((n) => n.id);
  check(
    "E1 nodesOfEpisode：剧本卡本身 + 本集产物，不含他集/资产",
    ep1.join(",") === "n_ep1,n_sl1,n_img1",
    ep1.join(","),
  );
  check(
    "E2 episodeStatsLine 统计本集产物",
    episodeStatsLine(nodes, "n_ep1") === "分镜表 1 · 镜头图 1",
    episodeStatsLine(nodes, "n_ep1"),
  );
  check("E3 空集不产噪声", episodeStatsLine(nodes, "n_ep_missing") === "");

  // applyOps 归属继承：同批 connect_nodes 的源卡是分镜表（带集）→ 新图卡继承
  useCanvasStore.setState({ nodes: structuredClone(nodes), edges: [] });
  applyOps([
    { op: "add_node", nodeType: "image", id: "IMG_1", title: "镜头02图" },
    { op: "connect_nodes", fromId: "n_sl1", toId: "IMG_1" },
  ]);
  const img1 = useCanvasStore.getState().nodes.find((n) => n.id === "IMG_1");
  check(
    "E4 applyOps 同批连线继承：图卡自动归属分镜表的集",
    img1?.data.episodeId === "n_ep1",
    String(img1?.data.episodeId),
  );

  // 显式 episodeId 优先 + 资产卡不继承
  applyOps([
    { op: "add_node", nodeType: "shotlist", id: "SL_2", episodeId: "n_ep2" },
    { op: "add_node", nodeType: "character", id: "CH_1", title: "小林" },
    { op: "connect_nodes", fromId: "n_ep1", toId: "CH_1" },
  ]);
  const st2 = useCanvasStore.getState().nodes;
  check(
    "E5 显式 episodeId 生效",
    st2.find((n) => n.id === "SL_2")?.data.episodeId === "n_ep2",
    String(st2.find((n) => n.id === "SL_2")?.data.episodeId),
  );
  check(
    "E6 资产卡不继承（跨集共享）",
    st2.find((n) => n.id === "CH_1")?.data.episodeId === undefined,
    String(st2.find((n) => n.id === "CH_1")?.data.episodeId),
  );

  // 复制粘贴继承（selected 是节点级字段）
  useCanvasStore.setState({
    nodes: [
      {
        ...mkNode("n_cp", "image", { title: "镜头图", episodeId: "n_ep1" }),
        selected: true,
      },
    ],
    edges: [],
  });
  useCanvasStore.getState().copySelection();
  const pastedIds = useCanvasStore.getState().pasteClipboard();
  const pasted = useCanvasStore.getState().nodes.find((n) => n.id === pastedIds[0]);
  check(
    "E7 复制粘贴继承归属",
    pasted?.data.episodeId === "n_ep1",
    String(pasted?.data.episodeId),
  );

  // sanitize 悬空清理
  const san = sanitizeCanvas(
    [mkNode("n_orphan", "image", { title: "孤儿图", episodeId: "n_ep_gone" })],
    [],
  );
  check(
    "E8 sanitize 清悬空 episodeId",
    san.fixedEpisodes === 1 && san.nodes[0]?.data.episodeId === undefined,
    `fixedEpisodes=${san.fixedEpisodes}`,
  );

  // 摘要可见性
  const sum = summarizeCanvas(nodes, [], [], 2000, 1);
  check(
    "E9 摘要：剧本卡行带本集统计",
    sum.includes("（本集：分镜表 1 · 镜头图 1）"),
    sum.split("\n").find((l) => l.includes("n_ep1")) ?? "",
  );
  check(
    "E10 摘要：产物卡行尾带 ⟨集名⟩、资产卡不带",
    sum.includes("⟨第一集 潮起⟩") &&
      !/n_asset.*⟨第[一二]集/.test(sum),
    sum.split("\n").filter((l) => l.includes("⟨")).join(" | ").slice(0, 160),
  );
}

// ---------- 浏览器段 ----------
const assetsDir = new URL("../agent/static/assets/", import.meta.url);
const pngs = execSync(`ls '${assetsDir.pathname}' | grep -E '\\.png$' | head -6`, {
  encoding: "utf8",
})
  .trim()
  .split("\n");
const U = (f) => `/agent-service/assets/${f}`;
const [FA, FB, FC] = [pngs[0], pngs[1], pngs[2]];

const { body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-episode-${Date.now()}` }),
});
const pid = proj.id ?? proj.project?.id;
console.log(`测试项目: ${pid}`);

await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    viewport: { x: 0, y: 0, zoom: 0.6 },
    nodes: [
      { ...mkNode("n_ep1", "script", { title: "第一集 潮起", body: "第一集正文" }), position: { x: 0, y: 0 } },
      { ...mkNode("n_ep2", "script", { title: "第二集 潮落", body: "第二集正文" }), position: { x: 0, y: 520 } },
      { ...mkNode("n_sl1", "shotlist", { title: "第一集分镜", episodeId: "n_ep1", rows: [{ rid: "r1", action: "镜头一" }] }), position: { x: 900, y: 0 } },
      { ...mkNode("n_img1", "image", { title: "镜头01图", episodeId: "n_ep1", imageUrl: U(FA), status: "ready" }), position: { x: 1400, y: 0 } },
      { ...mkNode("n_img1b", "image", { title: "镜头02图", episodeId: "n_ep1", imageUrl: U(FB), status: "ready" }), position: { x: 1400, y: 280 } },
      { ...mkNode("n_img2", "image", { title: "镜头01图", episodeId: "n_ep2", imageUrl: U(FC), status: "ready" }), position: { x: 900, y: 520 } },
      { ...mkNode("n_asset", "character", { title: "老陈", imageUrl: U(FC) }), position: { x: 0, y: 1040 } },
    ],
  }),
});

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
if (TOKEN)
  await context.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    ["wingsight_studio_token", TOKEN],
  );
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(`${BASE}/project/${pid}`);
await page.waitForSelector(".react-flow__node", { timeout: 15000 });
await page.waitForTimeout(800);

const sum = await page.evaluate(() => window.__summarizeCanvas?.() ?? "");
check(
  "B1 画布摘要：剧本卡带本集统计 + 产物卡带 ⟨集名⟩",
  sum.includes("（本集：分镜表 1 · 镜头图 2）") && sum.includes("⟨第一集 潮起⟩"),
  sum.split("\n").filter((l) => l.includes("n_ep1") || l.includes("⟨")).join(" | ").slice(0, 200),
);

const tmp = mkdtempSync(join(tmpdir(), "wsepisode-"));

// B5 加号手柄出生继承：从剧本卡建分镜表 → 自动归属本集
{
  await page.evaluate(() => window.__wsSetViewport?.({ x: 80, y: 120, zoom: 1 }));
  await page.waitForTimeout(500);
  const card = page.locator('[data-id="n_ep1"]').first();
  await card.hover();
  await page.waitForTimeout(300);
  // 点连线锚点（.react-flow__handle）而非 .ws-plus 浮层：浮层带磁性追踪、
  // 位置随鼠标动，Playwright 稳定性检查永不满足；锚点静态可点，语义相同
  await card.locator(".react-flow__handle-right").click();
  const menuOpened = await page
    .waitForSelector("text=建下游卡", { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check("B5a 加号菜单打开", menuOpened);
  if (menuOpened) {
    await page.getByRole("button", { name: "分镜表", exact: true }).last().click();
    await page.waitForTimeout(600);
    const inherited = await page.evaluate(() => {
      const st = window.__wsCanvasStore.getState();
      const n = st.nodes.find(
        (x) => x.data.nodeType === "shotlist" && x.id !== "n_sl1",
      );
      return n ? { id: n.id, ep: n.data.episodeId } : null;
    });
    check(
      "B5 加号手柄建分镜表 → 出生继承本集",
      inherited?.ep === "n_ep1",
      JSON.stringify(inherited),
    );
  } else {
    check("B5 加号手柄建分镜表 → 出生继承本集", false, "菜单未打开");
  }
}

try {
  // B5 建卡后视口飞到了新卡，先把 n_ep1 拉回视口再点工具条
  await page.evaluate(() => window.__wsSetViewport?.({ x: 80, y: 120, zoom: 1 }));
  await page.waitForTimeout(600);
  await page.locator('[data-id="n_ep1"]').first().click();
  await page.waitForTimeout(400);
  const dlPromise = page.waitForEvent("download");
  dlPromise.catch(() => undefined);
  await page.getByRole("button", { name: "下载本集" }).click({ timeout: 8000 });
  const dl = await dlPromise;
  const path = join(tmp, dl.suggestedFilename());
  await dl.saveAs(path);
  check(
    "B2 zip 名 = {项目名}-{集名}-媒体-时间戳.zip",
    /第一集 潮起-媒体-\d{8}-\d{4}\.zip$/.test(dl.suggestedFilename()),
    dl.suggestedFilename(),
  );
  const info = JSON.parse(
    execSync(
      `python3 -c "import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({'names':z.namelist()}))" '${path}'`,
      { encoding: "utf8" },
    ),
  );
  const names = info.names.filter((n) => n !== "清单.json");
  check(
    "B3 zip 只含本集 2 个媒体（他集镜头图/共享资产不进包）",
    names.length === 2 && info.names.includes("清单.json"),
    info.names.join(" | "),
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

check("B4 页面无 console 错误", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

await browser.close();
await api(`/projects/${pid}`, { method: "DELETE" }).catch(() => undefined);

const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "✓✓ 分集回归通过" : "✗ 分集回归未过"}（${results.filter((r) => r.ok).length}/${results.length}）`);
process.exit(pass ? 0 : 1);
