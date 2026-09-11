/**
 * E2E：聊天附件/引用在对话记录里渲染成**实体 chip**，正文不进气泡（2026-09-11）。
 *
 * 背景：此前上传文档把整篇正文拼进用户消息正文再原样渲染——本地实测一条 1.2 万字
 * 剧本让气泡高 21,469px、占整个会话滚动区的 94%，还会把全文倒进「编辑重发」的
 * 输入框、把轮次轨摘要污染成「（见附件与引用的画布卡片）附件：- 文…」。行业共识
 * （codex / gemini-cli / opencode 源码）是「记录显示实体、内容走带外通道」。
 *
 * 契约（lib/chat/messageContext.ts）：消息 = 显示文本 + 界标 + 人话上下文（模型）
 * + JSON manifest（界面）。本脚本在真浏览器里锁住四条：
 *   A 文档：气泡只出 chip、正文仍在 payload 里（模型照旧读得到全文）；
 *   B 媒体：图缩略图 / 视频音频带文件名的 chip，URL 不再当正文印出来；
 *   C 引用：@ 的卡出 chip 而不是 `@<节点id>`；
 *   D 编辑重发：输入条恢复「那句话 + @ chip + 附件」，重发后 payload 语义不丢。
 *
 * 隔离：自建测试项目；SSE 用 route mock（不跑 LLM）；不依赖 dev 调试钩子，
 * 生产实例也能跑；前端需在跑（8008）。
 *
 * 运行：node scripts/chat-attachment-display-test.mjs
 *      WS_BASE=http://127.0.0.1:8008 node scripts/chat-attachment-display-test.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE = process.env.WS_BASE || "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;

const DOC_NAME = "八仙饭店第四集.txt";
const DOC_SENTENCE = "这份稿子先通读，别动手";
const DOC_BODY = `第4集：八仙饭店灭门案\n\n1985年8月8日，黑沙海滩发现漂浮残肢……\n${"剧本正文段落。".repeat(60)}\n暗号ZQ7`;
const NOTE_TITLE = "冯太后设定";
const NOTE_BODY = "设定正文暗号A1（引用行应带完整正文）";

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
  body: JSON.stringify({ name: `e2e-attach-display-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;
console.log(`测试项目: ${pid}`);

// 种一张画布卡（测 @ 引用 chip 用）
await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "n_att_note",
        type: "note",
        position: { x: 0, y: 0 },
        data: { nodeType: "note", title: NOTE_TITLE, body: NOTE_BODY },
      },
    ],
    edges: [],
  }),
});

const dir = mkdtempSync(join(tmpdir(), "ws-attach-"));
const docPath = join(dir, DOC_NAME);
writeFileSync(docPath, DOC_BODY, "utf8");
const imgPath = join(dir, "参考图.png");
writeFileSync(
  imgPath,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const mp4Path = join(dir, "片段.mp4");
writeFileSync(mp4Path, Buffer.alloc(2048, 7));
const mp3Path = join(dir, "配乐.mp3");
writeFileSync(mp3Path, Buffer.alloc(1536, 9));

// ---------- 抓 run 请求（AG-UI RunAgentInput）----------
const runs = [];
const browser = await chromium.launch();
const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
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
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: mid,
        // 刻意写长：轮次轨要求消息区可滚动才挂（短会话不渲染轨道，是它的
        // 既有几何判据），本脚本要查轨道标签就得先撑出滚动
        delta: `（模拟回复）收到。${"这一轮的细节展开，把消息区撑出滚动。".repeat(12)}`,
      },
      { type: "TEXT_MESSAGE_END", messageId: mid },
      { type: "RUN_FINISHED", threadId: "mock-thread", runId },
    ]),
  });
});

await page.goto(`${BASE}/project/${pid}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
async function openSidebar() {
  const hidden = await page.evaluate(() =>
    document.querySelector("aside.copilotKitSidebar")?.getAttribute("aria-hidden"),
  );
  if (hidden !== "false") {
    await page.locator('[aria-label="打开画布助手"]').click();
    await page.waitForTimeout(1200);
  }
}
await openSidebar();

const editor = page.locator("aside .ws-mention-input").first();
const fileInput = page.locator('aside input[type="file"]').first();

const chatText = () => page.evaluate(() => document.querySelector(".copilotKitMessages")?.innerText ?? "");
const chatHTML = () =>
  page.evaluate(() => document.querySelector(".copilotKitMessages")?.innerHTML ?? "");
const bubbles = () => page.locator(".copilotKitMessages .group.flex.justify-end");
const chips = (kind) => page.locator(`.copilotKitMessages [data-testid="chat-chip"]${kind ? `[data-kind="${kind}"]` : ""}`);
const railLabels = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[aria-label^="跳到第"]')).map((el) => {
      const a = el.getAttribute("aria-label") ?? "";
      return a.replace(/^跳到第\s*\d+\s*轮：/, "");
    }),
  );
/** 输入条附件 chip 落定（不再「上传中」） */
async function settleAttachments() {
  for (let i = 0; i < 60; i += 1) {
    const busy = await page.evaluate(() =>
      (document.querySelector("aside .copilotKitInputContainer")?.innerText ?? "").includes("上传中"),
    );
    if (!busy) return;
    await page.waitForTimeout(300);
  }
}
async function send(text) {
  const before = runs.length;
  await editor.click();
  if (text) await page.keyboard.type(text, { delay: 4 });
  await page.keyboard.press("Enter");
  for (let i = 0; i < 40 && runs.length === before; i += 1) await page.waitForTimeout(250);
  await page.waitForTimeout(800);
  return runs.at(-1) ?? {};
}
/** run 载荷里最后一条用户消息的正文（string 或多模态 parts） */
function lastUserText(run) {
  const msgs = (run?.messages ?? []).filter((m) => m?.role === "user");
  const c = msgs.at(-1)?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
  return "";
}
function parseCtx(text) {
  const i = text.indexOf("<<<WS-CTX>>>");
  const mi = text.indexOf("<<<WS-MANIFEST>>>");
  return {
    display: i >= 0 ? text.slice(0, i).trim() : text.trim(),
    manifest: mi >= 0 ? JSON.parse(text.slice(mi + "<<<WS-MANIFEST>>>".length).trim()) : null,
  };
}

