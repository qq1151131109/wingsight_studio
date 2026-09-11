/**
 * 长内容 UX 回归（2026-09-09 review 后的三件修复）：
 *   A 复制/重新生成按钮回归助手消息工具栏（此前被 NullSlot 抹成空容器）
 *   B 折叠口径（行业共识「过程折叠、答案展开」）：长答复完整铺开、无折钮；
 *     过程侧（工具卡详情）默认收起
 *   C 会话内搜索：Cmd/Ctrl+F 打开、计数、高亮注册、Enter 跳转、Esc 关闭清高亮
 *   D 轮次轨命中区：按钮 ≥24px 宽（此前 10px 点本体）且让开滚动条
 *   E 重新生成闭环：点按钮 → 调 /chat/regenerate（带上一轮用户消息 id）
 *     → 本地历史截断 → 重新发起 run；再在 API 级验证服务端真 fork
 *     （fork 后模型看不见被删掉的旧答案）
 * 用法：node scripts/chat-longcontent-test.mjs （需 web:8008 + agent:8123 在跑）
 */
import fs from "node:fs";
import { chromium } from "playwright";

// WS_BASE 可指别的实例（如本地 dev:8009），默认生产口 8008
const WEB = process.env.WS_BASE || "http://127.0.0.1:8008";
const AGENT = "http://127.0.0.1:8123";
// 长答复夹具的字数下限：即便不再折叠，也要保证正文足够长（B 组断言「完整铺开」
// 需要一条明显的长答复；1200 字也够撑出滚动条）
const LONG_FIXTURE_CHARS = 1200;

// 认证：.env.local 有 AUTH_PASSWORD 就登录，空则不带头（本机认证关闭时的
// 常态，与 node-toolbar-select / chat-revise-image 等回归同约定；服务端
// auth_enabled=false 时不带头照常放行）。此前这里硬抛错，本机跑不起来。
const AUTH_PASSWORD = fs
  .readFileSync(".env.local", "utf8")
  .match(/^AUTH_PASSWORD=(.*)$/m)?.[1]?.trim();
let TOKEN = "";
if (AUTH_PASSWORD) {
  const login = await fetch(`${AGENT}/api/v1/auth/token`, {
    method: "POST",
    body: new URLSearchParams({ username: "admin", password: AUTH_PASSWORD }),
  });
  if (!login.ok) throw new Error(`登录失败 ${login.status}`);
  TOKEN = (await login.json()).access_token;
}

const api = async (path, init) => {
  const r = await fetch(`${AGENT}${path}`, {
    ...init,
    headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(init?.headers ?? {}) },
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
  { length: 20 },
  (_, i) =>
    `第 ${i + 1} 段：夜莺计划的分镜要点——这一段刻意写长以撑出滚动与长文场景，讲清楚机位、光线与声音的配合，并说明它与上一段在叙事上的承接关系。`,
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
      // 最新一轮的**长**答复：与更早那条同样长——用来断言两条都完整铺开
      // （旧口径下这里断言「最新不折、更早的折」，2026-09-11 起答案一律不折）
      { id: "u5", role: "user", content: "夜莺计划完整版再说一遍" },
      { id: "a5", role: "assistant", content: LONG },
    ],
  }),
});
check("夹具：长答复足够长", LONG.length > LONG_FIXTURE_CHARS, `${LONG.length} 字`);

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

