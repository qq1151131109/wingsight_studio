/**
 * 回归：分集集号与排序（显式集号 + 分集面板 + 聚焦视图）。
 * 纯函数段：episodeList 排序 / addNode 自动排号 / applyOps 显式与自动集号 /
 *   非法集号明报 / moveEpisode 重排归一 / 复制粘贴重排号 / sanitize 脏集号清理 /
 *   摘要「第 N 集」。
 * 浏览器段：底坞「分集」入口与面板列表、点集聚焦（压暗其余 + Esc 退出）、
 *   ↑↓ 重排、剧本卡集号徽标、无 console 错误。
 * 前置：agent(8123) + 前端(8008) 在跑。
 * 运行：pnpm dlx tsx scripts/episode-plan-test.mjs
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import {
  applyOps,
  useCanvasStore,
} from "../lib/canvas/ops.ts";
import {
  episodeLabel,
  episodeList,
  episodeNoOf,
  nextEpisodeNo,
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
  // P1 episodeList：按集号升序，缺号排最后（按画布顺序）
  const nodes = [
    mkNode("n_a", "script", { title: "第二集", episodeNo: 2 }),
    mkNode("n_b", "script", { title: "无号" }),
    mkNode("n_c", "script", { title: "第一集", episodeNo: 1 }),
    mkNode("n_d", "note", { title: "笔记" }),
  ];
  const order = episodeList(nodes).map((n) => n.id);
  check("P1 episodeList 按集号排序、缺号殿后、非剧本卡不进列表", order.join(",") === "n_c,n_a,n_b", order.join(","));
  check("P1b nextEpisodeNo = 最大集号 + 1", nextEpisodeNo(nodes) === 3, String(nextEpisodeNo(nodes)));
  check(
    "P1c episodeLabel 带集号",
    episodeLabel(nodes[0]) === "第 2 集 · 第二集" && episodeLabel(nodes[1]) === "无号",
    `${episodeLabel(nodes[0])} / ${episodeLabel(nodes[1])}`,
  );

  // P2 addNode 自动排号：新建剧本卡排到末尾；显式集号被尊重
  useCanvasStore.setState({ nodes: structuredClone(nodes), edges: [] });
  useCanvasStore.getState().addNode({ position: { x: 0, y: 0 }, data: { nodeType: "script", title: "新集", body: "" } });
  useCanvasStore.getState().addNode({ position: { x: 0, y: 0 }, data: { nodeType: "script", title: "指定集", body: "", episodeNo: 9 } });
  const st2 = useCanvasStore.getState().nodes;
  const auto = st2.find((n) => n.data.title === "新集");
  const forced = st2.find((n) => n.data.title === "指定集");
  check("P2 建剧本卡自动排到末尾（最大+1）", auto?.data.episodeNo === 3, String(auto?.data.episodeNo));
  check("P2b 显式集号被尊重", forced?.data.episodeNo === 9, String(forced?.data.episodeNo));

  // P3 applyOps：agent 建剧本卡同样自动排号；显式集号透传
  useCanvasStore.setState({ nodes: structuredClone(nodes), edges: [] });
  const r3 = applyOps([
    { op: "add_node", nodeType: "script", id: "S_AUTO", title: "agent 新集" },
    { op: "add_node", nodeType: "script", id: "S_NO", title: "agent 指定", episodeNo: 7 },
  ]);
  const st3 = useCanvasStore.getState().nodes;
  check(
    "P3 applyOps 建剧本卡自动排号 / 显式集号生效",
    r3.applied === 2 &&
      st3.find((n) => n.id === "S_AUTO")?.data.episodeNo === 3 &&
      st3.find((n) => n.id === "S_NO")?.data.episodeNo === 7,
    JSON.stringify(st3.filter((n) => n.id.startsWith("S_")).map((n) => [n.id, n.data.episodeNo])),
  );

  // P4 非法集号明报（不静默丢弃）
  const r4 = applyOps([{ op: "add_node", nodeType: "script", id: "S_BAD", episodeNo: 0 }]);
  check(
    "P4 非法集号（0）报错且不落卡",
    r4.applied === 0 && r4.errors.some((e) => e.includes("episodeNo")),
    r4.errors.join(" | ").slice(0, 120),
  );

  // P5 moveEpisode：下移交换 + 整表归一（重复号/缺号一次点击归位）
  useCanvasStore.setState({
    nodes: [
      mkNode("n_1", "script", { title: "A", episodeNo: 1 }),
      mkNode("n_2", "script", { title: "B", episodeNo: 1 }),
      mkNode("n_3", "script", { title: "C" }),
    ],
    edges: [],
  });
  useCanvasStore.getState().moveEpisode("n_1", 1);
  const st5 = useCanvasStore.getState().nodes;
  const no5 = st5.map((n) => [n.data.title, n.data.episodeNo]);
  check(
    "P5 moveEpisode 交换相邻集并归一到 1..N",
    st5.find((n) => n.data.title === "B")?.data.episodeNo === 1 &&
      st5.find((n) => n.data.title === "A")?.data.episodeNo === 2 &&
      st5.find((n) => n.data.title === "C")?.data.episodeNo === 3,
    JSON.stringify(no5),
  );
  // 越界不动作
  useCanvasStore.getState().moveEpisode("n_3", 1);
  check(
    "P5b 末位下移不动作",
    useCanvasStore.getState().nodes.find((n) => n.data.title === "C")?.data.episodeNo === 3,
  );

  // P6 复制粘贴：剧本卡副本重新排号（两张「第 1 集」是事故）
  useCanvasStore.setState({
    nodes: [
      { ...mkNode("n_cp1", "script", { title: "原集", episodeNo: 1 }), selected: true },
      { ...mkNode("n_cp2", "script", { title: "他集", episodeNo: 2 }) },
    ],
    edges: [],
  });
  useCanvasStore.getState().copySelection();
  const pastedIds = useCanvasStore.getState().pasteClipboard();
  const pastedNo = useCanvasStore.getState().nodes.find((n) => n.id === pastedIds[0])?.data.episodeNo;
  check("P6 粘贴的剧本卡排到末尾（不与他集撞号）", pastedNo === 3, String(pastedNo));

  // P7 sanitize：脏集号（字符串/0/负数）与非剧本卡上的集号一并清掉
  const san = sanitizeCanvas(
    [
      mkNode("n_x", "script", { title: "脏号", episodeNo: "3" }),
      mkNode("n_y", "script", { title: "零号", episodeNo: 0 }),
      mkNode("n_z", "image", { title: "挂错卡", episodeNo: 2 }),
      mkNode("n_ok", "script", { title: "正常", episodeNo: 4 }),
    ],
    [],
  );
  check(
    "P7 sanitize 清脏集号（保留合法值）",
    san.fixedEpisodes === 3 &&
      episodeNoOf({ data: san.nodes.find((n) => n.id === "n_ok").data }) === 4,
    `fixedEpisodes=${san.fixedEpisodes}`,
  );

  // P8 摘要：多集项目剧本卡行带「第 N 集」
  const sum = summarizeCanvas(
    [
      mkNode("n_s1", "script", { title: "第一集", episodeNo: 1 }),
      mkNode("n_s2", "script", { title: "第二集", episodeNo: 2 }),
    ],
    [],
    [],
    2000,
    1,
  );
  check("P8 画布摘要带集号", sum.includes("第 1 集") && sum.includes("第 2 集"), sum.split("\n").filter((l) => l.includes("n_s")).join(" | ").slice(0, 160));
}

// ---------- 浏览器段 ----------
const { body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-episode-plan-${Date.now()}` }),
});
const pid = proj.id ?? proj.project?.id;
console.log(`测试项目: ${pid}`);

await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    viewport: { x: 0, y: 0, zoom: 0.7 },
    nodes: [
      { ...mkNode("n_ep1", "script", { title: "第一集 潮起", body: "第一集正文", episodeNo: 1 }), position: { x: 0, y: 0 } },
      { ...mkNode("n_ep2", "script", { title: "第二集 潮落", body: "第二集正文", episodeNo: 2 }), position: { x: 0, y: 520 } },
      { ...mkNode("n_sl1", "shotlist", { title: "第一集分镜", episodeId: "n_ep1", rows: [{ rid: "r1", action: "镜头一" }] }), position: { x: 900, y: 0 } },
    ],
  }),
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
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
await page.waitForTimeout(900);

// B1 底坞「分集」入口 + 面板列表
await page.getByRole("button", { name: "分集" }).click();
const rows = page.locator("[data-episode-id]");
await rows.first().waitFor({ timeout: 5000 });
check(
  "B1 底坞「分集」打开面板并列出两集（按集号排序）",
  (await rows.count()) === 2 &&
    (await rows.nth(0).getAttribute("data-episode-id")) === "n_ep1",
  `${await rows.count()} 行`,
);

// B2 点第 1 集 → 聚焦：本集卡 ws-node-focus、他集卡 ws-node-dimmed
await rows.nth(0).click();
await page.waitForTimeout(700);
const focusCls = await page.evaluate(() => {
  const cls = (id) => document.querySelector(`[data-id="${id}"]`)?.className ?? "";
  return { ep1: cls("n_ep1"), ep2: cls("n_ep2"), sl: cls("n_sl1") };
});
check(
  "B2 聚焦：本集剧本卡与产物高亮、他集压暗",
  focusCls.ep1.includes("ws-node-focus") &&
    focusCls.sl.includes("ws-node-focus") &&
    focusCls.ep2.includes("ws-node-dimmed"),
  JSON.stringify(focusCls),
);

// B2b Esc 退出聚焦
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
const afterEsc = await page.evaluate(
  () => document.querySelector('[data-id="n_ep2"]')?.className ?? "",
);
check("B2b Esc 退出聚焦（压暗解除）", !afterEsc.includes("ws-node-dimmed"), afterEsc);

// B3 ↑↓ 重排：第 2 集上移 → 集号互换
await page.getByRole("button", { name: "第 2 集上移" }).click();
await page.waitForTimeout(500);
const noAfter = await page.evaluate(() => {
  const st = window.__wsCanvasStore.getState();
  const by = (id) => st.nodes.find((n) => n.id === id)?.data.episodeNo;
  return { ep1: by("n_ep1"), ep2: by("n_ep2") };
});
check("B3 ↑ 重排：集号互换", noAfter.ep1 === 2 && noAfter.ep2 === 1, JSON.stringify(noAfter));
const panelOrder = await page
  .locator("[data-episode-id]")
  .evaluateAll((els) => els.map((e) => e.getAttribute("data-episode-id")).join(","));
check("B3b 面板顺序跟随集号刷新", panelOrder === "n_ep2,n_ep1", panelOrder);

// B4 剧本卡集号徽标
const badge = await page
  .locator('[data-id="n_ep2"]')
  .innerText()
  .catch(() => "");
check("B4 剧本卡 footer 显示集号徽标", /第\s*1\s*集/.test(badge), badge.replace(/\n/g, " ").slice(0, 120));

check("B5 页面无 console 错误", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

await browser.close();
await api(`/projects/${pid}`, { method: "DELETE" }).catch(() => undefined);

const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "✓✓ 分集集号回归通过" : "✗ 分集集号回归未过"}（${results.filter((r) => r.ok).length}/${results.length}）`);
process.exit(pass ? 0 : 1);
