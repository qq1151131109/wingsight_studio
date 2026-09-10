/**
 * E2E：聊天上传文档 → 落资料卡 → 发给 agent 的画布摘要必须含这张卡。
 *
 * 背景（2026-09-10 八仙饭店项目实况）：用户上传 12k 字剧本、agent 却回
 * 「画布上目前还是空的」，并按「空的」规划「剧本全文落卡」——真执行就会
 * 多出一张重复的剧本卡。要么摘要那一刻确实还是空的（上传落卡与建上下文
 * 之间有竞态），要么 agent 读到了却当成空。本脚本把这件事钉死：
 * 落卡后立刻发送 / 隔 3 秒再发送，两条路径都断言 agent 收到的摘要含该卡。
 *
 * 隔离：自建测试项目；SSE 用 route mock（不跑 LLM、不落聊天记录）。
 * 无浏览器钩子依赖，生产模式下也能跑；但前端需在跑（8008）。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;
const DOC_TITLE = "《香港奇案》第四集：八仙饭店灭门案.txt";
/** 资料卡标题 = 文件名去扩展名（ingest.addDocCard 剥后缀） */
const DOC_CARD_TITLE = "《香港奇案》第四集：八仙饭店灭门案";
const DOC_BODY = `第4集：八仙饭店灭门案\n\n1985年8月8日，黑沙海滩发现漂浮残肢……\n${"剧本正文段落。".repeat(40)}`;

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
    headers: {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-doc-card-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;
console.log(`测试项目: ${pid}`);

const dir = mkdtempSync(join(tmpdir(), "ws-doc-"));
const docPath = join(dir, DOC_TITLE);
writeFileSync(docPath, DOC_BODY, "utf8");

// ---------- 抓 run 请求（AG-UI RunAgentInput）----------
const runs = [];
const browser = await chromium.launch();
const page = await browser.newPage();
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
await page.route("**/agent-service", async (route) => {
  const req = route.request();
  if (req.method() !== "POST") return route.continue();
  try {
    runs.push(JSON.parse(req.postData() || "{}"));
  } catch {
    runs.push({});
  }
  const runId = `run-${runs.length}`;
  const mid = `m-${runId}`;
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: sse([
      { type: "RUN_STARTED", threadId: "mock-thread", runId },
      { type: "TEXT_MESSAGE_START", messageId: mid, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: mid, delta: "（模拟回复）收到" },
      { type: "TEXT_MESSAGE_END", messageId: mid },
      { type: "RUN_FINISHED", threadId: "mock-thread", runId },
    ]),
  });
});

await page.goto(`${BASE}/project/${pid}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
if (
  (await page.evaluate(() =>
    document.querySelector("aside.copilotKitSidebar")?.getAttribute("aria-hidden"),
  )) !== "false"
) {
  await page.locator('[aria-label="打开画布助手"]').click();
  await page.waitForTimeout(1200);
}

const editor = page.locator("aside .copilotKitInputEditor").first();
const fileInput = page.locator('aside input[type="file"]').first();

/** 摘要文本：RunAgentInput.context 里 description 含「画布」那条 */
const canvasSummaryOf = (body) => {
  const ctx = body?.context ?? [];
  const item = ctx.find((c) => String(c?.description ?? "").includes("画布"));
  return String(item?.value ?? "");
};

// ---------- 场景 1：落卡后**立刻**发送 ----------
await fileInput.setInputFiles(docPath);
// 等到落卡 toast（意味着 addDocCard 已执行），随即立刻发送，不加任何等待
await page.locator("text=已存为资料卡").first().waitFor({ timeout: 15000 }).catch(() => {});
await editor.click();
await page.keyboard.type("这份稿子读一下，先别动手", { delay: 4 });
await page.keyboard.press("Enter");
await page.waitForTimeout(4000);

check("场景1 请求已发出", runs.length >= 1, `runs=${runs.length}`);
const s1 = canvasSummaryOf(runs[0]);
check("场景1 摘要有画布内容的 description", s1.length > 0, `len=${s1.length}`);
check(
  "场景1 摘要含刚落下的资料卡（立刻发送也不许丢）",
  s1.includes(DOC_CARD_TITLE),
  s1 ? s1.split("\n").slice(0, 4).join(" / ") : "(摘要为空)",
);
check(
  "场景1 资料卡带可辨识标记（agent 才知道稿子已在画布上）",
  /\[资料卡\]/.test(s1) && /正文已落卡\s*\d+\s*字/.test(s1),
  s1.split("\n").find((l) => l.includes("资料卡")) ?? "(没有资料卡行)",
);
const msg1 = JSON.stringify(runs[0]?.messages ?? []);
check("场景1 文档正文仍随消息内联（附件通道没坏）", msg1.includes("八仙饭店"), `len=${msg1.length}`);

// ---------- 场景 2：隔 3 秒再发送（对照组）----------
await page.waitForTimeout(3000);
await fileInput.setInputFiles(docPath);
await page.locator("text=已存为资料卡").first().waitFor({ timeout: 15000 }).catch(() => {});
await page.waitForTimeout(3200);
await editor.click();
await page.keyboard.type("再发一次，隔了几秒", { delay: 4 });
await page.keyboard.press("Enter");
await page.waitForTimeout(4000);
check("场景2 请求已发出", runs.length >= 2, `runs=${runs.length}`);
const s2 = canvasSummaryOf(runs[runs.length - 1]);
check("场景2 摘要含资料卡（对照组，必须绿）", s2.includes(DOC_CARD_TITLE), s2.split("\n")[0] ?? "");

// ---------- 服务端也应有这张卡（落库对齐）----------
const { body: canvas } = await api(`/projects/${pid}/canvas`);
const cards = (canvas?.nodes ?? []).filter((n) => String(n?.data?.title ?? "").includes("八仙饭店"));
check("服务端画布有该资料卡", cards.length >= 1, `cards=${cards.length}`);
check(
  "落库带 docCard 标记（sanitize 不吞新字段）",
  cards.length > 0 && cards.every((n) => n?.data?.docCard === true),
  JSON.stringify(cards.map((n) => n?.data?.docCard)),
);

// ---------- 重载后摘要仍认得出资料卡（装载 sanitize 幂等）----------
runs.length = 0;
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);
if (
  (await page.evaluate(() =>
    document.querySelector("aside.copilotKitSidebar")?.getAttribute("aria-hidden"),
  )) !== "false"
) {
  await page.locator('[aria-label="打开画布助手"]').click();
  await page.waitForTimeout(1200);
}
await page.locator("aside .copilotKitInputEditor").first().click();
await page.keyboard.type("重载后再发一次", { delay: 4 });
await page.keyboard.press("Enter");
await page.waitForTimeout(4000);
const s3 = canvasSummaryOf(runs[runs.length - 1] ?? {});
check(
  "重载后摘要仍标 [资料卡]（标记不丢）",
  /\[资料卡\]/.test(s3) && /正文已落卡/.test(s3),
  s3.split("\n").find((l) => l.includes("资料卡")) ?? "(没有资料卡行)",
);

await browser.close();
await api(`/projects/${pid}`, { method: "DELETE" });

const bad = results.filter((r) => !r.ok);
console.log(
  `\n${bad.length ? "✗" : "✅"} 上传文档落卡→摘要 ${results.length - bad.length}/${results.length} 项通过`,
);
process.exit(bad.length ? 1 : 0);
