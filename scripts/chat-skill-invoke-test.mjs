/**
 * E2E：技能点名调用闭环（「按此技能处理」→ agent read_skill → 照手册执行）。
 * 隔离：自建测试项目，种子画布 3 节点。点名 canvas-context 技能问节点数：
 *  - read_skill 后端工具卡在聊天流出现（BackendToolCards 渲染）
 *  - 最终回答含正确节点数（3——须真用画布摘要/查询，而非瞎答）
 *
 * 前置：agent(8123) + 前端(8008) 在跑。LLM 真实调用，约 30-90s。
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8008";
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
  console.log(TOKEN ? "已登录" : "未取到 token");
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const pr = await (
  await fetch(`${API}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ name: `e2e-skill-invoke-${Date.now()}` }),
  })
).json();
const pid = pr.id ?? pr.project?.id;
console.log(`测试项目: ${pid}`);

// 种子画布：3 个节点（剧本 + 角色卡 + 分镜表骨架）
const node = (id, type, title, extra = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { nodeType: type, title, ...extra },
});
{
  const r = await fetch(`${API}/projects/${pid}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      nodes: [
        node("n_s1", "script", "深夜食堂", { body: "雨夜面馆的短故事。" }),
        node("n_c1", "character", "老周", { body: "面馆老板，沉默寡言。" }),
        node("n_sl1", "shotlist", "分镜表", { rows: [{ rid: "r1", action: "雨夜全景" }] }),
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 0.6 },
    }),
  });
  if (r.status !== 200) throw new Error(`种子画布失败 ${r.status}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.addInitScript(
  ([key, value]) => window.localStorage.setItem(key, value),
  ["wingsight_studio_token", TOKEN],
);
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160));
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 160)}`));
let hasReal404 = false;
page.on("response", (r) => {
  if (r.status() !== 404) return;
  const u = r.url();
  if ((/\/canvas$/.test(u) && u.includes(pid)) || /\/script-review\?/.test(u)) return;
  hasReal404 = true;
});

await page.goto(`${BASE}/project/${pid}`);
await page.waitForTimeout(2500);
const fab = page.getByRole("button", { name: "打开画布助手" });
if (await fab.isVisible().catch(() => false)) await fab.click();
const input = page.locator('[data-placeholder^="问点什么"]');
await input.waitFor({ state: "visible", timeout: 15_000 });
const send = page.getByRole("button", { name: /发送/ });
await page.waitForTimeout(1500);

// 技能面板 → 点名 canvas-context（模拟用户点「按此技能处理」后的完整消息）
await page.getByRole("button", { name: "技能", exact: true }).click();
await page
  .getByRole("button", { name: /canvas-context/ })
  .waitFor({ state: "visible", timeout: 6000 })
  .catch(() => {});
await page.getByRole("button", { name: /canvas-context/ }).click();
await page.getByRole("button", { name: "按此技能处理" }).click();
await page.waitForTimeout(500);
// 补任务尾巴再发
await page.keyboard.type("数一下画布上有几个节点，分别是什么类型");
await send.click({ timeout: 300_000 });

// ① read_skill 工具卡出现（后端工具经 BackendToolCards 渲染）
const skillCard = await page
  .getByText(/read_skill|读取技能|技能手册/)
  .first()
  .waitFor({ state: "visible", timeout: 120_000 })
  .then(() => true)
  .catch(() => false);
check("read_skill 工具卡在聊天流出现", skillCard);

// ② 等整轮结束，最终回答含正确节点数与类型
await send.waitFor({ state: "visible", timeout: 300_000 });
await page.waitForTimeout(2000);
const chatText = await page.locator("body").innerText();
const saysThree = /3\s*个|三个/.test(chatText);
const saysTypes = /剧本/.test(chatText) && /角色/.test(chatText);
check("回答节点数正确（3）", saysThree);
check("回答点出节点类型（剧本/角色）", saysTypes);

const realErrors = hasReal404
  ? consoleErrors
  : consoleErrors.filter((e) => !e.startsWith("Failed to load resource"));
check("页面 console 无错误", realErrors.length === 0, realErrors[0]?.slice(0, 120) ?? "");

await page.screenshot({ path: "/tmp/skill-invoke-done.png" }).catch(() => {});
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "全部通过" : `${failed.length} 项失败`}（${results.length} 项）`);
process.exit(failed.length === 0 ? 0 : 1);
