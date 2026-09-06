/**
 * E2E：画风选择回传（2026-09-05「选完 agent 不知道」事故的防回归）。
 * 轮1 聊天让 agent 打开画风面板 → open_style_picker 等待式 handler 挂起
 *      （工具卡「等待选择…」）→ 点预设「张艺谋风格」→ 画风变化稳定 2s →
 *      handler 返回所选画风 → agent 同轮续答且知道选了什么（聊天区出现
 *      预设名，用户没在聊天里说过）；底坞按钮同步显示预设名。
 * 轮2 再开面板但不选 → 点「完成」关面板 → handler 以「未选择」收尾 →
 *      agent 有应答（不悬挂）。
 * 前置：agent(8123) + 前端(8008) 在跑；真跑 LLM 约 1-2 分钟。
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8008";
const PRESET_NAME = "张艺谋风格";

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

const { status: pst, body: proj } = await fetch(`${BASE}/agent-service/projects`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
  body: JSON.stringify({ name: `e2e-style-handoff-${Date.now()}` }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.addInitScript(
  ([key, value]) => window.localStorage.setItem(key, value),
  ["wingsight_studio_token", TOKEN],
);
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160));
});
page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 160)));

try {
  await page.goto(`${BASE}/project/${pid}`);
  await page.waitForTimeout(2500);
  const fab = page.getByRole("button", { name: "打开画布助手" });
  if (await fab.isVisible().catch(() => false)) await fab.click();
  const input = page.locator('[data-placeholder^="问点什么"]');
  await input.waitFor({ state: "visible", timeout: 15_000 });

  // —— 轮 1：agent 打开面板，等待式挂起 ——
  await input.fill("帮我打开画风选择面板，我想现在选一个画风");
  await page.getByRole("button", { name: /发送/ }).click();

  // 面板弹出 = open_style_picker 已执行；此刻 handler 仍挂起，工具卡应示「等待选择」
  const panel = page.locator("text=项目画风").first();
  await panel.waitFor({ state: "visible", timeout: 90_000 });
  check("轮1 面板被 agent 打开", true);
  await page.waitForFunction(
    () => document.body.innerText.includes("等待选择"),
    { timeout: 10_000 },
  ).then(
    () => check("轮1 工具卡处于等待态", true),
    () => check("轮1 工具卡处于等待态", false, "未见「等待选择…」"),
  );

  // 用户点预设（没在聊天里说选了什么）→ 2s 稳定 → handler 返回画风
  await page.getByText(PRESET_NAME, { exact: false }).first().click();
  await page.waitForTimeout(2500);
  // 关掉面板（选择已稳定，handler 早已按画风收尾）
  await page.getByRole("button", { name: "完成" }).click();

  // agent 同轮续答且知道所选——聊天区出现预设名或 prompt 特征片段
  // （容器此刻已可见：有消息了；转述用名、或直接引用 prompt 开头都算知道）
  const PROMPT_FRAGMENT = "张艺谋式真人电影摄影";
  await page
    .locator(".copilotKitMessages")
    .getByText(new RegExp(`${PRESET_NAME}|${PROMPT_FRAGMENT}`))
    .first()
    .waitFor({ state: "visible", timeout: 90_000 })
    .catch(async () => {
      console.log("  聊天尾部:", (await page.locator("body").innerText()).replace(/\n+/g, " ").slice(-300));
    });
  const knowsStyle = await page
    .locator(".copilotKitMessages")
    .getByText(new RegExp(`${PRESET_NAME}|${PROMPT_FRAGMENT}`))
    .count();
  check("轮1 agent 知道所选画风", knowsStyle > 0, "聊天区出现预设名/prompt 片段（用户未在聊天提过）");

  // 底坞「画风」按钮同步显示生效值
  const dockLabel = await page.locator("button", { hasText: PRESET_NAME }).first().textContent().catch(() => "");
  check("轮1 底坞画风按钮显示预设名", Boolean(dockLabel?.includes(PRESET_NAME)), (dockLabel || "").trim().slice(0, 30));

  // —— 轮 2：再开面板但不选，直接关 ——
  await input.fill("再打开一次画风面板，这次我不选，随便关掉就行");
  await page.getByRole("button", { name: /发送/ }).click();
  await panel.waitFor({ state: "visible", timeout: 90_000 });
  await page.waitForTimeout(800);
  // 关面板后先取基线，等两件事：工具卡翻完成态（「画风面板已关闭」只在
  // complete 分支渲染）→ 聊天有新增内容（agent 对「未选择」的应答）
  await page.getByRole("button", { name: "完成" }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes("画风面板已关闭"),
    { timeout: 30_000 },
  ).then(
    () => check("轮2 工具卡以未选择收尾", true),
    () => check("轮2 工具卡以未选择收尾", false, "未见完成态文案"),
  );
  const baseline = await page.locator("body").innerText();
  await page.waitForFunction(
    (b) => document.body.innerText.length > b.length,
    baseline,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(2000);
  const tail = (await page.locator("body").innerText()).replace(/\n+/g, " ").slice(-200);
  check("轮2 关面板后 agent 有应答", true, tail);
  // 只断未捕获异常：console.error 里有已知无害噪音（CopilotKit flushSync
  // 警告、资源 404），逐类白名单会脆——pageerror 才是真回归信号
  check("无未捕获前端异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} finally {
  await fetch(`${BASE}/agent-service/projects/${pid}`, {
    method: "DELETE",
    headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
  });
  console.log("✓ 测试项目已删除");
  await browser.close();
}

const pass = results.every((r) => r.ok);
console.log(`console.error 汇总: ${consoleErrors.length} 条${consoleErrors.length ? `（前 3：${consoleErrors.slice(0, 3).join(" | ")}）` : ""}`);
console.log(`\n${pass ? "✓✓ 画风选择回传实测通过" : "✗ 有环节未过"}（${results.filter((r) => r.ok).length}/${results.length}）`);
process.exit(pass ? 0 : 1);
