/**
 * 工作台布局/口径回归（侧栏让位同源 + 底坞说人话 + 空态不装神）：
 *
 *  P0-1 侧栏让位：CopilotKit v2 只在**不传 width prop** 时才挂 ResizeObserver 量
 *  aside 实测宽度，再据此写 body 的 margin-inline-end。传了 width 就把让位钉死在
 *  传入值，而实际宽度由可拖的 --ws-chat-w 决定（存 localStorage）——两者一不等，
 *  侧栏就盖住画布右缘：顶栏「主题/分享/账户」被裁、小地图被吃一条、底坞偏右。
 *
 *  P0-2 底坞口径：出图模型按钮绝不显示内部模型 id（加载中/失败/已下架说人话），
 *  目录接口 500 时明报；画风按钮同理直显生效值（未选就写「未选画风」）。
 *
 *  P1 空态：空画布上不渲染小地图（无内容空块像渲染故障）；聊天侧栏空态有
 *  一行助手身份说明（v2 WelcomeScreen 因我们显式管 threadId 而永不渲染）。
 *
 *  P2 窄窗口不挤没画布：侧栏宽度 clamp 三处同口径（装载 / 拖拽 / resize：上限
 *  = 视口 - 活动栏 56 - 画布最小可用宽 420），顶栏右组 shrink-0 不折行（旧行为：
 *  「分享」竖排成两行）；即使带着陈旧宽度（760px），左上工具条也得把齿轮留在
 *  画布内——搜索框写死 w-52 不收缩时会把齿轮顶到侧栏底下。
 *  resize 路径还顺带守住一条覆盖竞态：v2 会在自己下次 render 里把「它记得的
 *  宽度」重新提交成内联 style，盖掉我们命令式写入的宽度（实测 --ws-chat-w 已
 *  clamp 到 344 而 aside 仍 624、body margin 跟着 624，画布被挤成 140），故
 *  apply() 必须补两拍重写；下面的「等稳态」因此判据是四重的：var==实测、宽度
 *  已在 clamp 上限内、margin>0 时右缘贴合、连续两次同值。只判同源会被 Playwright
 *  改视口与页面 resize 事件之间的间隙空过（624/624 也是「同源」）。
 *
 *  自建临时项目跑（空画布与有卡两种状态都要确定可控），结束删除。
 *  用法：node scripts/sidebar-width-reserve-test.mjs   （需 web:8008 + agent:8123 在跑）
 */
import fs from "node:fs";
import { chromium } from "playwright";

const WEB = "http://127.0.0.1:8008";
const AGENT = "http://127.0.0.1:8123";
const VIEWPORT = { width: 1600, height: 900 };

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