// ============ A 组：文档 ============
await fileInput.setInputFiles(docPath);
await page.locator("text=已存为资料卡").first().waitFor({ timeout: 20000 }).catch(() => {});
await settleAttachments();
const runA = await send(DOC_SENTENCE);
const textA = lastUserText(runA);
const ctxA = parseCtx(textA);

check("A1 显示文本 = 用户那句话", ctxA.display === DOC_SENTENCE, JSON.stringify(ctxA.display.slice(0, 40)));
check("A2 payload 仍带文档全文（模型照旧读得到）", textA.includes("暗号ZQ7") && /- 文档「八仙饭店第四集\.txt」.*内容：/.test(textA), `payload 长 ${textA.length} · 含正文 ${textA.includes("暗号ZQ7")}`);
check(
  "A3 manifest 带 chip 需要的元数据（name/chars/nodeId）",
  ctxA.manifest?.attachments?.[0]?.name === DOC_NAME &&
    ctxA.manifest.attachments[0].chars === DOC_BODY.length &&
    typeof ctxA.manifest.attachments[0].nodeId === "string" &&
    ctxA.manifest.attachments[0].nodeId.length > 0,
  JSON.stringify(ctxA.manifest?.attachments?.[0] ?? null),
);
check("A4 气泡出现文档 chip", (await chips("document").count()) === 1, `count=${await chips().count()}`);
const docChip = (await chips("document").first().innerText()).replace(/\s+/g, " ");
check(
  "A5 chip 标签 = 文件名 + 字数",
  docChip.includes("八仙饭店第四集") && docChip.includes("字"),
  docChip,
);
const textA_dom = await chatText();
check(
  "A6 正文不进气泡（唯一暗号与界标都不出现）",
  !textA_dom.includes("ZQ7") && !textA_dom.includes("<<<") && !textA_dom.includes("剧本正文段落。"),
  `气泡长 ${textA_dom.length}`,
);
const bubbleA = (await bubbles().first().innerText()).replace(/\s+/g, " ").trim();
check(
  "A7 气泡正文就是那句话（chip 之外没有「附件：」管道文字）",
  bubbleA.endsWith(DOC_SENTENCE) && !bubbleA.includes("附件：") && !bubbleA.includes("<<<"),
  bubbleA.slice(0, 60),
);
// 这条是用户原始抱怨的量化护栏：同类消息此前实测高 21,469px（占整个会话滚动区
// 的 94%），现在必须是「一句话 + 一排 chip」的量级
const bubbleH = await bubbles().first().evaluate((el) => Math.round(el.getBoundingClientRect().height));
check("A7b 气泡高度是 chip 量级（不是 2 万 px 的字墙）", bubbleH < 300, `${bubbleH}px`);
// 搜索：正文暗号搜不到，用户那句话搜得到
await page.keyboard.press("Meta+f");
await page.waitForTimeout(400);
const searchInput = page.locator('[data-testid="chat-search-input"]');
const searchCount = page.locator('[data-testid="chat-search-count"]');
await searchInput.fill("ZQ7");
await page.waitForTimeout(600);
check("A9 搜索不命中附件正文（界面上没渲染它）", (await searchCount.innerText()).includes("无匹配"), await searchCount.innerText());
await searchInput.fill("这份稿子");
await page.waitForTimeout(600);
check("A10 搜索命中用户那句话", (await searchCount.innerText()).trim() === "1/1", await searchCount.innerText());
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// 复制：只复制那句话 + 一行附件清单
await bubbles().first().hover();
await page.waitForTimeout(200);
await page.locator('aside [aria-label="复制"]').first().click();
await page.waitForTimeout(400);
const clip = await page.evaluate(() => navigator.clipboard.readText());
check(
  "A11 复制 = 那句话 + 附件清单（不带正文）",
  clip.startsWith(DOC_SENTENCE) && clip.includes("[附件与引用]") && clip.includes(DOC_NAME) && !clip.includes("ZQ7"),
  JSON.stringify(clip.slice(0, 80)),
);

