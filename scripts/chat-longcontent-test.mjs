/**
 * 长内容 UX 回归（2026-09-09 review 后的三件修复）：
 *   A 复制/重新生成按钮回归助手消息工具栏（此前被 NullSlot 抹成空容器）
 *   B 长回复折叠：默认收起 + 「展开全文（N 字）」/「收起」；流式中不折叠
 *   C 会话内搜索：Cmd/Ctrl+F 打开、计数、高亮注册、Enter 跳转、Esc 关闭清高亮
 *   D 轮次轨命中区：按钮 ≥24px 宽（此前 10px 点本体）且让开滚动条
 *   E 重新生成闭环：点按钮 → 调 /chat/regenerate（带上一轮用户消息 id）
 *     → 本地历史截断 → 重新发起 run；再在 API 级验证服务端真 fork
 *     （fork 后模型看不见被删掉的旧答案）
 * 用法：node scripts/chat-longcontent-test.mjs （需 web:8008 + agent:8123 在跑）
 */
import fs from "node:fs";
import { chromium } from "playwright";

const WEB = "http://127.0.0.1:8008";
const AGENT = "http://127.0.0.1:8123";
const COLLAPSE_LIMIT = 700; // 与 AssistantMessage.COLLAPSE_CHARS 同源

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

const results = [];
const check = (name, ok, detail = "") => {
  results.push([Boolean(ok), name, detail]);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------- 夹具：一个带长回复 + 可搜索词的合成会话 ----------
const { body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-longcontent-${Date.now()}` }),
});
const PID = proj.id ?? proj.project?.id;
const dropProject = () => api(`/projects/${PID}`, { method: "DELETE" }).catch(() => {});
const bail = async (e) => {
  console.error(e);
  await dropProject();
  process.exit(1);
};
process.on("uncaughtException", (e) => void bail(e));
process.on("unhandledRejection", (e) => void bail(e));

const tid = Date.now().toString(16).padStart(12, "0").slice(-12);
const LONG = Array.from(
  { length: 14 },
  (_, i) =>
    `第 ${i + 1} 段：夜莺计划的分镜要点——这一段刻意写长以触发折叠，讲清楚机位、光线与声音的配合，并说明它与上一段在叙事上的承接关系。`,
).join("\n\n");
await api(`/projects/${PID}/threads`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "长内容", id: tid }),
});
await api(`/projects/${PID}/threads/${tid}/messages`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    messages: [
      { id: "u0", role: "user", content: "讲讲夜莺计划" },
      { id: "a0", role: "assistant", content: LONG },
      { id: "u1", role: "user", content: "夜莺计划的第三段呢" },
      { id: "a1", role: "assistant", content: "夜莺计划的第三段在这里。" },
      // 补几轮把消息区撑出滚动条（D 组要量轮次轨与滚动条的关系）
      { id: "u2", role: "user", content: "再讲讲第四段" },
      { id: "a2", role: "assistant", content: "第四段同样围绕夜莺计划展开。" },
      { id: "u3", role: "user", content: "收尾怎么说" },
      { id: "a3", role: "assistant", content: "收尾回到夜莺计划的主旨。" },
      { id: "u4", role: "user", content: "还有别的吗" },
      { id: "a4", role: "assistant", content: "暂时没有，夜莺计划到此讲完。" },
    ],
  }),
});
check("夹具：长回复超过折叠阈值", LONG.length > COLLAPSE_LIMIT, `${LONG.length} 字`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1600, height: 950 },
  permissions: ["clipboard-read", "clipboard-write"],
});
await context.addInitScript(
  ([key, value]) => {
    window.localStorage.setItem(key, value);
    window.localStorage.setItem("wingsight_chat_open", "1");
  },
  ["wingsight_studio_token", TOKEN],
);
const page = await context.newPage();

// agent run（精确 /agent-service）mock：不烧 LLM；/chat/regenerate 单独记数
let runPosts = 0;
let regenCalls = [];
await page.route("**/agent-service", async (route) => {
  if (route.request().method() !== "POST") return route.continue();
  runPosts++;
  const runId = `run-${runPosts}`;
  const body = [
    { type: "RUN_STARTED", threadId: tid, runId },
    { type: "TEXT_MESSAGE_START", messageId: `m${runPosts}`, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: `m${runPosts}`, delta: `（重跑回复${runPosts}）` },
    { type: "TEXT_MESSAGE_END", messageId: `m${runPosts}` },
    { type: "RUN_FINISHED", threadId: tid, runId },
  ]
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join("");
  try {
    await route.fulfill({ status: 200, contentType: "text/event-stream", body });
  } catch {
    /* 页面侧已 abort */
  }
});
await page.route("**/agent-service/chat/regenerate", async (route) => {
  try {
    regenCalls.push(JSON.parse(route.request().postData() || "{}"));
  } catch {
    regenCalls.push({});
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  });
});

await page.goto(`${WEB}/project/${PID}`, { waitUntil: "load" });
await page.waitForSelector("aside .copilotKitAssistantMessage", { timeout: 30000 });
await page.waitForTimeout(1200);

// ---------- A 工具栏按钮 ----------
const msgs = await page.locator("aside .copilotKitAssistantMessage").all();
await msgs[0].hover();
await page.waitForTimeout(400);
const toolbar = await msgs[0].evaluate((el) => {
  const t = el.querySelector('[data-testid="copilot-assistant-toolbar"]');
  return [...(t?.querySelectorAll("button") ?? [])].map(
    (b) => b.getAttribute("aria-label") || b.getAttribute("title") || "",
  );
});
check(
  "A1 助手消息工具栏有复制钮",
  toolbar.some((t) => /复制/.test(t)),
  JSON.stringify(toolbar),
);
check(
  "A2 助手消息工具栏有重新生成钮",
  toolbar.some((t) => /重新生成/.test(t)),
  JSON.stringify(toolbar),
);
await msgs[0].locator('[data-testid="copilot-copy-button"]').click();
await page.waitForTimeout(400);
const clip = await page.evaluate(() => navigator.clipboard.readText());
check("A3 复制钮写入剪贴板（原文）", clip.startsWith("第 1 段：夜莺计划"), `${clip.length} 字`);

// ---------- B 折叠 ----------
const proseH = () =>
  page.evaluate(() => {
    const p = document.querySelector("aside .copilotKitAssistantMessage .cpk\\:prose");
    return p ? Math.round(p.getBoundingClientRect().height) : -1;
  });
check(
  "B1 长回复默认折叠（限高只作用于正文）",
  (await page.locator('aside .ws-asst-msg[data-ws-collapsed="1"]').count()) === 1,
);
const toggleText = await page.locator("aside .ws-msg-toggle").first().innerText();
check("B2 展开钮带字数", /展开全文（\d+ 字）/.test(toggleText), toggleText);
const hClamped = await proseH();
check("B3 折叠态正文限高 340px", hClamped === 340, `${hClamped}px`);
await page.locator("aside .ws-msg-toggle").first().click();
await page.waitForTimeout(300);
const hExpanded = await proseH();
check("B4 展开后正文变高", hExpanded > hClamped + 200, `${hClamped} → ${hExpanded}px`);
await page.locator("aside .ws-msg-toggle").first().click();
await page.waitForTimeout(300);
check("B5 收起恢复限高", (await proseH()) === 340);
check(
  "B6 折叠时工具栏仍在（复制/重新生成没被裁掉）",
  (await msgs[0].locator('[data-testid="copilot-copy-button"]').count()) === 1,
);

// ---------- C 会话内搜索 ----------
await page.locator("aside .copilotKitMessages").click({ position: { x: 200, y: 200 } });
await page.keyboard.press("Control+f");
await page.waitForTimeout(400);
const searchInput = page.locator('aside [data-testid="chat-search-input"]');
check("C1 Ctrl+F 打开搜索条", (await searchInput.count()) === 1);
await searchInput.fill("夜莺计划");
await page.waitForTimeout(700);
const countText = await page.locator('aside [data-testid="chat-search-count"]').innerText();
check("C2 命中计数出现", /^\d+\/\d+$/.test(countText.trim()), countText.trim());
const hlSize = await page.evaluate(() =>
  typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights.size : -1,
);
check("C3 高亮已注册（all + current）", hlSize >= 2, `size=${hlSize}`);
const before = countText.trim();
await searchInput.press("Enter");
await page.waitForTimeout(500);
const after = (await page.locator('aside [data-testid="chat-search-count"]').innerText()).trim();
check("C4 Enter 跳到下一处", after !== before, `${before} → ${after}`);
await searchInput.press("Escape");
await page.waitForTimeout(400);
check("C5 Esc 关闭搜索条", (await searchInput.count()) === 0);
const hlAfter = await page.evaluate(() =>
  typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights.size : -1,
);
check("C6 关闭后高亮清空", hlAfter === 0, `size=${hlAfter}`);

// ---------- D 轮次轨命中区 ----------
const rail = await page.evaluate(() => {
  const r = document.querySelector('[data-testid="chat-turn-rail"]');
  if (!r) return null;
  const btns = [...r.querySelectorAll("button")];
  const dot = btns.find((b) => (b.getAttribute("aria-label") || "").startsWith("跳到第"));
  const vp = [...document.querySelectorAll("aside *")].find(
    (e) => e.scrollHeight > e.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(e).overflowY),
  );
  const rb = r.getBoundingClientRect();
  const sb = vp ? vp.getBoundingClientRect() : null;
  return {
    dotW: dot ? +dot.getBoundingClientRect().width.toFixed(0) : 0,
    dotH: dot ? +dot.getBoundingClientRect().height.toFixed(0) : 0,
    railRight: +rb.right.toFixed(0),
    scrollbarLeft: sb ? +((sb.right - (vp.offsetWidth - vp.clientWidth)).toFixed(0)) : -1,
  };
});
check("D1 轮次点命中宽度 ≥24px", rail && rail.dotW >= 24, JSON.stringify(rail));
check(
  "D2 轮次轨让开滚动条",
  rail && rail.scrollbarLeft >= 0 && rail.railRight <= rail.scrollbarLeft + 1,
  `轨右缘 ${rail?.railRight} ≤ 滚动条左缘 ${rail?.scrollbarLeft}`,
);

// ---------- E 重新生成（UI 级） ----------
const runsBefore = runPosts;
await msgs[0].hover();
await page.waitForTimeout(300);
await msgs[0].locator('[data-testid="copilot-regenerate-button"]').click();
await page.waitForTimeout(1500);
check(
  "E1 调 /chat/regenerate 且带上一轮用户消息 id",
  regenCalls.length === 1 && regenCalls[0].messageId === "u0",
  JSON.stringify(regenCalls),
);
check("E2 重新发起了一轮 run", runPosts === runsBefore + 1, `${runsBefore} → ${runPosts}`);
const texts = await page.evaluate(() =>
  [...document.querySelectorAll("aside .copilotKitAssistantMessage")].map((e) => e.textContent || ""),
);
check(
  "E3 旧回答已从界面移除（本地历史截断）",
  !texts.some((t) => t.includes("第 14 段：夜莺计划")),
  `${texts.length} 条助手消息`,
);
check(
  "E4 新回答已上屏",
  texts.some((t) => t.includes("（重跑回复")),
);

// ---------- E5 API 级：服务端真 fork ----------
{
  const threadId = `regen${Date.now().toString(16)}`;
  const run = async (messages) => {
    const r = await fetch(`${AGENT}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        threadId,
        runId: crypto.randomUUID(),
        messages,
        tools: [],
        context: [],
        forwardedProps: {},
        state: {},
      }),
    });
    const txt = await r.text();
    let assistant = "";
    for (const line of txt.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const e = JSON.parse(line.slice(6));
        if (e.type === "TEXT_MESSAGE_CONTENT") assistant += e.delta;
      } catch {
        /* 忽略非 JSON 行 */
      }
    }
    return assistant;
  };
  const u1 = {
    id: "u1",
    role: "user",
    content: "请随便想一个中文词回复我，只回复那个词本身，不要解释、不要标点。",
  };
  const first = await run([u1]);
  const word = (first.replace(/[^\u4e00-\u9fa5]/g, "").slice(0, 4) || "");
  check("E5 首轮产出一个词（供 fork 断言）", word.length >= 2, word || first.slice(0, 40));
  await run([u1]); // 制造「被删掉的旧答案」留在 checkpoint 里
  const fork = await api(`/chat/regenerate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId, messageId: "u1" }),
  });
  check("E6 fork 端点返回 ok", fork.status === 200 && fork.body?.ok === true, JSON.stringify(fork.body));
  const answer = await run([
    u1,
    {
      id: "u2",
      role: "user",
      content: "你上一条回复的那个词是什么？如果之前没有回复过，就只回复「没有」。",
    },
  ]);
  check(
    "E7 fork 后模型看不见旧答案",
    word.length >= 2 && !answer.includes(word),
    JSON.stringify(answer.slice(0, 80)),
  );
}

console.log(`\n—— ${results.filter(([ok]) => ok).length}/${results.length} 通过 ——`);
await browser.close();
await dropProject();
if (results.some(([ok]) => !ok)) process.exit(1);