// 自建临时项目：空画布起步（小地图隐藏分支需要 0 节点的确定环境）
const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-layout-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建临时项目失败 ${pst}`);
const PID = proj.id ?? proj.project?.id;

// 中途抛错也要收走临时项目（抛错路径下 beforeExit 不触发，自己接住异常收尾）
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
const context = await browser.newContext({ viewport: VIEWPORT });
await context.addInitScript(
  ([key, value]) => window.localStorage.setItem(key, value),
  ["wingsight_studio_token", TOKEN],
);
const page = await context.newPage();
await page.goto(`${WEB}/project/${PID}`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

// 打开侧栏（CopilotKit 会持久化开合态，所以先探测再点关闭态入口）
const ensureOpen = async () => {
  const hidden = await page.evaluate(
    () => document.querySelector("aside.copilotKitSidebar")?.getAttribute("aria-hidden") ?? null,
  );
  if (hidden === "false") return;
  const fab = page.locator('[aria-label="打开画布助手"]');
  await fab.waitFor({ timeout: 10000 });
  await fab.click();
  await page.waitForTimeout(1200);
};
await ensureOpen();

/** 一次全量量测：侧栏 / 画布容器 / 顶栏右组 / 小地图 / 底坞出图与画风标签 / 空态身份文案 */
const measure = () =>
  page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    const flow = document.querySelector(".react-flow");
    // 顶栏右组：主题切换按钮是右组最左的一个，拿它当探针（被裁 = 左缘越过侧栏）
    const themeBtn = [...document.querySelectorAll("header button")].find((b) =>
      (b.getAttribute("aria-label") ?? "").startsWith("切换为"),
    );
    const shareBtn = [...document.querySelectorAll("header button")].find((b) =>
      b.textContent?.trim() === "分享",
    );
    const minimap = document.querySelector(".react-flow__minimap");
    // 底坞出图模型按钮：按 data-track 定位（不能按文本里的「· 2K」找——
    // 加载失败/已下架态不拼档位，用文本正则会找空而让断言空过）
    const dockBtn = document.querySelector('[data-track="dock.imagegen"]');
    const styleBtn = document.querySelector('[data-track="dock.style"]');
    const asideEl = document.querySelector("aside.copilotKitSidebar");
    return {
      aside: rect(asideEl),
      asideAriaHidden: asideEl?.getAttribute("aria-hidden"),
      bodyMarginEnd: asideEl ? getComputedStyle(document.body).marginInlineEnd : null,
      chatVar: getComputedStyle(document.documentElement).getPropertyValue("--ws-chat-w").trim(),
      flow: rect(flow),
      themeBtn: rect(themeBtn),
      shareBtn: rect(shareBtn),
      minimap: rect(minimap),
      dockLabel: dockBtn?.textContent?.trim() ?? "",
      dockTip: dockBtn?.getAttribute("data-tip") ?? "",
      styleLabel: styleBtn?.textContent?.trim() ?? "",
      styleTip: styleBtn?.getAttribute("data-tip") ?? "",
      // 空态身份说明（v2 WelcomeScreen 永不渲染，文案由我们的 suggestionView 槽给）
      welcomeLine: (asideEl?.innerText ?? "").includes("画布助手") &&
        (asideEl?.innerText ?? "").includes("说人话就行"),
      nodeCount: window.__wsCanvasStore?.getState?.().nodes.length ?? -1,
    };
  });

const m = await measure();
if (m.asideAriaHidden !== "false") throw new Error("侧栏没打开，量测无意义");

// ⓪ 默认宽度守住在 420（不传 width prop 后，v2 的 DEFAULT_SIDEBAR_WIDTH=480
//    会经它自己的 adopted stylesheet 顶上来当实际宽度——必须被内联宽度按回去）
check(
  "⓪ 无存档时默认宽度 = 420px",
  Math.abs(m.aside.width - 420) <= 1,
  `实测 ${m.aside.width.toFixed(0)}px（--ws-chat-w=${m.chatVar || "未设"}）`,
);

// ① 让位与实测同源：侧栏左缘 == 画布右缘（≤2px 容差，1px 是 border-left）
check(
  "① 默认宽度下画布右缘贴合侧栏左缘",
  m.flow && Math.abs(m.flow.right - m.aside.left) <= 2,
  `flow.right=${m.flow?.right.toFixed(0)} aside.left=${m.aside.left.toFixed(0)} bodyMarginEnd=${m.bodyMarginEnd}`,
);

// ② 顶栏右组不被裁
check(
  "② 顶栏「主题切换」完整落在侧栏左缘之左",
  m.themeBtn && m.themeBtn.right <= m.aside.left + 1,
  m.themeBtn ? `btn.right=${m.themeBtn.right.toFixed(0)}` : "找不到主题切换按钮",
);
check(
  "② 顶栏「分享」完整落在侧栏左缘之左",
  m.shareBtn && m.shareBtn.right <= m.aside.left + 1,
  m.shareBtn ? `btn.right=${m.shareBtn.right.toFixed(0)}` : "找不到分享按钮",
);

// ③ 空画布：不渲染小地图（旧行为=右下角一块无内容的米色空块，1px 描边几乎
//    看不见，像渲染故障）；底坞明写未选画风；侧栏空态有一行助手身份说明
check("③ 临时项目画布确实空（前置条件）", m.nodeCount === 0, `nodes=${m.nodeCount}`);
check(
  "③ 空画布不渲染小地图",
  m.minimap === null,
  m.minimap ? `小地图仍在：right=${m.minimap.right.toFixed(0)}` : "无小地图",
);
check(
  "③ 未选画风时底坞明写「未选画风」",
  m.styleLabel === "未选画风" && m.styleTip.includes("拦下"),
  `标签=「${m.styleLabel}」 tip=「${m.styleTip.slice(0, 24)}…」`,
);
check("③ 侧栏空态有助手身份说明", m.welcomeLine === true);
await page.screenshot({ path: "/tmp/sidebar-reserve-default.png" });
console.log("· 默认宽度（空画布）截图 /tmp/sidebar-reserve-default.png");

// ④ 底坞不吐内部模型 id（正常态：标签必须是目录展示名 + 档位）
check(
  "④ 底坞出图标签不含内部模型 id",
  m.dockLabel.length > 0 && !/(gpt-image|doubao-seedream|seedream)-[0-9a-z.\-]*/i.test(m.dockLabel),
  `标签=「${m.dockLabel}」`,
);
check(
  "④ 正常态标签带生效档位",
  /·\s*(1K|2K|4K)$/.test(m.dockLabel),
  `标签=「${m.dockLabel}」`,
);

// ④b 有卡后：小地图出现且不被侧栏吃（上一组只验了空画布分支）；
//     非预设库的自定义画风说「自定义画风」并把正文开头给到 tooltip
const putCanvas = await api(`/projects/${PID}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    nodes: [
      {
        id: "probe1",
        type: "image",
        position: { x: 0, y: 0 },
        data: { nodeType: "image", title: "探针卡", status: "ready" },
      },
    ],
    edges: [],
    viewport: { x: 460, y: 220, zoom: 0.7 },
  }),
});
if (putCanvas.status !== 200) throw new Error(`PUT canvas 失败 ${putCanvas.status}`);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await ensureOpen();
await page.evaluate(() =>
  window.__wsCanvasStore.getState().setProjectStyle("水墨写意测试画风（非预设库）"),
);
await page.waitForTimeout(400);
const c = await measure();
check("④b 装载后画布有卡（前置条件）", c.nodeCount === 1, `nodes=${c.nodeCount}`);
check(
  "④b 有卡时小地图渲染且不被侧栏吃",
  c.minimap !== null && c.minimap.right <= c.aside.left + 1,
  c.minimap ? `minimap.right=${c.minimap.right.toFixed(0)} aside.left=${c.aside.left.toFixed(0)}` : "小地图没渲染",
);
check(
  "④b 自定义画风不冒充预设名",
  c.styleLabel === "自定义画风" && c.styleTip.includes("水墨写意"),
  `标签=「${c.styleLabel}」 tip=「${c.styleTip.slice(0, 30)}…」`,
);