// ============ B 组：媒体 ============
await fileInput.setInputFiles([imgPath, mp4Path, mp3Path]);
await settleAttachments();
const runB = await send("这三份素材收一下");
const textB = lastUserText(runB);
const ctxB = parseCtx(textB);
check("B1 payload 附件行带媒体 URL（模型照旧拿到）", /- 图片「参考图\.png」：\S+/.test(textB), textB.split("\n").slice(-4).join(" / "));
check(
  "B2 manifest 三类都在",
  ["image", "video", "audio"].every((k) => ctxB.manifest?.attachments?.some((a) => a.kind === k)),
  JSON.stringify(ctxB.manifest?.attachments?.map((a) => a.kind)),
);
check("B3 图片 chip 是缩略图", (await chips("image").count()) === 1 && (await chips("image").first().locator("img").count()) === 1);
const vChip = (await chips("video").first().innerText()).replace(/\s+/g, " ");
const aChip = (await chips("audio").first().innerText()).replace(/\s+/g, " ");
check("B4 视频/音频 chip 带文件名（不再是笼统「视频」）", vChip.includes("片段.mp4") && aChip.includes("配乐.mp3"), `${vChip} / ${aChip}`);
const domB = await chatText();
check("B5 URL 不再当正文印出来", !domB.includes("http"), domB.slice(0, 60));

// ============ C 组：引用画布卡 ============
await editor.click();
await page.keyboard.type("参考", { delay: 4 });
await page.keyboard.type("@" + NOTE_TITLE.slice(0, 3), { delay: 60 });
await page.waitForTimeout(500);
await page
  .locator("aside button")
  .filter({ hasText: NOTE_TITLE })
  .first()
  .click();
await page.waitForTimeout(400);
check(
  "C1 输入条内联出 @ chip",
  (await editor.locator('.ws-mention[data-mention-id="n_att_note"]').count()) === 1,
);
const runC = await send("");
const textC = lastUserText(runC);
check(
  "C2 payload 引用行带完整正文（不截断）",
  textC.includes(`- @n_att_note 文本「${NOTE_TITLE}」：${NOTE_BODY}`),
  textC.split("\n").find((l) => l.includes("@n_att_note")) ?? "(无)",
);
check("C3 气泡出引用 chip", (await chips("ref").count()) >= 1);
const refChip = await chips("ref").first().innerText();
check("C4 chip 标签是「类型·标题」不是节点 id", refChip.includes(NOTE_TITLE) && refChip.includes("文本"), refChip.replace(/\s+/g, " "));
check("C5 气泡里不出现 `@<节点id>`", !(await chatText()).includes("@n_att_note"));

