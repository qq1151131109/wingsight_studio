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

// 等上一轮完全结束（思考模式会让单轮更久）
await send.waitFor({ state: "visible", timeout: 120_000 });

// ---- 2) canvas_ops：建卡 + 删卡 → 审批卡内联 → 允许 → 结果卡 ----
await send.waitFor({ state: "visible", timeout: 120_000 });
await input.click();
await page.keyboard.type("在画布上建一张标题为「冒烟卡」的文本卡", { delay: 20 });
try {
  await send.click({ timeout: 15_000 });
} catch {
  await page.screenshot({ path: "/tmp/e2e-scenario2.png" });
  const stopVisible = await page.locator('button[aria-label="停止生成"]').isVisible().catch(() => false);
  console.log("点击发送失败 — 停止钮可见:", stopVisible);
  throw new Error("场景2发送失败（截图 /tmp/e2e-scenario2.png）");
}
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

// ---- 3) propose_plan：多步任务先出计划，确认后逐步执行 ----
await send.waitFor({ state: "visible", timeout: 120_000 });
await input.click();
await page.keyboard.type(
  "请先列一个执行计划征求我确认，确认前不要动手：1）建一张标题为「计划测试」的文本卡；2）把它的标题改成「计划测试改」",
  { delay: 15 },
);
await send.click();
const planCard = page
  .getByText(/计划待确认/)
  .first()
  .waitFor({ timeout: 90_000 })
  .then(() => true)
  .catch(() => false);
check("多步任务触发计划卡（待确认）", await planCard);

if (results.at(-1)?.ok) {
  await page.getByRole("button", { name: "开始执行" }).click();
  const executed = page
    .locator(".react-flow__node", { hasText: "计划测试" })
    .first()
    .waitFor({ timeout: 180_000 })
    .then(() => true)
    .catch(() => false);
  check("确认后计划开始执行（卡片已建）", await executed);
  const checkmark = await page
    .getByText(/执行中 · \d+\//)
    .first()
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
  check("计划卡勾选状态更新", checkmark);
}

// ---- 4) 画布卡拖进聊天 = @ 引用 chip ----
const dragHandle = page
  .locator(".react-flow__node", { hasText: /计划测试/ })
  .locator(".ws-node-drag")
  .first();
const dragOk = await dragHandle
  .waitFor({ state: "visible", timeout: 15_000 })
  .then(() => true)
  .catch(() => false);
if (dragOk) {
  await dragHandle.dragTo(page.locator('[data-placeholder^="问点什么"]'));
  const chip = await page
    .locator('.ws-mention[data-mention-id]')
    .first()
    .waitFor({ timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  check("画布卡拖进聊天落成 @ 引用 chip", chip);
} else {
  check("画布卡拖进聊天落成 @ 引用 chip", false, "找不到可拖拽的卡片把手");
}
// 清空输入框（拖入的 chip 残留会拼进下一条消息）
await input.click();
await page.keyboard.press("Control+a");
await page.keyboard.press("Delete");

// ---- 5) 长任务条：拆解期间输入框上方出现任务行（ws-task-row） ----
await input.click();
await page.keyboard.type(
  "把这段剧本拆解成资产清单（先不要建卡出图）：深夜便利店，店员小王遭遇劫匪，机智周旋后脱险。",
  { delay: 5 },
);
await send.click();
let stripSeen = false;
for (let i = 0; i < 60; i++) {
  const row = await page
    .locator(".ws-task-row")
    .first()
    .isVisible()
    .catch(() => false);
  if (row) {
    stripSeen = true;
    break;
  }
  // 拆解已完成（工具卡出现）则任务条窗口已错过，不必再等
  const done = await page
    .getByText(/剧本拆解完成/)
    .first()
    .isVisible()
    .catch(() => false);
  if (done) break;
  await page.waitForTimeout(1000);
}
check("长任务条实时显示（拆解中）", stripSeen);
// 等拆解收尾，避免下轮测试残留
await page
  .getByText(/剧本拆解完成/)
  .first()
  .waitFor({ timeout: 120_000 })
  .catch(() => {});

// ---- 6) 思考透传：GLM thinking → reasoning 消息（stock 折叠卡，头部 Thought*） ----
await input.click();
await page.keyboard.type("9.11 和 9.9 哪个大？先想清楚再回答。", { delay: 10 });
await send.click();
// GLM 是否触发思考有随机性：最多试 3 轮，每轮发送后轮询 25s
let thinkingSeen = false;
for (let attempt = 0; attempt < 3 && !thinkingSeen; attempt++) {
  await input.click();
  await page.keyboard.type("87 乘以 453 等于多少？仔细一步一步算，先想清楚再回答。", { delay: 5 });
  await send.click();
  for (let i = 0; i < 25; i++) {
    const row = await page
      .locator(".ws-thinking-row")
      .first()
      .isVisible()
      .catch(() => false);
    if (row) {
      thinkingSeen = true;
      break;
    }
    await page.waitForTimeout(1000);
  }
  if (!thinkingSeen) {
    // 等这轮回答结束再重试
    await page
      .waitForTimeout(15_000);
  }
}
// 思考是否触发取决于模型自愿（thinking 参数已开），不作为硬失败
console.log(
  `${thinkingSeen ? "✓" : "⚠"} 思考指示条${thinkingSeen ? "已出现" : "未出现（模型本轮未思考，非缺陷）"}`,
);

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
