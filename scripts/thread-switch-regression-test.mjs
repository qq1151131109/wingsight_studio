/**
 * 回归验证：切项目不再拿旧项目会话 id 打 404（聊天会话跨项目残留修复）。
 * 流程：登录 → 自动挑两个有会话的项目 A/B → 进 A（水合选其会话）→ 切到 B →
 *       记录 messages 请求。
 * 期望：B 项目下不存在「B + A 的会话 id」的查询；或即便 404 也一轮自愈不重复。
 * 依赖：agent(8123) + 前端(8008) 在跑、AUTH_PASSWORD 在 .env.local。
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:8008";
const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const password = env.match(/^AUTH_PASSWORD=(.+)$/m)?.[1]?.trim();
const tr = await fetch(`${BASE}/api/v1/auth/token`, {
  method: "POST",
  body: new URLSearchParams({ username: "admin", password }),
});
const TOKEN = (await tr.json()).access_token;
const auth = { Authorization: `Bearer ${TOKEN}` };

// 自动挑两个「有会话」的项目：先水合 A，再切 B（观察是否拿 A 的 tid 查 B）
const projects = await (
  await fetch(`${BASE}/agent-service/projects`, { headers: auth })
).json();
const withThreads = [];
for (const p of projects) {
  const ts = await (
    await fetch(`${BASE}/agent-service/projects/${p.id}/threads`, { headers: auth })
  ).json();
  if (Array.isArray(ts) && ts.length > 0) withThreads.push(p.id);
  if (withThreads.length === 2) break;
}
if (withThreads.length < 2) {
  console.log("有会话的项目不足两个，跳过（need 2, got", withThreads, "）");
  process.exit(0);
}
const [projA, projB] = withThreads;
console.log(`项目A=${projA}  项目B=${projB}`);

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(
  ([token]) => localStorage.setItem("wingsight_studio_token", token),
  [TOKEN],
);
const page = await ctx.newPage();

const responses = [];
page.on("response", (r) => {
  if (/\/threads\/[^/]+\/messages/.test(r.url()))
    responses.push({ url: r.url(), status: r.status() });
});

// 进项目 A，等聊天水合拉完会话列表
await page.goto(`${BASE}/project/${projA}`);
await page.waitForLoadState("domcontentloaded");
await page
  .waitForResponse(
    (r) => r.url().includes("/threads") && r.request().method() === "GET",
    { timeout: 15000 },
  )
  .catch(() => {});
await page.waitForTimeout(2500);

// 切到项目 B：修复前这里会拿 A 的 tid 查 B → 404 反复
await page.goto(`${BASE}/project/${projB}`);
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(3500);

const bad = responses.filter((r) => r.status === 404);
console.log("messages 请求序列：");
for (const r of responses) console.log(" ", r.status, r.url.replace(BASE, ""));
const dup404 =
  bad.length > 1 && new Set(bad.map((r) => r.url)).size < bad.length; // 同一 URL 404 多次 = 风暴

if (bad.length === 0) {
  console.log("✅ 通过：切项目零 404，未发生跨项目会话残留查询");
} else if (!dup404) {
  console.log("⚠️ 有 404 但无重复（自愈一轮收敛）");
} else {
  console.log("❌ 未通过：同一请求反复 404");
}
await browser.close();
process.exit(bad.length === 0 ? 0 : dup404 ? 1 : 0);
