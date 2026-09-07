/**
 * E2E：画布媒体批量下载回归（一键下载全部结果）。
 * 纯函数段：collectMediaEntries 收集/去重/范围过滤 + bundleFileName 命名
 *   （候选后缀/非法字符/Windows 保留名/扩展名推断回退）。
 * 浏览器段：右键空白「下载全部媒体」全画布 zip（fflate level 0 + 清单.json）+
 *   多选工具条「下载 N」只下选中卡；zip 用 python3 zipfile 解包断言。
 * 前置：agent(8123) + 前端(8008) 在跑；系统有 python3。
 * 运行：pnpm dlx tsx scripts/bundle-download-test.mjs（tsx 解析 TS import）
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { chromium } from "playwright";
import {
  bundleFileName,
  collectMediaEntries,
  extOf,
} from "/home/shenglin/Desktop/wingsight-studio/lib/canvas/bundleDownload.ts";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;

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

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---------- 纯函数：收集 / 命名 ----------
{
  const mk = (id, data, selected = false) => ({
    id,
    selected,
    position: { x: 0, y: 0 },
    data: { nodeType: "image", title: "", body: "", ...data },
  });
  const A = "/agent-service/assets/a.png";
  const B = "/agent-service/assets/b.png";
  const C = "/agent-service/assets/c.png";
  const V = "/agent-service/assets/v.mp4";
  const W = "/agent-service/assets/w.wav";
  const nodes = [
    mk("n1", { title: "主角", imageUrls: [A, B], imageUrl: A, primaryIndex: 0 }),
    mk("n2", { title: "配角", imageUrl: A }), // 与 n1 候选重复 → 去重
    mk("n3", { title: "动效", videoUrl: V, audioUrl: W, nodeType: "video" }),
    mk("n4", { title: "空卡" }),
  ];
  const all = collectMediaEntries(nodes);
  check(
    "U1 收集：候选全收/单图/视频音频/跨卡去重/空卡跳过",
    all.length === 4 &&
      all[0].url === A && all[0].variant === 1 &&
      all[1].url === B && all[1].variant === 2 &&
      all[2].url === V && all[2].kind === "video" &&
      all[3].url === W && all[3].kind === "audio",
    JSON.stringify(all.map((e) => [e.url, e.kind, e.variant])),
  );
  const scoped = collectMediaEntries(nodes, ["n2", "n3"]);
  check(
    "U2 范围：ids 过滤只收选中卡",
    scoped.length === 3 && scoped[0].url === A && scoped[0].title === "配角",
    JSON.stringify(scoped.map((e) => e.title)),
  );
  const named = (entries) => entries.map((_, i) => bundleFileName(entries, i));
  check(
    "U3 命名：同卡候选统一带「候选N」",
    named(collectMediaEntries([nodes[0]])).join("|") ===
      `01_主角_n1_候选1.png|02_主角_n1_候选2.png`,
    named(collectMediaEntries([nodes[0]])).join("|"),
  );
  const weird = collectMediaEntries([
    mk("n9", { title: "报:*/桌", imageUrl: A }),
    mk("n8", { title: "con", imageUrl: C }),
    mk("n7", { nodeType: "video", title: "无扩展名", videoUrl: "/agent-service/assets/plain", audioUrl: W }),
  ]);
  const wn = named(weird);
  check(
    "U4 命名：非法字符清洗/Windows 保留名加前缀/扩展名按 URL 推断回退 kind 默认",
    wn[0] === "01_报___桌_n9.png" &&
      wn[1] === "02__con_n8.png" &&
      wn[2] === "03_无扩展名_n7.mp4" &&
      wn[3] === "04_无扩展名_n7.wav",
    wn.join("|"),
  );
  check(
    "U5 扩展名：jpeg→jpg、大小写、未知回退",
    extOf({ url: "/x/a.jpeg", kind: "image" }) === "jpg" &&
      extOf({ url: "/x/b.PNG", kind: "image" }) === "png" &&
      extOf({ url: "/x/noext", kind: "audio" }) === "mp3",
  );
}

// ---------- 测试项目 + 画布夹具 ----------
const assetsDir = new URL("../agent/static/assets/", import.meta.url);
const media = execSync(`ls '${assetsDir.pathname}' | grep -E '\\.(png|mp4)$' | head -40`, {
  encoding: "utf8",
})
  .trim()
  .split("\n");
const pngs = media.filter((f) => f.endsWith(".png"));
const mp4 = media.find((f) => f.endsWith(".mp4")) ?? `${pngs[1]}`;
const U = (f) => `/agent-service/assets/${f}`;
const [FA, FB, FC, FD, FF] = [pngs[0], pngs[1], pngs[2], pngs[3], pngs[4]];

