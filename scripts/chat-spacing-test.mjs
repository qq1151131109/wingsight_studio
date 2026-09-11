/**
 * 聊天间距回归（2026-09-05 间距走查）：消息间距单一事实源 = 容器 gap 20px。
 * 旧实现间距是三层叠出来的（用户行零 margin + 容器零 gap + typography 的
 * p{margin:1.25em} 从 .cpk:prose 折叠出壳外 16.25px 幻影）——连发两条用户消息
 * 0px 贴死、助手连发 36.5px、工具卡混排 24px，且消息边界(16.3)≈段内边界(16)
 * 分不清哪段属于哪条回复。本测试真发三轮（短答 / 多段 / 工具卡）断言：
 *   ① 容器 gap=20 ② 所有相邻消息墨迹间距恒 20（连发贴死/双倍幻影见血）
 *   ③ 幻影已掐（prose 贴壳顶/壳底）④ 段内仍 16（space-y-4 未被误伤）
 *   ⑤ 空 prose 不占槽（工具卡消息卡贴壳顶）⑥ 横向内缩收到 20px/侧
 *   ⑦ 用户气泡 88% 口径 ⑧ v2 原厂 .copilotKitUserMessage 仍 0 命中（自绘组件在位）
 * 自建临时项目跑，结束删除。
 * 用法：node scripts/chat-spacing-test.mjs   （需 web:8008 + agent:8123 在跑）
 */
import fs from "node:fs";
import { chromium } from "playwright";

const WEB = "http://127.0.0.1:8008";
const AGENT = "http://127.0.0.1:8123";
const GAP = 20; // 与 app/globals.css「消息间距单一事实源」同源

const AUTH_PASSWORD = fs
  .readFileSync(".env.local", "utf8")
  .match(/^AUTH_PASSWORD=(.*)$/m)?.[1]?.trim();