// ⑤ 拖宽 300px 后回灌链路仍然对齐（幅度要够大才能把顶栏右组也压进遮挡区）
const resizerBox = await page.locator(".ws-chat-resizer").boundingBox();
if (!resizerBox) throw new Error("拖宽条不可见（侧栏打开时应在）");
await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + 300);
await page.mouse.down();
await page.mouse.move(resizerBox.x + resizerBox.width / 2 - 300, resizerBox.y + 300, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(1200);

const d = await measure();
const widened = d.aside.width > m.aside.width + 240;
check("⑤ 拖宽生效（侧栏确实变宽了）", widened, `${m.aside.width.toFixed(0)} → ${d.aside.width.toFixed(0)}px`);
check(
  "⑤ body 让位 margin 跟上了实测宽度",
  Math.abs(parseFloat(d.bodyMarginEnd) - d.aside.width) <= 2,
  `marginInlineEnd=${d.bodyMarginEnd} aside.width=${d.aside.width.toFixed(0)}`,
);
check(
  "⑤ 拖宽后画布右缘仍贴合侧栏左缘",
  Math.abs(d.flow.right - d.aside.left) <= 2,
  `flow.right=${d.flow.right.toFixed(0)} aside.left=${d.aside.left.toFixed(0)} --ws-chat-w=${d.chatVar} bodyMarginEnd=${d.bodyMarginEnd}`,
);
check(
  "⑤ 拖宽后顶栏右组仍不被裁",
  d.themeBtn.right <= d.aside.left + 1 && d.shareBtn.right <= d.aside.left + 1,
  `theme.right=${d.themeBtn.right.toFixed(0)} share.right=${d.shareBtn.right.toFixed(0)}`,
);
check(
  "⑤ 拖宽后小地图仍不被吃",
  Boolean(d.minimap) && d.minimap.right <= d.aside.left + 1,
  d.minimap ? `minimap.right=${d.minimap.right.toFixed(0)}` : "小地图本应在（已有一张卡）",
);

await page.screenshot({ path: "/tmp/sidebar-reserve-wide.png" });

// ===== ⑦ 窄窗口：侧栏宽度被 clamp（装载与拖拽同口径），顶栏不折行 =====
// 陈旧存值路径：先塞一个 760px（宽窗口下拖得出来），再把窗口收到 1100 并
// reload——装载时必须 clamp，否则画布只剩 284px：顶栏「分享」竖排成两行、
// 左上工具条顶到侧栏底下（旧代码实测如此）
await page.evaluate(() => window.localStorage.setItem("wingsight_sidebar_width", "760px"));
await page.setViewportSize({ width: 1100, height: 800 });
await page.reload();
await page.waitForSelector(".react-flow__renderer");
if ((await page.evaluate(() => document.querySelector("aside.copilotKitSidebar")?.getAttribute("aria-hidden"))) !== "false") {
  await page.locator('[aria-label="打开画布助手"]').click();
}
// 稳定判据（四重）：① aside 实测宽度 == --ws-chat-w（同源）② 宽度已在
// clamp 上限内（Playwright 改视口与页面 resize 事件之间有间隙，不等就
// 会读到改前的陈旧宽度——实测 var 与 aside 都是旧的 624，单看同源会空过）
// ③ 让位开启时画布右缘贴合侧栏左缘 ④ 连续两次同值。
// 不满足别放行：超时就是硬报错，不会静默降级
const settle = async (label) => {
  try {
    await page.waitForFunction(
      () => {
        const f = document.querySelector(".react-flow__renderer");
        const a = document.querySelector("aside.copilotKitSidebar");
        if (!f || !a || a.getAttribute("aria-hidden") !== "false") return false;
        const w = Math.round(a.getBoundingClientRect().width);
        const want = Math.round(
          parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ws-chat-w")) || 0,
        );
        if (w !== want) {
          window.__settle = null;
          return false;
        }
        // 与 components/copilot/Sidebar.tsx 的 clampChatWidth 同口径：
        // 上限 = max(240, min(760, 视口 - 活动栏 56 - 画布最小可用 420))
        const upper = Math.max(240, Math.min(760, window.innerWidth - 56 - 420));
        if (w > upper + 1) {
          window.__settle = null;
          return false;
        }
        const margin = parseFloat(getComputedStyle(document.body).marginInlineEnd) || 0;
        // margin=0 是 v2 自己换了覆盖式（窄视口不挖位），此时贴合不适用
        if (margin > 0 && Math.abs(f.getBoundingClientRect().right - a.getBoundingClientRect().left) > 2) {
          window.__settle = null;
          return false;
        }
        if (window.__settle !== w) {
          window.__settle = w;
          return false;
        }
        return true;
      },
      null,
      { timeout: 9000 },
    );
  } catch (e) {
    throw new Error(`⑦ ${label}：侧栏宽度始终不稳定 — ${String(e.message).split("\n")[0]}`);
  }
};
const readNarrow = () =>
  page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const flow = document.querySelector(".react-flow__renderer");
    const aside = document.querySelector("aside.copilotKitSidebar");
    const bar = document.querySelector("[data-canvas-header]");
    const header = document.querySelector("header");
    const share = [...(header?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === "分享");
    return {
      flow: rect(flow),
      aside: rect(aside),
      asideAriaHidden: aside?.getAttribute("aria-hidden"),
      chatW: getComputedStyle(document.documentElement).getPropertyValue("--ws-chat-w").trim(),
      bodyMarginEnd: getComputedStyle(document.body).marginInlineEnd,
      kids: [...(bar?.children ?? [])].map((c) => ({ cls: c.className.slice(0, 22), ...rect(c) })),
      headerRight: Math.round(header?.getBoundingClientRect().right ?? 0),
      share: rect(share),
      kbd: bar?.querySelector("kbd")?.textContent ?? null,
    };
  });