// ---------- B 折叠口径：过程折叠、答案展开（2026-09-11 行业共识） ----------
// 此前按「实测溢出 >480px×1.6」自动折答案正文 + 挂「展开全文」钮；行业共识
// （ChatGPT/Claude/Perplexity 折思考块与工具调用、正文完整铺开）与用户反馈都
// 指向反面，故删掉答案折叠。这里断言两件事：长答复完整铺开、工具栏没折钮。
const foldState = await page.evaluate(() =>
  Array.from(document.querySelectorAll("aside .ws-asst-msg")).map((el) => {
    const prose = el.querySelector(".cpk\\:prose");
    return {
      chars: +(el.getAttribute("data-ws-chars") || 0),
      maxH: prose ? getComputedStyle(prose).maxHeight : null,
      clipped: prose ? prose.scrollHeight > prose.clientHeight + 2 : null,
    };
  }),
);
const longAsst = foldState.filter((r) => r.chars > 1200);
check(
  "B1 长答复完整铺开（答案不被自动折叠）",
  longAsst.length >= 1 &&
    longAsst.every((r) => r.clipped === false && (r.maxH === "none" || r.maxH === "0px")),
  JSON.stringify(longAsst),
);
check(
  "B2 工具栏无「展开全文」钮（不折就不需要）",
  (await page.locator("aside .ws-msg-toggle").count()) === 0,
);
check(
  "B3 正文折叠属性已摘除（data-ws-collapsed 不再出现）",
  (await page.locator("aside .ws-asst-msg[data-ws-collapsed]").count()) === 0,
);
// 过程侧仍折叠：工具卡长结果进 <details>（默认收起）——用 DOM 契约断言，
// 夹具里没有真工具调用，故只验「渲染器把长结果包进收起态 details」这一条规则
const detailsClosed = await page.evaluate(() => {
  const ds = Array.from(document.querySelectorAll("aside [data-ws-toolcard] details"));
  return { n: ds.length, closed: ds.every((d) => !d.open) };
});
check("B4 过程侧：工具卡详情默认收起（无卡时跳过）", detailsClosed.n === 0 || detailsClosed.closed, JSON.stringify(detailsClosed));

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

