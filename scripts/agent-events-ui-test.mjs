/**
 * E2E：后台任务事件流（agent/eventbus.py 常开 SSE 通道）的浏览器侧闭环。
 * 验证三件事：
 *  1. 浏览器内 SSE 通道连通（经 Next 同源代理 + Bearer 认证，首帧 :connected）
 *  2. 参考图调研完成事件 → 左下浮条通知 + **自动续跑**：聊天出现
 *     「（任务通知）」系统样式用户消息（中性边框样式、无编辑重发钮），
 *     agent 真跑一轮并有应答（真跑 LLM 约 1 分钟）
 *  3. 分镜出图完成事件 → 仅浮条通知，不自动续跑（UI 触发任务不插话）
 * 事件从 window.__wsJobEvent 注入口进（TaskEvents 的 dev 测试钩子，与
 * SSE 帧同一条处理链路——浏览器侧无法伪造 SSE 帧；SSE 连通性单独断言）。
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
  body: JSON.stringify({ name: `e2e-agent-events-${Date.now()}` }),
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
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 160)));

try {
  await page.goto(`${BASE}/project/${pid}`);
  await page.waitForTimeout(2500);
  const fab = page.getByRole("button", { name: "打开画布助手" });
  if (await fab.isVisible().catch(() => false)) await fab.click();
  await page.locator('[data-placeholder^="问点什么"]').waitFor({ state: "visible", timeout: 15_000 });

  // 1) 浏览器内 SSE 连通（与 lib/agent-events.ts 同路径：fetch 流 + Bearer）
  const sseOk = await page.evaluate(async () => {
    try {
      const token = window.localStorage.getItem("wingsight_studio_token");
      const ctrl = new AbortController();
      const res = await fetch("/api/v1/events/stream", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: ctrl.signal,
      });
      if (!res.ok) return `HTTP ${res.status}`;
      const { value } = await res.body.getReader().read();
      ctrl.abort();
      return new TextDecoder().decode(value).includes(": connected");
    } catch (e) {
      return String(e).slice(0, 80);
    }
  });
  check("浏览器内 SSE 通道连通", sseOk === true, String(sseOk));

  // 2) 参考图调研完成事件 → 浮条 + 自动续跑
  const refBatch = `e2efake${Date.now().toString(36)}`;
  await page.evaluate(
    (batch) =>
      window.__wsJobEvent?.({
        kind: "ref_research",
        project_id: "",
        job_id: batch,
        status: "done",
        title: "资产参考图调研",
        summary: "1 项完成",
        items: [{ node_id: "n_x", name: "测试角色", status: "done", error: "" }],
      }),
    refBatch,
  );
  const bar = page.locator('[data-testid="task-events-notice"]');
  await bar
    .getByText("参考图调研", { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => check("调研事件 → 浮条通知", true), () => check("调研事件 → 浮条通知", false, "浮条未出现"));

  // 自动续跑：聊天出现「（任务通知）」用户消息（系统代发），随后 agent 应答
  await page
    .waitForFunction(() => document.body.innerText.includes("（任务通知）"), null, { timeout: 15_000 })
    .then(() => check("自动续跑：任务通知消息入列", true), () => check("自动续跑：任务通知消息入列", false, "未见任务通知消息"));
  const noticeStyleOk = await page.evaluate(() => {
    // 取叶子节点（无子元素）才是真正的气泡容器；外层容器 textContent 同样
    // 以通知开头，拿它判断会抓错
    const el = Array.from(document.querySelectorAll(".copilotKitMessages *")).find(
      (n) => n.children.length === 0 && n.textContent?.startsWith("（任务通知）"),
    );
    if (!el) return false;
    // 系统样式：中性边框气泡（bg-surface-2），不是用户的 bg-accent 蓝底
    const cls = el.className ?? "";
    return cls.includes("bg-surface-2") && !cls.includes("bg-accent");
  });
  check("任务通知为系统样式（非用户气泡）", noticeStyleOk === true);

  const countAtNotice = await page.evaluate(() => document.querySelectorAll(".copilotKitMessages > *").length);
  const replied = await page
    .waitForFunction(
      (prev) => document.querySelectorAll(".copilotKitMessages > *").length > prev,
      countAtNotice,
      { timeout: 150_000, polling: 1500 },
    )
    .then(() => true, () => false);
  check("agent 应答自动续跑（真跑 LLM）", replied, replied ? "" : "120s 内无新消息");

  // 3) 分镜出图完成事件 → 仅浮条，不自动续跑
  await page.evaluate(
    () =>
      window.__wsJobEvent?.({
        kind: "shot_images",
        project_id: "",
        job_id: `e2eshot${Date.now().toString(36)}`,
        status: "done",
        title: "分镜批量出图",
        summary: "3/3 张成功",
      }),
  );
  await bar
    .getByText("分镜批量出图", { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => check("出图事件 → 浮条通知", true), () => check("出图事件 → 浮条通知", false, "浮条未出现"));
  const countAfterShot = await page.evaluate(() => document.querySelectorAll(".copilotKitMessages > *").length);
  await page.waitForTimeout(6000);
  const stayed = await page.evaluate(() => document.querySelectorAll(".copilotKitMessages > *").length);
  check("出图事件不自动续跑（聊天静默）", stayed === countAfterShot, `${countAfterShot} → ${stayed}`);

  check("无页面级 JS 错误", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
  await fetch(`${BASE}/agent-service/projects/${pid}`, {
    method: "DELETE",
    ...(TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : {}),
  }).catch(() => {});
}

const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "✓✓ 事件流浏览器闭环通过" : "✗ 有环节未过"}（${results.filter((r) => r.ok).length}/${results.length}）`);
process.exit(pass ? 0 : 1);