// 编辑重发回填 @ 引用（铅笔 → 输入条恢复那颗 chip 而不是 @id 文本）
await bubbles().last().hover();
await page.waitForTimeout(200);
await page.locator('aside [aria-label="编辑并重发"]').last().click();
await page.waitForTimeout(600);
check(
  "C6 编辑重发把 @ 引用回填成 chip（不是 @id 文本）",
  (await editor.locator('.ws-mention[data-mention-id="n_att_note"]').count()) === 1 &&
    (await editor.innerText()).includes("参考"),
  (await editor.innerText()).replace(/\s+/g, " ").slice(0, 40),
);
const runC2 = await send("");
const ctxC2 = parseCtx(lastUserText(runC2));
check(
  "C7 回填后重发：引用行仍完整进 payload",
  lastUserText(runC2).includes(`- @n_att_note 文本「${NOTE_TITLE}」`),
);
check(
  "C8 引用不重复（显示文本里 `@标题` 只出现一次——字面量+chip 双份是 bug）",
  ctxC2.display.split(`@${NOTE_TITLE}`).length - 1 === 1,
  JSON.stringify(ctxC2.display),
);

// ============ E 组：轮次轨标签（三句话，都不许被附件清单污染）============
let labels = [];
for (let i = 0; i < 20 && labels.length < 3; i += 1) {
  labels = await railLabels();
  if (labels.length < 3) await page.waitForTimeout(400);
}
check(
  "E1 轮次轨标签 = 用户那三句话（不带「附件：」管道文字）",
  labels.length >= 3 &&
    labels.every((l) => !l.includes("附件") && !l.includes("<<<") && !l.includes("@n_")) &&
    labels.includes(DOC_SENTENCE),
  JSON.stringify(labels),
);

// ============ D 组：编辑重发 ============
const firstBubble = bubbles().first();
await firstBubble.hover();
await page.waitForTimeout(200);
await page.locator('aside [aria-label="编辑并重发"]').first().click();
await page.waitForTimeout(600);
const edText = (await editor.innerText()).replace(/\s+/g, " ").trim();
check("D1 输入条恢复「那句话」（不是整篇正文）", edText.includes(DOC_SENTENCE) && !edText.includes("ZQ7"), edText.slice(0, 60));
const composer = await page.evaluate(
  () => document.querySelector("aside .copilotKitInputContainer")?.innerText ?? "",
);
check(
  "D2 附件 chip 回到输入条（只回填这条消息带的那份文档）",
  composer.includes("八仙饭店第四集") && !composer.includes("ZQ7"),
  composer.split("\n").slice(0, 3).join(" / "),
);
const runD = await send("");
const textD = lastUserText(runD);
const ctxD = parseCtx(textD);
check(
  "D3 重发后 payload 仍带全文（编辑不丢语义）",
  textD.includes("暗号ZQ7") && ctxD.display === DOC_SENTENCE && (ctxD.manifest?.attachments?.length ?? 0) >= 1,
  `payload 长 ${textD.length} · 含正文 ${textD.includes("暗号ZQ7")} · 附件 ${ctxD.manifest?.attachments?.length}`,
);
const docChipsAfter = await chips("document").count();
check("D4 重发后的气泡仍只出 chip、无正文", docChipsAfter >= 1 && !(await chatText()).includes("ZQ7"), `chips=${docChipsAfter}`);

// ============ F 组（REAL=1 才跑）：真模型端到端 ============
// 显示层藏起来了，模型侧必须照旧拿得到全文——这一条只能在真 run 里证：
// 正文里埋的暗号如果没进 payload，模型答不出来。
if (process.env.REAL === "1") {
  await page.unroute("**/agent-service");
  await fileInput.setInputFiles(docPath);
  await page.locator("text=已存为资料卡").first().waitFor({ timeout: 20000 }).catch(() => {});
  await settleAttachments();
  await editor.click();
  await page.keyboard.type("这份稿子第4集里埋的关键暗号是什么？只回暗号本身，不要解释", { delay: 4 });
  await page.keyboard.press("Enter");
  let reply = "";
  for (let i = 0; i < 240; i += 1) {
    await page.waitForTimeout(1000);
    const t = await chatText();
    // 取最后一条助手回复的可见文本（含暗号即通过）
    if (t.includes("ZQ7")) {
      reply = t;
      break;
    }
  }
  check("F1 真跑一轮：模型仍能读到附件正文（答案里有埋的暗号）", reply.includes("ZQ7"), reply ? "命中" : "等了 240s 未见暗号");
  check(
    "F2 真跑一轮：气泡仍是 chip 形态（正文没回填到界面）",
    (await chips("document").count()) >= 1 && !(await chatText()).includes("剧本正文段落。"),
  );
}

await browser.close();
await api(`/projects/${pid}`, { method: "DELETE" });

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? "✗" : "✅"} 附件显示为实体 ${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