// ---------- C8 搜索打开期间的流式追加：不得打断贴底跟随 ----------
// 回归（2026-09-11 review）：旧实现 onMessagesChanged → recompute → goTo，而 goTo
// 内含 escapeStickToBottom（合成 wheel 向上）+ 平滑滚动到当前命中——搜索词命中历史
// 消息时，每来一段文字都会把视图从底部拽回历史命中处，并反复告诉「贴底跟随」库
// 「用户上滚了」。现在流式重算只刷新命中与高亮（recompute(false)），不碰滚动。
{
  await page.locator("aside .copilotKitMessages").click({ position: { x: 200, y: 200 } });
  await page.keyboard.press("Control+f");
  await page.waitForTimeout(300);
  const s8 = page.locator('aside [data-testid="chat-search-input"]');
  await s8.fill("夜莺计划"); // 命中散布全篇，当前命中会落在最早的几条上（=页面已不在底部）
  await page.waitForTimeout(700);
  const countPre = (await page.locator('aside [data-testid="chat-search-count"]').innerText()).trim();
  // 手动回到底部，模拟「用户一边搜一边看最新一轮」的常态
  await page.evaluate(() => {
    let vp = document.querySelector(".copilotKitMessages");
    for (let i = 0; i < 12 && vp && vp !== document.body; i++) {
      if (i > 0 && vp.scrollHeight > vp.clientHeight + 2) {
        vp.scrollTop = vp.scrollHeight;
        return;
      }
      vp = vp.parentElement;
    }
  });
  await page.waitForTimeout(400);
  // 发一条触发 mock run（流式回一段）
  await page.locator("aside .ws-mention-input").click();
  await page.keyboard.type("再讲讲夜莺计划的灯塔伏笔");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2600);
  const st = await page.evaluate(() => {
    let vp = document.querySelector(".copilotKitMessages");
    for (let i = 0; i < 12 && vp && vp !== document.body; i++) {
      if (i > 0 && vp.scrollHeight > vp.clientHeight + 2)
        return { atBottom: vp.scrollTop >= vp.scrollHeight - vp.clientHeight - 40 };
      vp = vp.parentElement;
    }
    return null;
  });
  const countPost = (await page.locator('aside [data-testid="chat-search-count"]').innerText()).trim();
  check("C8 流式追加后仍贴在底部（搜索没打断跟随）", st?.atBottom === true, JSON.stringify(st));
  check("C8 流式期间命中计数随之重算", countPost !== countPre, `${countPre} → ${countPost}`);
  // 关搜索条走 × 钮：此时焦点在输入条，Esc 归输入条（Esc 只在搜索输入框内生效）
  await page.locator('aside [aria-label="关闭搜索"]').click();
  await page.waitForTimeout(400);
  const hlC8 = await page.evaluate(() =>
    typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights.size : -1,
  );
  check("C8 结束后高亮已清", hlC8 === 0, `size=${hlC8}`);
}

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
    content: "请随便想一个**两字**中文词回复我，只回复那个词本身，不要解释、不要标点。",
  };
  const first = await run([u1]);
  const word = (first.replace(/[^\u4e00-\u9fa5]/g, "").slice(0, 4) || "");
  check("E7 首轮产出一个词（供 fork 断言）", word.length >= 2, word || first.slice(0, 40));
  await run([u1]); // 制造「被删掉的旧答案」留在 checkpoint 里（同时被 /chat/regenerate 存档为第 1 版）
  const fork = await api(`/chat/regenerate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId, messageId: "u1" }),
  });
  check("E8 fork 端点返回 ok", fork.status === 200 && fork.body?.ok === true, JSON.stringify(fork.body));
  const answer = await run([
    u1,
    {
      id: "u2",
      role: "user",
      content: "你上一条回复的那个词是什么？如果之前没有回复过，就只回复「没有」。",
    },
  ]);
  check(
    "E9 fork 后模型看不见旧答案",
    word.length >= 2 && !answer.includes(word),  // 单字也算词，故提示词点名「两字」，保证够独特
    JSON.stringify(answer.slice(0, 80)),
  );

}

// ---------- F 分支切换：‹ i/N ›（行业共识：显示与模型上下文一起切） ----------
// 必须用**真跑出来的线程**：夹具那种直接 PUT 消息的线程没有 LangGraph checkpoint，
// /chat/regenerate 在服务端会 404（存档也无从谈起）。所以这一块自己建项目、真跑两轮。
{
  const { body: proj3 } = await api("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `e2e-branch-${Date.now()}` }),
  });
  const PID3 = proj3.id ?? proj3.project?.id;
  const tid3 = (Date.now() + 11).toString(16).padStart(12, "0").slice(-12);
  await api(`/projects/${PID3}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "分支", id: tid3 }),
  });
  const codeMsg = {
    id: "uc",
    role: "user",
    content: "请只回复一个 6 位十六进制随机码（小写），不要任何其他字符、解释或标点。",
  };
  const runIn = async (messages) => {
    const r = await fetch(`${AGENT}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        threadId: tid3,
        runId: crypto.randomUUID(),
        messages,
        tools: [],
        context: [],
        forwardedProps: {},
        state: {},
      }),
    });
    const txt = await r.text();
    let acc = "";
    for (const line of txt.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const e = JSON.parse(line.slice(6));
        if (e.type === "TEXT_MESSAGE_CONTENT") acc += e.delta;
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
    return acc;
  };
  const codeOf = (t) => (String(t).match(/[0-9a-fA-F]{6}/) || [""])[0].toLowerCase();
  const v1 = await runIn([codeMsg]); // 真跑第 1 版
  const c1 = codeOf(v1);
  const reg = await api("/chat/regenerate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: tid3,
      messageId: "uc",
      turnMessages: [{ id: "ac1", role: "assistant", content: v1 }],
    }),
  });
  check(
    "F1 重新生成端点接受并返回 ok（该轮第 1 版被存档）",
    reg.status === 200 && reg.body?.ok === true,
    JSON.stringify(reg.body),
  );
  // 两版必须可区分，否则「切了没有」测不出来。模型对同一提示可能重复同一串
  // （实测撞过一次 4 位码），故「不同才停」重试至多 3 次
  let v2 = "";
  let c2 = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    v2 = await runIn([codeMsg, { id: "ac1", role: "assistant", content: v1 }, codeMsg]);
    c2 = codeOf(v2);
    if (c2 && c2 !== c1) break;
  }
  check(
    "F2 两版答复可区分（随机码不同，后续断言才有意义）",
    c1.length === 6 && c2.length === 6 && c1 !== c2,
    `${c1} vs ${c2}`,
  );
  // 落库当前版本（平时由 ChatPersistence 干）——「当前版本」在服务端是现算的
  await api(`/projects/${PID3}/threads/${tid3}/messages`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [codeMsg, { id: "ac2", role: "assistant", content: v2 }],
    }),
  });
  const list = await api(`/chat/branches?threadId=${tid3}`);
  const ver = list.body?.turns?.[0]?.versions ?? [];
  check(
    "F3 版本清单：第 1 版已存档（非当前）、第 2 版为当前",
    ver.length === 2 &&
      ver[0].idx === 1 &&
      ver[0].active === false &&
      ver[1].idx === 2 &&
      ver[1].active === true,
    JSON.stringify(ver.map((v) => ({ idx: v.idx, active: v.active }))),
  );

  // 浏览器侧：切换器出现（2/2）→ 点 ‹ 切回第 1 版
  await page.goto(`${WEB}/project/${PID3}`);
  await page.waitForTimeout(5000);
  if (!(await page.locator("aside").first().isVisible().catch(() => false))) {
    await page.locator('button[aria-label="打开画布助手"]').click().catch(() => {});
    await page.waitForTimeout(2000);
  }
  await page.waitForSelector('aside [data-testid="chat-branch-nav"]', { timeout: 20000 });
  // 两版码要在**导航之后**挂到 window（goto 会重建 JS 上下文，之前设的会丢）
  await page.evaluate(
    ([a, b]) => {
      window.__c1 = a;
      window.__c2 = b;
    },
    [c1, c2],
  );
  const nav = await page.evaluate(() => {
    const el = document.querySelector('aside [data-testid="chat-branch-nav"]');
    return {
      idx: el?.getAttribute("data-branch-idx"),
      text: el?.querySelector("span")?.textContent?.trim(),
    };
  });
  check(
    "F4 浏览器出现 ‹ i/N ›，当前为第 2 版（2/2）",
    nav.idx === "2" && nav.text === "2/2",
    JSON.stringify(nav),
  );
  await page.locator('aside [data-testid="chat-branch-nav"] button[aria-label="上一个版本"]').click();
  await page.waitForTimeout(2500);
  const afterSwitch = await page.evaluate(() => {
    const el = document.querySelector('aside [data-testid="chat-branch-nav"]');
    const text = document.body.innerText;
    return {
      idx: el?.getAttribute("data-branch-idx"),
      counter: el?.querySelector("span")?.textContent?.trim(),
      oldShown: text.includes(window.__c1 || "\u0000"),
      newShown: text.includes(window.__c2 || "\u0000"),
    };
  });
  check(
    "F5 点 ‹ 切回第 1 版：旧答复上屏、新答复退场（位置稳定，仍显示 1/2）",
    afterSwitch.idx === "1" &&
      afterSwitch.counter === "1/2" &&
      afterSwitch.oldShown &&
      !afterSwitch.newShown,
    JSON.stringify(afterSwitch),
  );

  // 上下文跟着切：切回第 1 版后追问，模型应复述第 1 版的码
  const echo = await runIn([
    codeMsg,
    { id: "ac1", role: "assistant", content: v1 },
    { id: "uq", role: "user", content: "你上一条回复里的那串码是什么？只回复它。" },
  ]);
  const echoed = codeOf(echo);
  check(
    "F6 切换后模型上下文跟着走（复述出第 1 版的码）",
    echoed === c1 && echoed !== c2,
    `期望 ${c1}，得到 ${echoed}（第 2 版是 ${c2}）`,
  );
  await api(`/projects/${PID3}`, { method: "DELETE" });
}

console.log(`\n—— ${results.filter(([ok]) => ok).length}/${results.length} 通过 ——`);
await browser.close();
await dropProject();
if (results.some(([ok]) => !ok)) process.exit(1);
