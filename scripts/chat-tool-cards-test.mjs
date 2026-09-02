/**
 * E2E：聊天流结构化工具卡 + 审批内联（toolCards.tsx / CanvasAgentBridge）。
 * 隔离：自建测试项目。两条真实 LLM 消息：
 *  1) "列出可用技能" → 触发后端工具 list_langflow_skills → 断言工具卡渲染
 *  2) "建一张文本卡再删掉它" → canvas_ops（含破坏性删除）→ 断言审批卡内联出现
 *     且确认后结果卡渲染、卡被删除
 * 另收集页面 console error / pageerror（应为 0）。
 *
 * 前置：agent(8123) + 前端(8008) 在跑。LLM 真实调用，单条约 10-40s。
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

const { status: pst, body: proj } = await fetch(`${API}/projects`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  },
  body: JSON.stringify({ name: `e2e-toolcards-${Date.now()}` }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;
console.log(`测试项目: ${pid}`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.addInitScript(
  ([key, value]) => window.localStorage.setItem(key, value),
  ["wingsight_studio_token", TOKEN],
);
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));
const notFound = [];
page.on("response", (r) => {
  if (r.status() !== 404) return;
  // 新建项目首载时画布行尚不存在，GET canvas 404 是既有良性路径（前端按空白画布处理）
  if (/\/canvas$/.test(r.url()) && r.url().includes(pid)) return;
  notFound.push(r.url().slice(0, 160));
});

await page.goto(`${BASE}/project/${pid}`);
await page.waitForSelector("text=画布助手", { timeout: 30_000 }).catch(() => {});

// 打开聊天侧栏（关闭态显示右上角"助手"FAB；开着则直接用）
const fab = page.getByRole("button", { name: "打开画布助手" });
if (await fab.isVisible().catch(() => false)) await fab.click();

const input = page.locator('[data-placeholder^="问点什么"]');
const inputReady = await input
  .waitFor({ state: "visible", timeout: 15_000 })
  .then(() => true)
  .catch(() => false);
if (!inputReady) {
  await page.screenshot({ path: "/tmp/toolcards-fail.png" });
  console.log("buttons:", await page.locator("button").allTextContents().then((a) => a.slice(0, 25)));
  console.log("body:", (await page.locator("body").innerText()).slice(0, 300).replace(/\n+/g, " | "));
  throw new Error("聊天输入框未出现（截图 /tmp/toolcards-fail.png）");
}
const send = page.getByRole("button", { name: /发送/ });

// ---- 1) list_langflow_skills 工具卡 ----
await input.click();
await page.keyboard.type("列出当前可用的技能", { delay: 20 });
await send.click();
const skillCard = page
  .getByText(/已获取技能清单|正在查询可用技能/)
  .first()
  .waitFor({ timeout: 90_000 })
  .then(() => true)
  .catch(() => false);
check("后端工具卡渲染（list_langflow_skills）", await skillCard);

// ---- 2) canvas_ops：建卡 + 删卡 → 审批卡内联 → 允许 → 结果卡 ----
await input.click();
await page.keyboard.type("在画布上建一张标题为「冒烟卡」的文本卡", { delay: 20 });
await send.click();
const addOk = page
  .getByText(/画布操作：执行/)
  .first()
  .waitFor({ timeout: 90_000 })
  .then(() => true)
  .catch(() => false);
check("canvas_ops 结果卡渲染（建卡）", await addOk);

await input.click();
await page.keyboard.type("把「冒烟卡」删掉", { delay: 20 });
await send.click();
const approval = page
  .getByText("允许助手修改画布？")
  .first()
  .waitFor({ timeout: 90_000 })
  .then(() => true)
  .catch(() => false);
check("破坏性操作审批卡内联出现", await approval);

if (results.at(-1)?.ok) {
  await page.getByRole("button", { name: "允许执行" }).click();
  const delOk = page
    .getByText(/画布操作：执行/)
    .nth(1)
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check("批准后 canvas_ops 结果卡渲染（删卡）", await delOk);
  const cardGone = await page
    .locator(".react-flow__node", { hasText: "冒烟卡" })
    .count()
    .then((n) => n === 0);
  check("批准后卡片确已从画布删除", cardGone);
}

// 404 类 console 噪音只认 notFound 里的未知 URL（良性 canvas 404 已过滤）；
// 其余 console error / pageerror 一律算失败
const unexpectedErrors = consoleErrors.filter((t) => !t.includes("404"));
check(
  "无 console error / pageerror",
  unexpectedErrors.length === 0 && notFound.length === 0,
  [...unexpectedErrors, ...notFound].join(" | "),
);
if (notFound.length) console.log("404 资源:", notFound.slice(0, 5).join("\n  "));

await browser.close();

// 清理测试项目
await fetch(`${API}/projects/${pid}`, {
  method: "DELETE",
  headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
});

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} 项失败` : "\n全部通过");
process.exit(failed.length ? 1 : 0);
