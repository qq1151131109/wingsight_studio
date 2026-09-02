/**
 * E2E 回归：操作埋点（/api/v1/events + data-track 全局点击捕获）。
 *  - 后端：POST 落库、summary 聚合（count/today/last_at）、recent 明细过滤
 *  - 前端：点带 data-track 的按钮 → 全局捕获发 POST（route 拦截断言 payload）
 * 前置：agent(8123)+前端(8008) 在跑。
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8008";
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
const API = `${BASE}/agent-service`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};
const MARK = `e2e.telemetry.${Date.now()}`;

// ---------- 1. 后端 round-trip ----------
await api("/api/v1/events", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: MARK, props: { n: 1 } }),
});
await api("/api/v1/events", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: MARK }),
});
const sum = await api(`/api/v1/events/summary?days=30`);
const row = (sum.body?.summary ?? []).find((r) => r.name === MARK);
check("POST 落库 + summary 聚合", row?.count === 2 && row?.today === 2 && !!row?.last_at,
  JSON.stringify(row));
const recent = await api(`/api/v1/events/recent?name=${encodeURIComponent(MARK)}`);
check(
  "recent 明细按名过滤",
  (recent.body?.events ?? []).length === 2 &&
    (recent.body?.events ?? []).some((r) => (r.props ?? "").includes('"n": 1') || (r.props ?? "").includes('"n":1')),
  `rows=${recent.body?.events?.length}`,
);

// ---------- 2. 前端 data-track 点击捕获 ----------
const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-telemetry-${Date.now()}` }),
});
const pid = proj.id ?? proj.project?.id;
await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }),
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
if (TOKEN)
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["wingsight_studio_token", TOKEN],
  );
const page = await context.newPage();
const trackedPosts = [];
await page.route("**/api/v1/events", (route) => {
  if (route.request().method() === "POST") {
    try { trackedPosts.push(route.request().postDataJSON()); } catch {}
    return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  }
  return route.continue();
});

try {
  await page.goto(`${BASE}/project/${pid}`);
  await page.waitForTimeout(4000);
  // 底部坞「素材库」：data-track="dock.assets"
  // 并行会话的 usage banner 可能悬浮在底坞上方拦截真实点击——直接对元素
  // 触发 DOM click（目标即按钮，验证 捕获监听→trackEvent→POST 全链路）
  await page.evaluate(() => {
    (document.querySelector('[data-track="dock.assets"]')).click();
  });
  await page.waitForTimeout(800);
  const hit = trackedPosts.find((p) => p?.name === "dock.assets");
  check("data-track 点击→POST", !!hit, JSON.stringify(trackedPosts.map((p) => p?.name)));
  check("自动附 project_id", hit?.project_id === pid, hit?.project_id);
} catch (e) {
  console.error("执行中断：", e.message);
} finally {
  await browser.close();
  await api(`/projects/${pid}`, { method: "DELETE" }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
