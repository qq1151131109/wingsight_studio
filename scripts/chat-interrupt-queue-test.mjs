/**
 * 聊天引导/打断回归（2026-09-09，对标 Claude Code 的排队与中断告知）：
 * 此前自定义 ChatInput 在运行中直接丢弃提交（submit 遇 inProgress early-return），
 * 用户只能干等或停止后重新解释。修复后：
 *   ① 运行中回车 = 排队（chips 可 × 撤回），本轮结束（跑完或被停止）自动发出
 *   ② 停止 = abort + 取消在途后端工具 + 落「（用户中断了这一轮生成）」标记
 *     （Claude Code "[Request interrupted]" 范式：agent 下轮知道自己被截断）
 * 断言（全程 route mock SSE，不烧 LLM）：
 *   A 排队自然排水：忙时入队不出站 → 本轮跑完 → 排队消息自动发第二枪 → 助手回复
 *   B 停止善后：停止后标记气泡出现（中性样式）→ 排队消息自动接上 → 空闲
 *   C 标记落库：会话 transcript 里含中断标记（跨刷新 agent 自知）
 * 用法：node scripts/chat-interrupt-queue-test.mjs （需 web:8008 + agent:8123 在跑）
 */
import fs from "node:fs";
import { chromium } from "playwright";

const WEB = "http://127.0.0.1:8008";
const AGENT = "http://127.0.0.1:8123";

const AUTH_PASSWORD = fs
  .readFileSync(".env.local", "utf8")
  .match(/^AUTH_PASSWORD=(.*)$/m)?.[1]?.trim();
if (!AUTH_PASSWORD) throw new Error("缺 AUTH_PASSWORD（.env.local）");

const login = await fetch(`${AGENT}/api/v1/auth/token`, {
  method: "POST",
  body: new URLSearchParams({ username: "admin", password: AUTH_PASSWORD }),
});
if (!login.ok) throw new Error(`登录失败 ${login.status}`);
const TOKEN = (await login.json()).access_token;

const api = async (path, init) => {
  const r = await fetch(`${AGENT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
};

const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-interrupt-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建临时项目失败 ${pst}`);
const PID = proj.id ?? proj.project?.id;
const dropProject = () => api(`/projects/${PID}`, { method: "DELETE" }).catch(() => {});
const bail = async (e) => {
  console.error(e);
  await dropProject();
  process.exit(1);
};
process.on("uncaughtException", (e) => void bail(e));
process.on("unhandledRejection", (e) => void bail(e));

const results = [];
const check = (name, ok, detail = "") => {
  results.push([Boolean(ok), name, detail]);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.addInitScript(
  ([key, value]) => window.localStorage.setItem(key, value),
  ["wingsight_studio_token", TOKEN],
);
const page = await context.newPage();

// ---- agent run mock：只拦精确的 /agent-service（run POST 无后缀），
// ---- /agent-service/chat/jobs 等照常穿透到真后端。含「一号/三号」的轮次
// ---- 挂住数秒再回（制造忙窗），其余立即回完整 SSE。
let runCount = 0;
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const fullRun = (text) => {
  const runId = `run-${Math.random().toString(36).slice(2, 8)}`;
  const mid = `m-${runId}`;
  return sse([
    { type: "RUN_STARTED", threadId: "mock-thread", runId },
    { type: "TEXT_MESSAGE_START", messageId: mid, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: mid, delta: text },
    { type: "TEXT_MESSAGE_END", messageId: mid },
    { type: "RUN_FINISHED", threadId: "mock-thread", runId },
  ]);
};
const lastUserText = (body) => {
  const msgs = body?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user") {
      const c = msgs[i].content;
      return typeof c === "string" ? c : JSON.stringify(c);
    }
  }
  return "";
};
await page.route("**/agent-service", async (route) => {
  const req = route.request();
  if (req.method() !== "POST") return route.continue();
  let last = "";
  try {
    last = lastUserText(JSON.parse(req.postData() || "{}"));
  } catch {
    /* 非法体按普通轮处理 */
  }
  runCount++;
  const hangMs = last.includes("一号") ? 9000 : last.includes("三号") ? 20000 : 0;
  if (hangMs > 0) await new Promise((r) => setTimeout(r, hangMs));
  try {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: fullRun(`（模拟回复）收到：${last.slice(0, 60)}`),
    });
  } catch {
    /* 页面侧已 abort： fulfill 落空属预期（停止场景） */
  }
});

