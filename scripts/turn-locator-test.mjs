/**
 * E2E：对话轮次快速索引（TurnLocator，juben 范式移植）。
 * 隔离：自建测试项目 + 合成会话（API 直存消息，不跑 LLM），结束自删。
 *
 * 覆盖：
 *  1) 轨道点数 = 用户轮数（「（任务通知）」系统代发不计）
 *  2) 轨道贴消息可视区右缘、纵向在区内
 *  3) 悬停展开标签面板（18 字摘要 + 轮次号），行数与点数一致
 *  4) 点早期轮 → 滚动容器 scrollTop 大幅变化 + 目标气泡闪圈类 + 落进可视区
 *  5) 末点（accent 加宽）跳回对话底部
 *
 * 前置：agent(8123) + 前端(8008) 在跑。
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;

function envLocal(key) {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return "";
}

async function api(path, init) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null };
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
  console.log(TOKEN ? "已登录（AUTH_ENABLED=true）" : "未取到 token（auth 关闭，按匿名跑）");
}

// ---------- 夹具：自建项目 + 合成会话（10 用户轮 + 10 回复 + 1 系统通知） ----------
const { body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-turn-locator-${Date.now()}` }),
});
const pid = proj.id ?? proj.project?.id;
if (!pid) throw new Error(`建项目失败: ${JSON.stringify(proj)}`);
// 会话 id 必须纯 hex（projects._THREAD_ID_RE ^[0-9a-f]{8,32}$）
const tid = format(Date.now(), 12);
console.log(`测试项目: ${pid} / 会话: ${tid}`);

function format(ms, len) {
  return ms.toString(16).padStart(len, "0").slice(-len);
}

const TURNS = [
  "第一轮：帮我拆解这个剧本的核心冲突",
  "第二轮：把主角的动机再明确一点",
  "第三轮：场景二的氛围描写加强",
  "第四轮：道具清单里加上怀表",
  "第五轮：分镜表拆成二十镜",
  "第六轮：主角设定图改成青年版",
  "第七轮：宣发文案来六条抖音风",
  "第八轮：场景参考图换成冬夜街景",
  "第九轮：服饰设定补三视图",
  "第十轮：整理画布并把视口调到全览",
];
const records = [];
TURNS.forEach((t, i) => {
  records.push({ id: `u${i}`, role: "user", content: t });
  records.push({
    id: `a${i}`,
    role: "assistant",
    content: `${"收到，这一轮的处理如下。".repeat(1)}${t.slice(3)}的完整方案：${"细节展开。这一段刻意写长，确保十条消息足以把消息区撑出滚动。".repeat(6)}`,
  });
});
// 系统代发的任务通知（用户轮里的异类）：不应进轮次索引
records.push({ id: `u${TURNS.length}`, role: "user", content: "（任务通知）分镜图已全部生成完成" });

{
  const { status } = await api(`/projects/${pid}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "轮次索引回归", id: tid }),
  });
  if (status !== 200 && status !== 201) throw new Error(`建会话失败 ${status}`);
}
{
  const { status } = await api(`/projects/${pid}/threads/${tid}/messages`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: records }),
  });
  if (status !== 200) throw new Error(`存消息失败 ${status}`);
}

// ---------- 浏览器 ----------
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addInitScript(
  (t) => t && localStorage.setItem("wingsight_studio_token", t),
  TOKEN,
);
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  await page.goto(`${BASE}/project/${pid}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);
  // 侧栏没开就点 FAB（aria-label=打开画布助手）
  const asideVisible = await page.locator("aside").first().isVisible().catch(() => false);
  if (!asideVisible) {
    await page.locator('button[aria-label="打开画布助手"]').click();
    await page.waitForTimeout(1500);
  }
  await page.waitForSelector('[data-testid="chat-turn-rail"]', { timeout: 15000 });

  // 1) 点数（任务通知不计）
  const railInfo = await page.evaluate(() => {
    const rail = document.querySelector('[data-testid="chat-turn-rail"]');
    const dots = [...rail.querySelectorAll("button")].filter((b) =>
      b.getAttribute("aria-label")?.startsWith("跳到"),
    );
    const rect = rail.getBoundingClientRect();
    const stamps = document.querySelectorAll(".copilotKitMessages [data-turn-id]").length;
    return {
      dotCount: dots.length,
      stamps,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), h: Math.round(rect.height) },
      lastDotStyle: dots.at(-1)?.getAttribute("style") ?? "",
      firstLabel: dots[0]?.getAttribute("aria-label") ?? "",
    };
  });
  check(
    "点数 = 用户轮数（任务通知不计）",
    railInfo.dotCount === TURNS.length && railInfo.stamps === TURNS.length,
    `${railInfo.dotCount} 点 / ${railInfo.stamps} 戳（预期 ${TURNS.length}）`,
  );
  check("轨道贴右缘纵向在区内", railInfo.rect.x > 1500 && railInfo.rect.x < 1600 && railInfo.rect.h > 300, JSON.stringify(railInfo.rect));
  check("末点 accent 加宽", /var\(--color-accent\)/.test(railInfo.lastDotStyle) && /width:\s*18/.test(railInfo.lastDotStyle));
  check("首点 aria-label 带轮次摘要", railInfo.firstLabel.startsWith("跳到第 1 轮："), railInfo.firstLabel.slice(0, 30));

  // 2) 悬停展开面板
  await page.hover('[data-testid="chat-turn-rail"] .group');
  await page.waitForTimeout(400);
  const panel = await page.evaluate(() => {
    const rail = document.querySelector('[data-testid="chat-turn-rail"]');
    const panel = rail.querySelector(".group > div");
    const rows = [...panel.querySelectorAll("button[data-track='chat.turnJump']")];
    return {
      display: getComputedStyle(panel).display,
      rows: rows.length,
      firstRow: rows[0]?.textContent?.trim() ?? "",
    };
  });
  check("悬停展开标签面板", panel.display === "flex" && panel.rows === TURNS.length, `display=${panel.display} rows=${panel.rows}`);
  check("面板行带 18 字摘要+轮次号", /第一轮：帮我拆解这个剧本的核心冲突\s*1$/.test(panel.firstRow.replace("…", "")), panel.firstRow.slice(0, 30));

  // 3) 跳转第 2 轮
  const scrollTop = () =>
    page.evaluate(() => {
      let el = document.querySelector(".copilotKitMessages");
      for (let i = 0; i < 12 && el && el !== document.body; i++) {
        if (i > 0 && el.scrollHeight > el.clientHeight + 2) return el.scrollTop;
        el = el.parentElement;
      }
      return -1;
    });
  const before = await scrollTop();
  await page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll('[data-testid="chat-turn-rail"] button[data-track="chat.turnJump"]'),
    ];
    rows[1].click();
  });
  await page.waitForTimeout(1200);
  const after = await scrollTop();
  check("点击跳转滚动生效", before >= 0 && after >= 0 && Math.abs(after - before) > 300, `scrollTop ${before} → ${after}`);

  const flash = await page.evaluate(() => {
    const stamped = [...document.querySelectorAll(".copilotKitMessages [data-turn-id]")];
    const flashed = stamped.find((el) => el.classList.contains("ws-turn-flash"));
    const rect = flashed?.getBoundingClientRect();
    return { flashed: !!flashed, visible: rect ? rect.y > 40 && rect.y < 900 : false };
  });
  check("目标气泡闪圈 + 落进可视区", flash.flashed && flash.visible);

  // 4) 末点跳回底部
  await page.evaluate(() => {
    const rail = document.querySelector('[data-testid="chat-turn-rail"]');
    const dots = [...rail.querySelectorAll("button")].filter((b) =>
      b.getAttribute("aria-label")?.startsWith("跳到"),
    );
    dots.at(-1).click();
  });
  await page.waitForTimeout(1200);
  const atEnd = await page.evaluate(() => {
    let el = document.querySelector(".copilotKitMessages");
    for (let i = 0; i < 12 && el && el !== document.body; i++) {
      if (i > 0 && el.scrollHeight > el.clientHeight + 2)
        return el.scrollTop >= el.scrollHeight - el.clientHeight - 40;
      el = el.parentElement;
    }
    return false;
  });
  check("末点跳回对话底部", atEnd);

  const relevant = errors.filter((e) => !e.includes("404"));
  check("无新增 console 错误", relevant.length === 0, relevant.slice(0, 3).join(" | ") || "clean");
} finally {
  await browser.close();
  await api(`/projects/${pid}`, { method: "DELETE" });
  console.log(`已清理测试项目 ${pid}`);
}

const failed = results.filter((x) => !x.ok).length;
console.log(failed === 0 ? `\n全部 ${results.length} 项通过` : `\n${failed}/${results.length} 项失败`);
process.exit(failed === 0 ? 0 : 1);
