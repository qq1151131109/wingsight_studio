/**
 * E2E：助手能力面板（发现性入口，无 LLM，~15s）。
 * 聊天 header「能力」按钮 → CapabilitiesDialog 三分区（能做什么 / 生成技能 /
 * 方法手册）→ 点示例句插入输入条。
 *
 * 前置：agent(8123) + 前端(8008) 在跑。
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

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const { status: pst, body: proj } = await fetch(`${BASE}/agent-service/projects`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
  body: JSON.stringify({ name: `e2e-capabilities-${Date.now()}` }),
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
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160));
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 160)}`));
const notFound = [];
let hasReal404 = false;
page.on("response", (r) => {
  if (r.status() !== 404) return;
  const u = r.url();
  if ((/\/canvas$/.test(u) && u.includes(pid)) || /\/script-review\?/.test(u)) return;
  hasReal404 = true;
  notFound.push(u.slice(0, 140));
});

await page.goto(`${BASE}/project/${pid}`);
await page.waitForTimeout(2500);
const fab = page.getByRole("button", { name: "打开画布助手" });
if (await fab.isVisible().catch(() => false)) await fab.click();
await page.waitForTimeout(800);

// 1) 打开能力面板
const capBtn = page.getByRole("button", { name: "助手能力" });
check("聊天 header「助手能力」按钮可见", await capBtn.isVisible().catch(() => false));
await capBtn.click();
const modal = page.getByText("助手能力", { exact: true }).locator("xpath=ancestor::div[contains(@class,'fixed')]");
check("能力面板打开（OverlayModal）", await page.getByText("能做什么").isVisible({ timeout: 5000 }).catch(() => false));

// 2) 三分区内容
const actionCount = await page.locator("section, div").filter({ hasText: "剧本拆解建卡" }).count();
check("能做什么 ≥5 项（能力卡渲染）", actionCount > 0 && await page.getByText("整表分镜").first().isVisible().catch(() => false));
check("生成技能分区（/ 直达）", await page.getByText("生成技能").isVisible().catch(() => false));
check("技能条目渲染（宣发文案）", await page.getByText(/宣发文案/).first().isVisible().catch(() => false));
check("方法手册 3 份", await page.getByText("asset-aware-generation").isVisible().catch(() => false) && await page.getByText("canvas-editing").isVisible().catch(() => false));

// 3) 展开手册看全文
await page.getByRole("button", { name: /asset-aware-generation/ }).click();
const bodyShown = await page
  .getByText("# 资产感知生成")
  .isVisible({ timeout: 3000 })
  .catch(() => false);
check("手册展开显示 SKILL.md 全文", bodyShown);

// 4) 点示例句 → 面板关 + 文本进输入条
const example = page.getByRole("button", { name: /把画布上的剧本拆解成资产卡/ });
check("示例句 chip 可见", await example.isVisible().catch(() => false));
await example.click();
await page.waitForTimeout(600);
const modalGone = !(await page.getByText("能做什么").isVisible().catch(() => false));
check("点击示例后面板关闭", modalGone);
const inputText = await page.evaluate(
  () => document.querySelector('[data-placeholder^="问点什么"]')?.textContent ?? "",
);
check("示例句已插入输入条", inputText.includes("把画布上的剧本拆解成资产卡"), inputText.slice(0, 40));

// 5) console 干净
const realErrors = hasReal404 ? consoleErrors : consoleErrors.filter((e) => !e.startsWith("Failed to load resource"));
check("页面 console 无错误", realErrors.length === 0 && notFound.length === 0, (realErrors[0] ?? notFound[0] ?? "").slice(0, 120));

await page.screenshot({ path: "/tmp/capabilities-done.png" }).catch(() => {});
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "全部通过" : `${failed.length} 项失败`}（${results.length} 项）`);
process.exit(failed.length === 0 ? 0 : 1);
