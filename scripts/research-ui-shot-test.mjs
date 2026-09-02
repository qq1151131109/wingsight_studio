/**
 * 调研卡 + 卷宗阅读器 UI 实测截图：向测试项目画布写一张已完成调研的 research 卡，
 * Playwright 打开 → 截卡面 → 点「卷宗」→ 截阅读器。产出 /tmp/research-ui-*.png。
 */
import fs from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8123";
const WEB = "http://127.0.0.1:8008";
const AUTH_PASSWORD = fs
  .readFileSync(".env.local", "utf8")
  .match(/^AUTH_PASSWORD=(.*)$/m)?.[1]?.trim();

const form = new URLSearchParams({ username: "admin", password: AUTH_PASSWORD });
const login = await fetch(`${BASE}/api/v1/auth/token`, { method: "POST", body: form });
const TOKEN = (await login.json()).access_token;

const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res.json();
};

const PID = "0501b9d36f70"; // 旅程实测项目（含已完成的妇好墓调研）
const JID = "ae000fadb552";
const job = await api(`/projects/${PID}/research/${JID}`);
if (job.status !== "done") throw new Error(`调研未完成：${job.status}`);

// 写一张 research 卡进画布（同前端 addNode 的数据形状）
let canvas = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 0.9 }, meta: {}, revision: undefined };
try {
  canvas = await api(`/projects/${PID}/canvas`);
} catch { /* 新项目无画布行，用空画布首存 */ }
await api(`/projects/${PID}/canvas`, {
  method: "PUT",
  body: JSON.stringify({
    nodes: [
      ...canvas.nodes,
      {
        id: "n_ui_research_1",
        type: "research",
        position: { x: 120, y: 120 },
        style: { width: 320, height: 220 },
        data: { nodeType: "research", title: job.topic, body: "", researchId: JID },
      },
    ],
    edges: canvas.edges,
    viewport: { x: 0, y: 0, zoom: 0.9 },
    meta: canvas.meta ?? {},
    expectedRevision: canvas.revision,
  }),
});
console.log("✓ 调研卡已写入画布");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.addInitScript(
  ([key, value]) => window.localStorage.setItem(key, value),
  ["wingsight_studio_token", TOKEN],
);
const page = await context.newPage();

await page.goto(`${WEB}/project/${PID}`, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
await page.screenshot({ path: "/tmp/research-ui-card.png" });
console.log("✓ 卡面截图 /tmp/research-ui-card.png");

// 打开阅读器：点卡上的「卷宗」按钮
const btn = page.locator('button[aria-label="打开调研卷宗"]');
await btn.first().click({ timeout: 8000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: "/tmp/research-ui-reader.png" });
console.log("✓ 阅读器截图 /tmp/research-ui-reader.png");

// 卷宗区渲染检查：headline 与引用 chip
const body = await page.textContent("body");
const checks = [
  [body.includes("满铲红漆皮") || body.includes("妇好"), "卷宗标题渲染"],
  [/\d{3}/.test(body ?? ""), "S 编号引用 chip 渲染（chip 显 001 式编号）"],
];
for (const [ok, name] of checks) console.log(ok ? `✓ ${name}` : `✗ ${name}`);

// 来源 tab
await page.locator("button", { hasText: /^来源/ }).first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: "/tmp/research-ui-sources.png" });
console.log("✓ 来源页截图 /tmp/research-ui-sources.png");

await browser.close();
const pass = checks.every(([ok]) => ok);
console.log(pass ? "\n✓✓ UI 实测通过" : "\n✗ UI 有未过项");
process.exit(pass ? 0 : 1);
