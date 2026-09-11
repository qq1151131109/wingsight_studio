/**
 * E2E：对话轮次快速索引（TurnLocator，juben 范式移植）。
 * 隔离：自建测试项目 + 合成会话（API 直存消息，不跑 LLM），结束自删。
 *
 * 覆盖：
 *  1) 轨道点数 = 用户轮数（「（任务通知）」系统代发不计）
 *  2) 轨道贴消息可视区右缘、纵向在区内
 *  3) 悬停展开标签面板（18 字摘要 + 轮次号），行数与点数一致 + 面板入场动效类
 *  4) 点早期轮 → 滚动容器 scrollTop 大幅变化 + 目标气泡闪圈类 + 落进可视区
 *  5) 末点（accent 加宽）跳回对话底部 + 点击脉冲类
 *  6) 动效（2026-09-11）：悬停展宽真生效（! 工具类压过 inline width——初版
 *     裸类 group-hover/dot:w-5 被 inline 永远压住是从未生效的死代码）、末点
 *     入场动效类在位、悬停变 accent
 *  7) 位置口径（2026-09-11 用户反馈「挡字 + 有点靠下」）：圆点落在右侧专用槽
 *     （不压正文右缘、不压 20px 滚动条带）、纵向居中于可读带（输入浮层之上）
 *
 * 注：位置口径断言依赖「右侧 42px 内缩」+「输入条 .copilotKitInputContainer」，
 * 改动 globals.css 的内缩或换掉 v2 输入条类名时这两条会红——它们就是护栏。
 *
 * 前置：agent(8123) + 前端(8008) 在跑。
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.WS_BASE || "http://127.0.0.1:8008";
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
    // 位置口径核对（2026-09-11「挡字 + 靠下」）：正文实际右缘 / 可读带 / 圆点外沿
    const list = document.querySelector(".copilotKitMessages");
    let textRight = 0;
    list?.querySelectorAll("p,li,td,div").forEach((n) => {
      if (!n.textContent?.trim() || getComputedStyle(n).display === "none") return;
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.right > textRight && r.right <= window.innerWidth) textRight = r.right;
    });
    let vp = list;
    for (let i = 0; i < 12 && vp && vp !== document.body; i++) {
      if (i > 0 && vp.scrollHeight > vp.clientHeight + 2 && vp.clientHeight <= window.innerHeight * 1.2) break;
      vp = vp.parentElement;
    }
    const vpRect = vp?.getBoundingClientRect();
    // 可读带底 = 输入浮层顶（输入条 absolute bottom-0 压在滚动视口下沿之上）
    const composerTop = document.querySelector(".copilotKitInputContainer")?.getBoundingClientRect().top;
    const bandTop = vpRect?.top ?? null;
    const bandBottom = vpRect ? Math.min(vpRect.bottom, composerTop ?? vpRect.bottom) : null;
    const dotRects = [...rail.querySelectorAll(".ws-turn-dot")].map((d) => d.getBoundingClientRect());
    return {
      dotCount: dots.length,
      stamps,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), h: Math.round(rect.height) },
      // 圆点视觉在按钮内的 span 上（按钮本体是 24px 宽的命中列，2026-09-09）
      lastDotStyle: dots.at(-1)?.firstElementChild?.getAttribute("style") ?? "",
      lastDotClass: dots.at(-1)?.firstElementChild?.className ?? "",
      lastDotHitW: Math.round(dots.at(-1)?.getBoundingClientRect().width ?? 0),
      firstLabel: dots[0]?.getAttribute("aria-label") ?? "",
      textRight: Math.round(textRight),
      dotLeft: Math.round(Math.min(...dotRects.map((d) => d.left))),
      dotRight: Math.round(Math.max(...dotRects.map((d) => d.right))),
      dotCenter: dotRects.length
        ? Math.round((Math.min(...dotRects.map((d) => d.top)) + Math.max(...dotRects.map((d) => d.bottom))) / 2)
        : null,
      bandCenter: bandTop !== null && bandBottom !== null ? Math.round((bandTop + bandBottom) / 2) : null,
      winW: window.innerWidth,
    };
  });
  check(
    "点数 = 用户轮数（任务通知不计）",
    railInfo.dotCount === TURNS.length && railInfo.stamps === TURNS.length,
    `${railInfo.dotCount} 点 / ${railInfo.stamps} 戳（预期 ${TURNS.length}）`,
  );
  check("轨道贴右缘纵向在区内", railInfo.rect.x > 1500 && railInfo.rect.x < 1600 && railInfo.rect.h > 300, JSON.stringify(railInfo.rect));
  check("末点 accent 加宽", /var\(--color-accent\)/.test(railInfo.lastDotStyle) && /width:\s*18/.test(railInfo.lastDotStyle));
  check("圆点命中区 ≥24px（10px 点本体点不中）", railInfo.lastDotHitW >= 24, `${railInfo.lastDotHitW}px`);
  check("首点 aria-label 带轮次摘要", railInfo.firstLabel.startsWith("跳到第 1 轮："), railInfo.firstLabel.slice(0, 30));
  check("末点入场动效类在位", /ws-turn-dot-in/.test(railInfo.lastDotClass ?? ""), railInfo.lastDotClass?.slice(0, 60) ?? "");
  // 位置口径（2026-09-11 用户反馈「挡字 + 有点靠下」）：圆点必须落在右侧专用槽里
  // ——不压正文最后一列字（旧版稳定重叠 14px），也不压右缘 20px 滚动条带
  check(
    "圆点不压正文（专用槽，净空 ≥1px）",
    railInfo.dotLeft > railInfo.textRight,
    `正文右缘=${railInfo.textRight} 圆点左缘=${railInfo.dotLeft}（净空 ${railInfo.dotLeft - railInfo.textRight}px）`,
  );
  check(
    "圆点不压滚动条带（右缘 ≤ 窗口-20）",
    railInfo.dotRight <= railInfo.winW - 20,
    `圆点右缘=${railInfo.dotRight} 阈值=${railInfo.winW - 20}`,
  );
  // 纵向以「可读带」居中而非滚动视口整高：输入条是浮层，用视口居中会整体偏低
  check(
    "纵向居中于可读带（输入浮层之上）",
    railInfo.bandCenter !== null && Math.abs(railInfo.dotCenter - railInfo.bandCenter) <= 12,
    `圆点中心=${railInfo.dotCenter} 可读带中心=${railInfo.bandCenter} 偏差=${railInfo.dotCenter - railInfo.bandCenter}`,
  );

  // 1.5) 动效：悬停展宽 + 变 accent（回归死代码——裸类被 inline width 压住）
  const dotBtn = page.locator('[data-testid="chat-turn-rail"] button[aria-label^="跳到"]').nth(1);
  const dotStyle = (i) =>
    page.evaluate((k) => {
      const d = [
        ...document.querySelectorAll('[data-testid="chat-turn-rail"] .ws-turn-dot'),
      ][k];
      const cs = d ? getComputedStyle(d) : null;
      return {
        w: d ? Math.round(d.getBoundingClientRect().width) : 0,
        bg: cs?.backgroundColor ?? "",
        // 回弹曲线（任意值类 ease-[…] 编译失败会静默退回默认 ease）
        ease: cs?.transitionTimingFunction ?? "",
      };
    }, i);
  const rest = await dotStyle(1);
  await dotBtn.hover();
  await page.waitForTimeout(320); // 过渡 200ms 走完
  const hoverInfo = await dotStyle(1);
  await page.mouse.move(50, 500); // 撤离悬停
  await page.waitForTimeout(320);
  const back = await dotStyle(1);
  check("悬停展宽 10→20px（! 压过 inline）", rest.w === 10 && hoverInfo.w === 20, `${rest.w} → ${hoverInfo.w}px`);
  check(
    "悬停变 accent 色（与静止态自身对比，不依赖末点形态）",
    rest.bg !== hoverInfo.bg && hoverInfo.bg !== "rgba(0, 0, 0, 0)",
    `${rest.bg} → ${hoverInfo.bg}`,
  );
  check("撤离回缩 10px", back.w === 10, `${back.w}px`);
  check(
    "圆点过渡为回弹曲线",
    back.ease.includes("cubic-bezier(0.34, 1.4, 0.64, 1)"),
    back.ease.slice(0, 48),
  );
  check("圆点过渡为回弹曲线", rest.ease.includes("cubic-bezier(0.34, 1.4, 0.64, 1)"), rest.ease.slice(0, 48));

  // 2) 悬停展开面板（顺带断言：面板里为当前轮做的 scrollIntoView 不能外溢到
  //    消息区——悬停一下画面自己滚起来是最恼人的那类副作用）
  const msgScrollTop = () =>
    page.evaluate(() => {
      let el = document.querySelector(".copilotKitMessages");
      for (let i = 0; i < 12 && el && el !== document.body; i++) {
        if (i > 0 && el.scrollHeight > el.clientHeight + 2) return Math.round(el.scrollTop);
        el = el.parentElement;
      }
      return -1;
    });
  const hoverScrollBefore = await msgScrollTop();
  await page.hover('[data-testid="chat-turn-rail"] .group');
  await page.waitForTimeout(400);
  const panel = await page.evaluate(() => {
    const rail = document.querySelector('[data-testid="chat-turn-rail"]');
    const panel = rail.querySelector(".group > div");
    const rows = [...panel.querySelectorAll("button[data-track='chat.turnJump']")];
    return {
      display: getComputedStyle(panel).display,
      cls: panel.className,
      rows: rows.length,
      firstRow: rows[0]?.textContent?.trim() ?? "",
    };
  });
  check(
    // 面板**即时出现**：入场动效已按「高频交互不该播」删除（d9b2432，
    // group-hover 的 display 翻转会每次悬停重放一遍）——断言反向锁住这个决定
    "悬停展开标签面板（即时出现，无入场动效类）",
    panel.display === "flex" && panel.rows === TURNS.length && !/ws-turn-panel-in/.test(panel.cls),
    `display=${panel.display} rows=${panel.rows}`,
  );
  check("面板行带 18 字摘要+轮次号", /第一轮：帮我拆解这个剧本的核心冲突\s*1$/.test(panel.firstRow.replace("…", "")), panel.firstRow.slice(0, 30));
  const hoverScrollAfter = await msgScrollTop();
  check(
    "悬停展开面板不滚动消息区",
    hoverScrollBefore >= 0 && hoverScrollBefore === hoverScrollAfter,
    `scrollTop ${hoverScrollBefore} → ${hoverScrollAfter}`,
  );

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

  // 4) 末点跳回底部（点击同时断言即时脉冲类——React 合成事件里同步落 DOM）
  const pulsed = await page.evaluate(() => {
    const rail = document.querySelector('[data-testid="chat-turn-rail"]');
    const dots = [...rail.querySelectorAll("button")].filter((b) =>
      b.getAttribute("aria-label")?.startsWith("跳到"),
    );
    const last = dots.at(-1);
    last.click();
    return last.firstElementChild?.classList.contains("ws-turn-dot-pulse") ?? false;
  });
  check("末点点击即时脉冲类", pulsed);
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

  // 5) scroll-sync：当前阅读轮跟着滚动走（2026-09-11 新增）
  //    语义——实心 accent 18px = 你正在读的那一轮；accent 空心环 = 最新一轮
  //    先把指针移开：第 2 段的悬停停在轨道上、正压着中间的圆点，它会一直保持
  //    悬停宽度（实测把「当前轮」探测出两个匹配项）
  await page.mouse.move(400, 500);
  await page.waitForTimeout(350);
  const dotProbe = () =>
    page.evaluate(() => {
      const dots = [
        ...document.querySelectorAll('[data-testid="chat-turn-rail"] .ws-turn-dot'),
      ];
      const rows = [
        ...document.querySelectorAll(
          '[data-testid="chat-turn-rail"] button[data-track="chat.turnJump"][data-active]',
        ),
      ];
      const style = dots.map((d) => {
        const cs = getComputedStyle(d);
        return {
          w: Math.round(d.getBoundingClientRect().width),
          bg: cs.backgroundColor,
          ring: cs.boxShadow.includes("inset"),
        };
      });
      return {
        // 实心 accent（当前轮）：不透明背景 + 宽 18 + 非空心环
        solids: style
          .map((s, i) => (s.bg !== "rgba(0, 0, 0, 0)" && !s.ring && s.w >= 18 ? i : -1))
          .filter((i) => i >= 0),
        rings: style.map((s, i) => (s.ring ? i : -1)).filter((i) => i >= 0),
        widths: style.map((s) => s.w),
        activeRows: rows.filter((r) => r.dataset.active === "1").length,
        n: dots.length,
      };
    });
  const atBottom = await dotProbe();
  check(
    "scroll-sync：滚到底时当前轮 = 末轮（实心 accent，无空心环）",
    atBottom.solids.length === 1 && atBottom.solids[0] === atBottom.n - 1 && atBottom.rings.length === 0,
    JSON.stringify(atBottom),
  );
  // 滚到顶 → 当前轮应变成第一轮，末轮退化为空心环
  await page.evaluate(() => {
    let el = document.querySelector(".copilotKitMessages");
    for (let i = 0; i < 12 && el && el !== document.body; i++) {
      if (i > 0 && el.scrollHeight > el.clientHeight + 2) {
        el.scrollTop = 0;
        return;
      }
      el = el.parentElement;
    }
  });
  await page.waitForTimeout(700);
  const atTop = await dotProbe();
  check(
    "scroll-sync：滚到顶时当前轮变第一轮、末轮呈空心环",
    atTop.solids.length === 1 && atTop.solids[0] === 0 && atTop.rings.length === 1 && atTop.rings[0] === atTop.n - 1,
    JSON.stringify(atTop),
  );
  check(
    "scroll-sync：面板当前轮那行高亮（恰一行）",
    atTop.activeRows === 1,
    `activeRows=${atTop.activeRows}`,
  );

  // 6) 键盘导航：Alt+↓ 下一轮（侧栏打开时接管）
  const topBefore = await scrollTop();
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForTimeout(1200);
  const afterKey = await dotProbe();
  check(
    "Alt+↓ 跳到下一轮（当前轮前移）",
    afterKey.solids.length === 1 && afterKey.solids[0] > (atTop.solids[0] ?? 0),
    `solid ${JSON.stringify(atTop.solids)} → ${JSON.stringify(afterKey.solids)}（scrollTop ${topBefore} → ${await scrollTop()}）`,
  );
  await page.keyboard.press("Alt+End");
  await page.waitForTimeout(1200);
  const afterEnd = await dotProbe();
  check(
    "Alt+End 跳到末轮",
    afterEnd.solids.length === 1 && afterEnd.solids[0] === afterEnd.n - 1,
    JSON.stringify(afterEnd),
  );

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