await page.goto(`${WEB}/project/${PID}`, { waitUntil: "load" });
await page.waitForTimeout(2500);
if (
  (await page.evaluate(() => document.querySelector("aside.copilotKitSidebar")?.getAttribute("aria-hidden"))) !==
  "false"
) {
  await page.locator('[aria-label="打开画布助手"]').click();
  await page.waitForTimeout(1500);
}

const editor = page.locator("aside .copilotKitInputEditor").first();
const type = async (text) => {
  await editor.click();
  await page.keyboard.type(text, { delay: 6 });
  await page.keyboard.press("Enter");
};
const waitStopBtn = async (appear, label, timeout = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const has = Boolean(await page.$('[aria-label="停止生成"]'));
    if (has === appear) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`${label} 等不到停止按钮${appear ? "出现" : "消失"}`);
};
const queueChip = page.locator('aside [data-tip="已排队：本轮结束后自动发送"]');

try {
  // ---------- A 排队 + 自然排水 ----------
  await type("一号：这个问题请慢慢回答");
  await waitStopBtn(true, "A1");
  check("A1 运行中停止按钮出现", true);

  await type("二号：排队引导——改成夜景调性");
  await page.waitForTimeout(1200);
  check("A2 忙时提交进入排队 chips", (await queueChip.count()) === 1);
  const editorText = await editor.evaluate((el) => el.textContent?.trim() ?? "");
  check("A3 排队后输入框已清空", editorText === "", editorText);
  check("A4 排队消息未提前出站（仍 1 次请求）", runCount === 1, String(runCount));

  // 一号轮 9s 后返回 → 排空沿自动发二号
  await waitStopBtn(false, "A5");
  const t0 = Date.now();
  while (runCount < 2 && Date.now() - t0 < 8000) await page.waitForTimeout(300);
  check("A5 本轮跑完排队消息自动出站", runCount === 2, String(runCount));
  await page
    .locator("aside", { hasText: "（模拟回复）收到：二号" })
    .first()
    .waitFor({ timeout: 8000 });
  check("A6 排队消息得到助手回复", true);
  await page.waitForTimeout(600);
  check("A7 排队 chips 已清空", (await queueChip.count()) === 0);

  // ---------- B 停止善后 + 排队接续 ----------
  await type("三号：开始一个很长的任务吧");
  await waitStopBtn(true, "B1");
  await type("四号：别做那个了，换成白天场景");
  await page.waitForTimeout(800);
  check("B1 停止前排好队", (await queueChip.count()) === 1);
  await page.locator('[aria-label="停止生成"]').click();
  await page.waitForTimeout(800);
  const marker = page.locator("aside", { hasText: "（用户中断了这一轮生成）" }).first();
  const markerVisible = await marker.count();
  check("B2 停止后出现中断标记", markerVisible > 0);
  const markerNeutral = await page.evaluate(() => {
    const el = [...document.querySelectorAll("aside div")].find((d) =>
      d.textContent?.trim() === "（用户中断了这一轮生成）" && d.className.includes("whitespace-pre-wrap"),
    );
    return Boolean(el?.className.includes("bg-surface-2"));
  });
  check("B3 中断标记走中性气泡（非 accent 用户样式）", markerNeutral);
  await waitStopBtn(false, "B4");
  const t1 = Date.now();
  while (runCount < 4 && Date.now() - t1 < 8000) await page.waitForTimeout(300);
  check("B4 停止后排队消息自动接上（第 4 次请求）", runCount === 4, String(runCount));
  await page
    .locator("aside", { hasText: "（模拟回复）收到：四号" })
    .first()
    .waitFor({ timeout: 8000 });
  check("B5 接续消息得到助手回复", true);
  await page.waitForTimeout(600);
  check("B6 排队 chips 已清空", (await queueChip.count()) === 0);

  // ---------- C 标记落库（跨刷新 agent 自知的依据） ----------
  await page.waitForTimeout(2600); // ChatPersistence 1.2s debounce + 余量
  const threads = await api(`/projects/${PID}/threads`);
  const list = threads.body ?? [];
  let savedHasMarker = false;
  for (const t of list) {
    const h = await api(`/projects/${PID}/threads/${t.id}/messages`);
    savedHasMarker ||= JSON.stringify(h.body ?? "").includes("（用户中断了这一轮生成）");
  }
  check("C1 中断标记已落会话 transcript", savedHasMarker);
} catch (e) {
  check("测试流程异常", false, String(e));
}

console.log(`\n—— ${results.filter(([ok]) => ok).length}/${results.length} 通过 ——`);
await browser.close();
await dropProject();
const failed = results.filter(([ok]) => !ok);
if (failed.length > 0) process.exit(1);
