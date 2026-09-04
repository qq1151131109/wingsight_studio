/**
 * E2E：技能面板（Claude Code 式单一列表，无 LLM，~15s）。
 * 聊天 header「技能」按钮 → CapabilitiesDialog 单一列表（手册类 + 指令类
 * 混排，每项 = 名称 + 描述 + 展开内容）→ 指令类「插入输入条」。
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
  body: JSON.stringify({ name: `e2e-skills-${Date.now()}` }),
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

// 1) 打开技能面板（单一列表）
const btn = page.getByRole("button", { name: "技能", exact: true });
check("聊天 header「技能」按钮可见", await btn.isVisible().catch(() => false));
await btn.click();
check("技能面板打开", await page.getByText("技能", { exact: true }).first().isVisible({ timeout: 5000 }).catch(() => false));

// 2) 单一列表混排：3 份手册 + 1 条指令（宣发文案）都在同一列表
// （面板打开后异步拉清单，断言要等元素出现而非瞬时 isVisible 快照）
const waitVisible = (loc, ms = 6000) =>
  loc.waitFor({ state: "visible", timeout: ms }).then(() => true).catch(() => false);
check("手册类在列（asset-aware-generation）", await waitVisible(page.getByText("asset-aware-generation")));
check("手册类在列（canvas-editing）", await waitVisible(page.getByText("canvas-editing")));
check("指令类在列（宣发文案生成）", await waitVisible(page.getByText("宣发文案生成")));
await waitVisible(page.getByText("手册", { exact: true }).first());
const kindBadges = await page.getByText("手册", { exact: true }).count();
const flowBadges = await page.getByText("指令", { exact: true }).count();
check("类型徽标（手册×3 + 指令×1）", kindBadges >= 3 && flowBadges >= 1, `手册=${kindBadges} 指令=${flowBadges}`);
check("旧三分区已移除（无「能做什么」区）", !(await page.getByText("能做什么").isVisible().catch(() => false)));

// 3) 展开手册看全文
await page.getByRole("button", { name: /asset-aware-generation/ }).click();
check("手册展开显示 SKILL.md 全文", await page.getByText("# 资产感知生成").isVisible({ timeout: 3000 }).catch(() => false));
await page.getByRole("button", { name: /asset-aware-generation/ }).click();

// 4) 指令类展开 →「插入输入条」
await page.getByRole("button", { name: /宣发文案生成/ }).click();
const insertBtn = page.getByRole("button", { name: "插入输入条" });
check("指令类展开有「插入输入条」", await insertBtn.isVisible({ timeout: 3000 }).catch(() => false));
await insertBtn.click();
await page.waitForTimeout(600);
check("点击后面板关闭", !(await page.getByText("手册", { exact: true }).first().isVisible().catch(() => false)));
const inputText = await page.evaluate(
  () => document.querySelector('[data-placeholder^="问点什么"]')?.textContent ?? "",
);
check("调用模板已插入输入条", inputText.includes("调用技能「宣发文案生成」处理："), inputText.slice(0, 40));

// 5) console 干净
const realErrors = hasReal404 ? consoleErrors : consoleErrors.filter((e) => !e.startsWith("Failed to load resource"));
check("页面 console 无错误", realErrors.length === 0 && notFound.length === 0, (realErrors[0] ?? notFound[0] ?? "").slice(0, 120));

await page.screenshot({ path: "/tmp/skills-panel-done.png" }).catch(() => {});
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "全部通过" : `${failed.length} 项失败`}（${results.length} 项）`);
process.exit(failed.length === 0 ? 0 : 1);