const upper = 1100 - 56 - 420; // 活动栏 56 + 画布最小可用宽 420
await settle("装载后");
const first = await readNarrow();
if (first.asideAriaHidden !== "false") throw new Error("侧栏没打开，⑦ 量测无意义");
const canvasW = first.flow.width;
const last = first.kids[first.kids.length - 1];
console.log(`· 窄窗口：视口 1100 存值 760px → 侧栏实测 ${first.aside.width}px（--ws-chat-w=${first.chatW} margin=${first.bodyMarginEnd}），画布 ${canvasW}px，分享钮高=${first.share?.height}`);
check("⑦ 装载时陈旧存值被 clamp（侧栏≤" + upper + "px）", first.aside.width <= upper + 1, `实测侧栏=${first.aside.width}px --ws-chat-w=${first.chatW}`);
check("⑦ 画布保住最小可用宽（≥420px）", canvasW >= 420 - 1, `画布宽=${canvasW}`);
check("⑦ 顶栏「分享」单行不折行", Boolean(first.share) && first.share.height <= 32, `高=${first.share?.height}`);
check("⑦ 顶栏右组不被裁", Boolean(first.share) && first.share.right <= first.headerRight + 1, `share.right=${first.share?.right} header.right=${first.headerRight}`);
// 工具条行本身是整行宽（left-2 right-2），只看末子项（齿轮）是否还在画布内
check("⑦ 左上工具条末子项（齿轮）在画布内", Boolean(last) && last.right <= first.flow.right + 1, `末子项 right=${last?.right} flow.right=${first.flow.right}`);
check("⑦ 搜索框标出 ⌘K 入口（与导航面板同一发现路径）", first.kbd === "⌘K", `kbd=${JSON.stringify(first.kbd)}`);