// auth 关闭时（本机常态）按匿名跑：不带头，端点也放行——与 chat-longcontent /
// 其他回归同款降级，否则本地根本跑不了这条线
let TOKEN = "";
if (AUTH_PASSWORD) {
  const login = await fetch(`${AGENT}/api/v1/auth/token`, {
    method: "POST",
    body: new URLSearchParams({ username: "admin", password: AUTH_PASSWORD }),
  });
  if (!login.ok) throw new Error(`登录失败 ${login.status}`);
  TOKEN = (await login.json()).access_token;
  console.log("已登录（AUTH_ENABLED=true）");
} else {
  console.log("未取到 token（auth 关闭，按匿名跑）");
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

const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-spacing-${Date.now()}` }),
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
await page.goto(`${WEB}/project/${PID}`, { waitUntil: "load" });
await page.waitForTimeout(2500);
if (
  (await page.evaluate(() => document.querySelector("aside.copilotKitSidebar")?.getAttribute("aria-hidden"))) !==
  "false"
) {
  await page.locator('[aria-label="打开画布助手"]').click();
  await page.waitForTimeout(1500);
}

const idle = async (label, timeout = 150000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const busy = await page.evaluate(() => Boolean(document.querySelector('[aria-label="停止生成"]')));
    if (!busy) {
      await page.waitForTimeout(1000);
      return;
    }
    await page.waitForTimeout(700);
  }
  throw new Error(`${label} 等不到空闲`);
};
const say = async (text, label) => {
  const ed = page.locator("aside .copilotKitInputEditor").first();
  await ed.click();
  await page.keyboard.type(text, { delay: 8 });
  await page.keyboard.press("Enter");
  await idle(label);
};

await say("用一句话说明你能帮我做什么", "M1 短答");
await say("写一段江南水乡空镜的描述，分成三段", "M2 多段");
await say("在画布上建一张剧本卡，标题《间距测试》", "M3 工具卡");

const m = await page.evaluate(() => {
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), l: +b.left.toFixed(1), r: +b.right.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
  };
  const wrap = document.querySelector(".copilotKitMessages");
  const kids = wrap ? [...wrap.children] : [];
  // 每条消息的「墨迹盒」：用户行=气泡；助手=可见块的首顶/末底（零高工具栏不算）
  const rows = kids.map((k) => {
    const isUser = k.classList.contains("group");
    const bubble = isUser ? k.querySelector(".bg-accent") : null;
    const blocks = isUser ? [] : [...k.children].filter((c) => c.getBoundingClientRect().height > 0.5);
    const ink = isUser ? r(bubble) : blocks.length ? { t: r(blocks[0]).t, b: r(blocks[blocks.length - 1]).b } : null;
    const prose = isUser ? null : k.querySelector(".cpk\\:prose");
    const ps = prose ? [...prose.querySelectorAll("p")] : [];
    return {
      isUser,
      shell: r(k),
      ink,
      proseTop: prose ? r(prose).t : null,
      proseVisible: prose ? getComputedStyle(prose).display !== "none" : null,
      shellPadTop: getComputedStyle(k).paddingTop,
      shellPadBottom: getComputedStyle(k).paddingBottom,
      paraGaps: ps.slice(0, -1).map((p, i) => +(r(ps[i + 1]).t - r(p).b).toFixed(1)),
      blockGaps: isUser ? [] : blocks.slice(0, -1).map((b, i) => +(r(blocks[i + 1]).t - r(b).b).toFixed(1)),
      text: (k.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 24),
    };
  });
  const gaps = rows.slice(0, -1).map((a, i) =>
    a.ink && rows[i + 1].ink ? +(rows[i + 1].ink.t - a.ink.b).toFixed(1) : null,
  );
  const content = document.querySelector('[data-testid="copilot-scroll-content"]');
  const userBubbles = [...document.querySelectorAll(".copilotKitMessages .bg-accent")];
  return {
    wrapGap: wrap ? getComputedStyle(wrap).gap : null,
    contentW: content ? r(content).w : null,
    contentR: content ? r(content).r : null,
    rows,
    gaps,
    stockUserCount: document.querySelectorAll(".copilotKitUserMessage").length,
    bubble: userBubbles.length ? { w: Math.max(...userBubbles.map((b) => r(b).w)), rightGap: +(r(content).r - Math.max(...userBubbles.map((b) => r(b).r))).toFixed(1) } : null,
  };
});

console.log(`· 消息 ${m.rows.length} 条，相邻墨迹间距 [${m.gaps.join(", ")}]，容器 gap=${m.wrapGap}`);
console.log(`· 段内间距 [${m.rows.flatMap((x) => x.paraGaps).join(", ")}]，消息内块间距 [${m.rows.flatMap((x) => x.blockGaps).join(", ")}]`);
for (const x of m.rows) {
  console.log(
    `   - ${x.isUser ? "user" : "asst"} shell[${x.shell.t}..${x.shell.b}] ink[${x.ink?.t}..${x.ink?.b}]` +
      ` proseTop=${x.proseTop} proseVisible=${x.proseVisible} blocks=${x.blockGaps.length + 1} 「${x.text}」`,
  );
}

check("① 消息容器 gap 是单一事实源（20px）", m.wrapGap === "20px", `gap=${m.wrapGap}`);
const gapVals = m.gaps.filter((g) => g !== null);
check(
  "② 所有相邻消息墨迹间距恒 20px（连发贴死/双倍幻影见血）",
  gapVals.length >= 4 && gapVals.every((g) => Math.abs(g - GAP) <= 1),
  `[${gapVals.join(", ")}]`,
);
const shells = m.rows.filter((x) => !x.isUser && x.proseVisible);
check(
  "③ typography 幻影已掐（prose 贴壳顶、末块贴壳底）",
  shells.length > 0 &&
    shells.every(
      (x) => x.proseTop !== null && Math.abs(x.proseTop - x.shell.t) <= 1 && Math.abs(x.shell.b - x.ink.b) <= 1,
    ),
  shells.map((x) => `顶${(x.proseTop - x.shell.t).toFixed(1)}/底${(x.shell.b - x.ink.b).toFixed(1)}`).join(" "),
);
const paraGaps = m.rows.flatMap((x) => x.paraGaps);
check("④ 段内间距仍 16px（space-y-4 未被误伤）", paraGaps.length >= 2 && paraGaps.every((g) => Math.abs(g - 16) <= 1), `[${paraGaps.join(", ")}]`);
// ⑤ 工具卡上下间距：卡要么贴壳顶（纯卡消息，空 prose 已掐），要么与前一块的
// 间距恰为消息内块间距 10px（正文→卡同条消息，v2 聚合后的常见形状）。
// 卡顶槽若大于 10px 就是空 prose 复活占槽
const cardRows = m.rows.filter((x) => !x.isUser && x.blockGaps.length >= 1 && x.text.includes("画布操作"));
const pureCardRows = m.rows.filter((x) => !x.isUser && x.blockGaps.length === 0 && x.text.includes("画布操作"));
const cardTopOk =
  (cardRows.length > 0 &&
    cardRows.every((x) => x.blockGaps.every((g) => Math.abs(g - 10) <= 1))) ||
  (pureCardRows.length > 0 &&
    pureCardRows.every((x) => Math.abs(x.ink.t - x.shell.t) <= 1));
check(
  "⑤ 工具卡不占多余槽（正文→卡恰 10px / 纯卡贴壳顶）",
  cardTopOk,
  cardRows.length
    ? `块间距[${cardRows.map((x) => x.blockGaps.join("/")).join(",")}]`
    : pureCardRows.length
      ? pureCardRows.map((x) => (x.ink.t - x.shell.t).toFixed(1)).join(",")
      : "无工具卡消息",
);
check(
  "⑥ 横向内缩：左 20px / 右 42px（右侧给轮次轨留专用槽），正文 ≥350px",
  (m.contentW ?? 0) >= 350,
  `正文宽=${m.contentW}`,
);
check(
  "⑦ 用户气泡 88% 口径且右缘贴正文右缘",
  m.bubble && m.bubble.w <= (m.contentW ?? 0) * 0.88 + 1 && m.bubble.rightGap >= 0 && m.bubble.rightGap <= 8,
  m.bubble ? `气泡宽=${m.bubble.w} 右距=${m.bubble.rightGap}` : "无用户气泡",
);
check("⑧ v2 原厂用户组件仍 0 命中（自绘气泡在位）", m.stockUserCount === 0, `count=${m.stockUserCount}`);

// ⑨⑩ 用户气泡换行保留：自绘槽位替换了 v2 原厂组件（原厂带 whitespace-pre-wrap），
// 漏掉就是换行坍缩成一整段（真实事故）。多行消息发一条，断言渲染保行
const sayMultiline = async (lines, label) => {
  const ed = page.locator("aside .copilotKitInputEditor").first();
  await ed.click();
  for (let i = 0; i < lines.length; i++) {
    await page.keyboard.type(lines[i], { delay: 8 });
    if (i < lines.length - 1) await page.keyboard.press("Shift+Enter");
  }
  await page.keyboard.press("Enter");
  await idle(label);
};
await sayMultiline(["第一行：画布上已经有主角设定", "第二行：画风用「水墨纪实」", "第三行：先出主角三视图"], "M4 多行");
const ml = await page.evaluate(() => {
  const bubble = [...document.querySelectorAll(".copilotKitMessages .bg-accent")].pop();
  if (!bubble) return null;
  const cs = getComputedStyle(bubble);
  const lh = parseFloat(cs.lineHeight);
  const text = (bubble.innerText ?? "").replace(/\s+/g, "");
  return { ws: cs.whiteSpace, h: bubble.clientHeight, lh, text };
});
check("⑨ 用户气泡 white-space: pre-wrap（换行不坍缩）", ml?.ws === "pre-wrap", `ws=${ml?.ws}`);
check(
  "⑩ 多行消息按 3 行渲染（盒高 ≥ 2.6 行高）",
  Boolean(ml) && ml.h >= ml.lh * 2.6 && ml.text.includes("第一行") && ml.text.includes("第三行"),
  ml ? `盒高=${ml.h} 行高=${ml.lh}` : "无气泡",
);

await page.screenshot({ path: "/tmp/chat-spacing-after.png" });
const asideEl = await page.$("aside.copilotKitSidebar");
if (asideEl) await asideEl.screenshot({ path: "/tmp/chat-spacing-after-aside.png" });
await browser.close();
await dropProject();

const failed = results.filter(([ok]) => !ok);
if (failed.length) {
  console.error(`\n✗✗ 聊天间距回归 ${failed.length}/${results.length} 未过`);
  process.exit(1);
}
console.log(`\n✓✓ 聊天间距回归全过（${results.length} 项，临时项目已删）`);