const { body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-bundle-dl-${Date.now()}` }),
});
const pid = proj.id ?? proj.project?.id;
console.log(`测试项目: ${pid}`);

await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    viewport: { x: 0, y: 0, zoom: 0.5 },
    nodes: [
      {
        id: "n_bd_cand",
        type: "image",
        position: { x: 600, y: 0 },
        data: {
          nodeType: "image",
          title: "主角定妆",
          body: "",
          imageUrl: U(FA),
          imageUrls: [U(FA), U(FB), U(FC)],
          primaryIndex: 0,
        },
      },
      {
        id: "n_bd_scene",
        type: "image",
        position: { x: 1000, y: 0 },
        data: { nodeType: "image", title: "场景:雨夜/街道*", body: "", imageUrl: U(FD) },
      },
      {
        id: "n_bd_asset",
        type: "character",
        position: { x: 1400, y: 0 },
        data: { nodeType: "character", title: "林小雨", body: "", imageUrl: U(FA) },
      },
      {
        id: "n_bd_video",
        type: "video",
        position: { x: 600, y: 420 },
        data: { nodeType: "video", title: "", body: "", videoUrl: U(mp4) },
      },
      {
        id: "n_bd_con",
        type: "image",
        position: { x: 1000, y: 420 },
        data: { nodeType: "image", title: "con", body: "", imageUrl: U(FF) },
      },
      {
        id: "n_bd_note",
        type: "note",
        position: { x: 1400, y: 420 },
        data: { nodeType: "note", title: "纯文本", body: "没有媒体" },
      },
    ],
    edges: [],
  }),
});

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  acceptDownloads: true,
});
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

const tmp = mkdtempSync(join(tmpdir(), "wsbundle-"));
const zipInfo = (p) =>
  JSON.parse(
    execSync(
      `python3 -c "import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1]); m=json.loads(z.read('清单.json').decode('utf-8')); print(json.dumps({'names':z.namelist(),'manifest':m['文件']}))" '${p}'`,
      { encoding: "utf8" },
    ),
  );
const grabDownload = async (trigger) => {
  const dlPromise = page.waitForEvent("download");
  dlPromise.catch(() => undefined);
  await trigger();
  const dl = await dlPromise;
  const path = join(tmp, dl.suggestedFilename());
  await dl.saveAs(path);
  return { path, filename: dl.suggestedFilename() };
};

// ---------- A 右键空白：下载全部媒体（6 个，zip + 清单） ----------
try {
  // 节点都摆在 x≥600：屏幕左侧空白区右键必落 pane
  const dl = await grabDownload(async () => {
    await page.mouse.click(120, 700, { button: "right" });
    await page.getByRole("button", { name: /下载全部媒体/ }).click({ timeout: 8000 });
  });
  check("A1 zip 文件名 = {项目名}-媒体-时间戳.zip", /-媒体-\d{8}-\d{4}\.zip$/.test(dl.filename), dl.filename);
  const info = zipInfo(dl.path);
  const names = info.names.filter((n) => n !== "清单.json");
  check(
    "A2 zip 含 6 个媒体 + 清单.json",
    info.names.length === 7 && info.manifest.length === 6,
    info.names.join(", "),
  );
  const has = (re) => names.some((n) => re.test(n));
  check(
    "A3 命名：候选N/非法字符/未命名回退/Windows 保留名",
    has(/^01_主角定妆_.+_候选1\./) &&
      has(/_候选2\./) &&
      has(/_候选3\./) &&
      has(/^04_场景_雨夜_街道__/) &&
      has(/^05_未命名_.*\.mp4$/) &&
      has(/^06__con_/),
    names.join(" | "),
  );
  check(
    "A4 去重：林小雨卡与候选重复的 URL 不重复打包",
    names.filter((n) => n.includes("林小雨")).length === 0,
  );
  check(
    "A5 清单.json：每条带 文件/卡片/类型/来源/状态",
    info.manifest.every(
      (m) => m.文件 && m.卡片 !== undefined && m.类型 && m.来源 && m.状态 === "ok",
    ),
    JSON.stringify(info.manifest[0]),
  );
  await page.getByText("已下载 6 个文件").waitFor({ timeout: 6000 });
  check("A6 完成 toast「已下载 6 个文件」", true);
} catch (e) {
  check("A 右键下载全部媒体", false, String(e).slice(0, 200));
}

// ---------- B 多选工具条：只下选中卡 ----------
try {
  // 选区工具条挂在选区包围盒上方（-translate-y-full）：选中卡贴视口顶时
  // 工具条会出屏——真实用户会平移画布后再操作，测试同款先平移再选
  await page.evaluate(() => {
    window.__wsSetViewport({ x: 400, y: 300, zoom: 0.5 });
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.__wsCanvasStore.getState().selectNodes(["n_bd_cand", "n_bd_scene"]);
  });
  await page.waitForTimeout(400);
  const dl = await grabDownload(async () => {
    await page
      .locator("button", { hasText: /^下载 4$/ })
      .first()
      .click({ timeout: 8000 });
  });
  const info = zipInfo(dl.path);
  const names = info.names.filter((n) => n !== "清单.json");
  check(
    "B1 工具条「下载 4」zip 只含两张选中卡的 4 个媒体",
    names.length === 4 &&
      names.every((n) => /^(0[1-4]_)/.test(n)) &&
      !names.some((n) => /未命名|__con_|林小雨/.test(n)),
    names.join(" | "),
  );
  await page.getByText("已下载 4 个文件").waitFor({ timeout: 6000 });
  check("B2 完成 toast「已下载 4 个文件」", true);
} catch (e) {
  check("B 多选工具条批量下载", false, String(e).slice(0, 200));
}

// ---------- C 空选区/无媒体守卫（选中无媒体卡只弹提示不触发下载） ----------
try {
  await page.evaluate(() => {
    window.__wsCanvasStore.getState().selectNodes(["n_bd_note", "n_bd_asset"]);
  });
  await page.waitForTimeout(300);
  // 林小雨有 1 张图 → 按钮显示「下载 1」，单文件走 downloadMedia 快路径（不 zip）
  const dl = await grabDownload(async () => {
    await page
      .locator("button", { hasText: /^下载 1$/ })
      .first()
      .click({ timeout: 8000 });
  });
  check(
    "C1 单媒体快路径：直下原图文件不打包",
    /\.png$/.test(dl.filename) && !/\.zip$/.test(dl.filename),
    dl.filename,
  );
} catch (e) {
  check("C 单媒体快路径", false, String(e).slice(0, 200));
}

check("D 无页面报错", pageErrors.length === 0, pageErrors.join("; ").slice(0, 200));

await browser.close();
await api(`/projects/${pid}`, { method: "DELETE" });
rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