// 最窄的「仍让位」态：v2 只在视口 ≳800px 时让位，更窄就改成覆盖式（实测
// 视口 760 → body margin=0，画布不被挤窄）。820 是能量到的最紧画布：
// clamp 必须把侧栏压到 344（= 820-56-420），旧 clamp 上限 760 会把画布吃到只剩几 px
await page.setViewportSize({ width: 820, height: 800 });
await settle("缩到 820 后");
const sq = await readNarrow();
const sqLast = sq.kids[sq.kids.length - 1];
const sqSearch = sq.kids.find((k) => k.cls.includes("relative"));
console.log(`· 视口 820：侧栏 ${sq.aside.width}px，画布 ${sq.flow.width}px，搜索框 ${sqSearch?.width}px，齿轮 right=${sqLast?.right} flow.right=${sq.flow.right}`);
// 同源不变量（真正的病根）：v2 会用「它记得的宽度」重新提交内联 style，抢回
// 旧宽度时 --ws-chat-w 与实测宽度就分家，画布被陈旧宽度挤没
check(
  "⑦ --ws-chat-w 与侧栏实测宽度同源",
  Math.abs((parseFloat(sq.chatW) || 0) - sq.aside.width) <= 1,
  `var=${sq.chatW} aside=${sq.aside.width}px margin=${sq.bodyMarginEnd}`,
);
check("⑦ resize 也重算上限（侧栏≤344px）", sq.aside.width <= 820 - 56 - 420 + 1, `侧栏=${sq.aside.width}px`);
check("⑦ 缩窗后画布仍 ≥400px", sq.flow.width >= 400, `画布宽=${sq.flow.width}`);
check("⑦ 缩窗后齿轮仍在画布内", Boolean(sqLast) && sqLast.right <= sq.flow.right + 1, `齿轮 right=${sqLast?.right} flow.right=${sq.flow.right}`);
check("⑦ 缩窗后搜索框不越界", Boolean(sqSearch) && sqSearch.right <= sq.flow.right + 1 && sqSearch.width <= 208, `搜索框 right=${sqSearch?.right} 宽=${sqSearch?.width}`);
check("⑦ 缩窗后顶栏「分享」仍不折行", Boolean(sq.share) && sq.share.height <= 32, `高=${sq.share?.height}`);
await page.screenshot({ path: "/tmp/sidebar-reserve-narrow.png" });

