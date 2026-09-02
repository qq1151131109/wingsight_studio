/**
 * E2E：手动新增资产卡三件套。
 * A 空名建卡+聚焦命名（hint 占位名会污染资产名单/@引用的时代已结束）；
 *   同类同名即时提醒（confirm 定位已有卡）；
 * B 资产卡「AI 写设定」直连管线（空设定直接落正文——真实 LLM 调用一次）；
 * C 素材库图片一键建为资产卡（库图作设定图，命名后进资产名单）。
 * 前置：agent(8123) + 前端(8008) 在跑。
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

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

const { body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-asset-add-${Date.now()}` }),
});
const pid = proj.id ?? proj.project?.id;
await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ nodes: [], edges: [], viewport: { x: 200, y: 120, zoom: 1 } }),
});
// 素材库预置一条图片记录（C 用）
const LIB_URL = "/agent-service/assets/e2e_lib_ref.png";
await api(`/projects/${pid}/assets`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ kind: "image", title: "库参考图", url: LIB_URL, source: "upload" }),
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
if (TOKEN)
  await context.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    ["wingsight_studio_token", TOKEN],
  );
const page = await context.newPage();
const confirms = [];
page.on("dialog", async (d) => {
  confirms.push(d.message());
  await d.accept();
});

await page.goto(`${BASE}/project/${pid}`);
await page.waitForTimeout(1200);

// ---------- A1: 工具条点「角色」→ 空名卡 + 标题聚焦 ----------
await page.getByRole("button", { name: "添加角色（角色设定卡）— 可拖到画布指定位置" }).click();
await page.waitForTimeout(900); // focusWhenVisible 等挂载重试窗口
const a1 = await page.evaluate(() => {
  const node = [...document.querySelectorAll(".react-flow__node")].find((n) =>
    n.querySelector(".ws-card"),
  );
  const ta = node?.querySelector("textarea");
  return {
    exists: Boolean(node),
    isCharacter: node?.dataset.id?.startsWith("n_") && Boolean(ta),
    focused: document.activeElement === ta,
    placeholder: ta?.getAttribute("placeholder") ?? "",
  };
});
check("A1 建角色卡即聚焦命名框", a1.exists && a1.focused, `placeholder=「${a1.placeholder}」`);
check("A2 占位符引导输入角色名", a1.placeholder.includes("输入角色名"), a1.placeholder);

// 命名
await page.keyboard.type("侲子领首者");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const named = await page.evaluate(() => {
  const s = window.__wsCanvasStore.getState();
  const n = s.nodes.find((x) => x.data.nodeType === "character");
  return { title: n?.data.title, assetSource: n?.data.assetSource };
});
check("A3 Esc 收尾落库名字", named.title === "侲子领首者", `title=「${named.title}」`);

// ---------- A4: 第二张卡同名 → confirm 提醒 ----------
await page.getByRole("button", { name: "添加角色（角色设定卡）— 可拖到画布指定位置" }).click();
await page.waitForTimeout(700);
await page.keyboard.type("侲子领首者");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check(
  "A4 同类同名触发提醒（confirm）",
  confirms.length > 0 && /同名角色/.test(confirms[0]),
  confirms[0]?.slice(0, 50),
);

// ---------- B: 资产卡「AI 写设定」（真实 /text/rewrite，空设定直接落正文） ----------
// A4 建的第二张同名卡叠在第一张上方（都在视口中心），操作置顶那张
const writeBtn = page.getByRole("button", { name: "AI 写设定" }).last();
check("B1 资产卡有「AI 写设定」入口", (await writeBtn.count()) > 0);
if ((await writeBtn.count()) > 0) {
  await writeBtn.click();
  // 真实 LLM 撰写，轮询等正文落库
  let body = "";
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(2000);
    body = await page.evaluate(() => {
      const s = window.__wsCanvasStore.getState();
      const chars = s.nodes.filter((x) => x.data.nodeType === "character");
      return String(chars[chars.length - 1]?.data.body ?? "");
    });
    if (body.trim()) break;
  }
  check(
    "B2 AI 设定已落正文（类型模板生效）",
    body.trim().length > 10,
    `正文前 40 字：「${body.slice(0, 40)}」`,
  );
}

// ---------- C: 素材库图片一键建为资产卡 ----------
await page.getByRole("button", { name: /素材库：生成 \/ 上传过的图片视频音频/ }).click();
const libItem = page.locator("div").filter({ hasText: /^库参考图/ }).first();
await libItem.waitFor({ timeout: 8000 });
await libItem.hover();
const asChar = page.getByRole("button", { name: "建为角色卡" }).first();
await asChar.click();
await page.waitForTimeout(900);
const c1 = await page.evaluate((libUrl) => {
  const s = window.__wsCanvasStore.getState();
  const chars = s.nodes.filter((x) => x.data.nodeType === "character");
  const added = chars.find((x) => x.data.imageUrl);
  const ta = [...document.querySelectorAll(".react-flow__node textarea")].find(
    (t) => t.getAttribute("placeholder") === "输入角色名",
  );
  return {
    count: chars.length,
    hasLibImg: added?.data.imageUrl === libUrl,
    focused: document.activeElement === ta,
  };
}, LIB_URL);
check(
  "C1 库图建为角色卡（库图即设定图）",
  c1.count === 3 && c1.hasLibImg,
  `角色卡=${c1.count} 库图挂载=${c1.hasLibImg}`,
);
check("C2 建成即聚焦命名", c1.focused);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
await api(`/projects/${pid}`, { method: "DELETE" });
if (failed.length > 0) process.exit(1);