// 拖拽路径守同一个上限（不是只装载/resize 时算）：在 820 下往左猛拖
await page.evaluate(async () => {
  const r = document.querySelector(".ws-chat-resizer");
  const rr = r.getBoundingClientRect();
  const opts = { bubbles: true, pointerId: 1, isPrimary: true, button: 0 };
  r.dispatchEvent(new PointerEvent("pointerdown", { ...opts, clientX: rr.left + 5, clientY: 40 }));
  window.dispatchEvent(new PointerEvent("pointermove", { ...opts, clientX: rr.left - 900, clientY: 40 }));
  window.dispatchEvent(new PointerEvent("pointerup", { ...opts, clientX: rr.left - 900, clientY: 40 }));
});
await settle("820 下拖宽后");
const dragged = await readNarrow();
check("⑦ 拖拽也守同一上限", dragged.aside.width <= 820 - 56 - 420 + 1 && dragged.flow.width >= 400, `拖后侧栏=${dragged.aside.width}px 画布=${dragged.flow.width}px`);
await page.setViewportSize({ width: VIEWPORT.width, height: VIEWPORT.height });
await page.waitForTimeout(300);
await page.evaluate(() => window.localStorage.removeItem("wingsight_sidebar_width"));
await page.setViewportSize({ width: VIEWPORT.width, height: VIEWPORT.height });
await page.reload();
await page.waitForSelector(".react-flow__renderer");

console.log("· 拖宽后截图 /tmp/sidebar-reserve-wide.png");

// ⑥ 模型目录加载失败：底坞必须明报，不得静默回落成内部模型 id
//    （旧行为：`imageModels?.find(...)?.label ?? imagegen.model` —— 目录一挂
//    底坞就把 gpt-image-2-03 当标签甩在用户脸上，且错误/重试入口藏在弹窗里）
await page.route("**/agent-service/models/image", (r) =>
  r.fulfill({ status: 500, contentType: "application/json", body: '{"detail":"boom"}' }),
);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await ensureOpen();
const broken = await measure();
check(
  "⑥ 目录加载失败时底坞明报失败",
  broken.dockLabel.length > 0 && broken.dockLabel.includes("加载失败"),
  `标签=「${broken.dockLabel}」`,
);
check(
  "⑥ 失败态仍不吐内部模型 id",
  broken.dockLabel.length > 0 && !/(gpt-image|doubao-seedream|seedream)-[0-9a-z.\-]*/i.test(broken.dockLabel),
  `标签=「${broken.dockLabel}」`,
);
check(
  "⑥ tooltip 指出去重试的入口",
  broken.dockTip.includes("重试"),
  `tip=「${broken.dockTip}」`,
);
await page.screenshot({ path: "/tmp/sidebar-reserve-broken-catalog.png" });
console.log("· 目录失败态截图 /tmp/sidebar-reserve-broken-catalog.png");

await browser.close();
await dropProject();
const failed = results.filter(([ok]) => !ok);
console.log(
  failed.length === 0
    ? `\n✓✓ 布局/口径回归全过（${results.length} 项，临时项目已删）`
    : `\n✗ ${failed.length}/${results.length} 项未过：${failed.map((n) => n[1]).join("；")}（临时项目已删）`,
);
process.exit(failed.length === 0 ? 0 : 1);
