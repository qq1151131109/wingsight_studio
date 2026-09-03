/**
 * E2E：聊天侧整表分镜回归（generate_storyboard 工具 + 写回已有分镜表卡）。
 * 隔离：自建测试项目，种子画布 = 剧本卡 + 带 2 行占位的分镜表卡。
 *
 * 回归的是 2026-09-03 的事故链：agent 收到"拆分镜"指令后铺了 27 张独立
 * storyboard 卡且连线全失败（占位符 id 不被引用/幻觉真实 id），而画布上
 * 已有分镜表卡却在摘要里被预算丢行挤瞎、read_node 又读不到 rows。
 *
 * 断言：
 *  1) LLM 调 generate_storyboard 工具（真跑分镜 flow）且 rows 写回**已有**
 *     分镜表卡（节点 id 不变、行数 ≥5、action 非空）
 *  2) 全程没有新建 storyboard 类型节点（不再铺独立分镜卡群）
 *  3) rows 契约不丢 lighting/sound（flow 产物 → canvas_ops → 落库全程透传）
 *
 * 前置：agent(8123) + 前端(8008) 在跑。LLM 真实调用，单条约 2-4 分钟。
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
  console.log(TOKEN ? "已登录" : "未取到 token");
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const api = async (path, init = {}) => {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
  return { status: r.status, body };
};

// ---------- 造测试项目 + 种子画布 ----------
const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  body: JSON.stringify({ name: `e2e-chat-storyboard-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;
console.log(`测试项目: ${pid}`);

const SCRIPT = `《深夜食堂》片段：雨夜，老旧面馆只剩最后一桌客人。老板老周擦着杯子，少女小满推门进来，浑身湿透。她点了一碗最便宜的阳春面，老周没说话，多卧了一个蛋。电视里放着寻人启事，照片正是小满。老周的手停了一下，把面端过去，轻声说：吃完这碗，回家吧。小满的眼泪掉进汤里。窗外雨声渐大，店里的灯却亮得温柔。`;
const scriptNode = {
  id: "n_e2e_script",
  type: "script",
  position: { x: 0, y: 0 },
  data: { nodeType: "script", title: "深夜食堂", body: SCRIPT },
};
const shotlistNode = {
  id: "n_e2e_shotlist",
  type: "shotlist",
  position: { x: 460, y: 0 },
  data: {
    nodeType: "shotlist",
    title: "分镜表",
    rows: [
      { rid: "r1", action: "占位行一（待整表重写）" },
      { rid: "r2", action: "占位行二（待整表重写）" },
    ],
  },
};
{
  const r = await api(`/projects/${pid}/canvas`, {
    method: "PUT",
    body: JSON.stringify({
      nodes: [scriptNode, shotlistNode],
      edges: [{ id: "e_seed", source: "n_e2e_script", target: "n_e2e_shotlist" }],
      viewport: { x: 0, y: 0, zoom: 0.6 },
    }),
  });
  if (r.status !== 200) throw new Error(`种子画布失败 ${r.status}`);
}

// ---------- 浏览器：聊天驱动 ----------
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.addInitScript(
  ([key, value]) => window.localStorage.setItem(key, value),
  ["wingsight_studio_token", TOKEN],
);
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));
// 既有良性 404（console 会派生一条 Failed to load resource 噪音，需剔除）：
// 新项目首载 GET canvas 404（前端按空白画布处理）+ 剧本卡 script-review
// 锚点探测 404（无审查任务 = 常态）
const notFound = [];
let hasReal404 = false;
page.on("response", (r) => {
  if (r.status() !== 404) return;
  const u = r.url();
  if ((/\/canvas$/.test(u) && u.includes(pid)) || /\/script-review\?/.test(u)) return;
  hasReal404 = true;
  notFound.push(u.slice(0, 160));
});

await page.goto(`${BASE}/project/${pid}`);
await page.waitForSelector("text=画布助手", { timeout: 30_000 }).catch(() => {});
const fab = page.getByRole("button", { name: "打开画布助手" });
if (await fab.isVisible().catch(() => false)) await fab.click();
// 沉降：水合/首帧渲染安定后再打字（输入条若在打字中途被重挂载，已打文本会被清空）
await page.waitForTimeout(1500);

const input = page.locator('[data-placeholder^="问点什么"]');
if (!(await input.waitFor({ state: "visible", timeout: 15_000 }).then(() => true).catch(() => false))) {
  await page.screenshot({ path: "/tmp/chat-storyboard-fail.png" });
  throw new Error("聊天输入框未出现（截图 /tmp/chat-storyboard-fail.png）");
}
const send = page.getByRole("button", { name: /发送/ });

const dumpInputState = async (tag) => {
  const info = await page
    .evaluate(() => {
      const el = document.querySelector('[data-placeholder^="问点什么"]');
      const btn = [...document.querySelectorAll("button")].find((b) =>
        (b.getAttribute("aria-label") || "").startsWith("发送"),
      );
      return {
        text: el?.textContent ?? "",
        active: document.activeElement === el,
        btnDisabled: btn?.disabled ?? null,
      };
    })
    .catch(() => null);
  console.log(`[输入态·${tag}]`, JSON.stringify(info));
  await page.screenshot({ path: "/tmp/chat-storyboard-input.png" }).catch(() => {});
};

// 只点名工具与"写回已有分镜表卡"，不提"不要建分镜卡"——独立卡抑制是
// 系统提示的分镜路由规则，点名了就不是回归了
const MSG =
  "请调用 generate_storyboard 工具把画布上的剧本拆成整表分镜（目标 8 镜），并把返回的 rows 写回画布已有的分镜表卡。";
await input.click();
await page.keyboard.type(MSG, { delay: 20 });
// 自检：打进去的字若被重挂载清掉，重打一次（水合竞态的兜底）
const typed = await page.evaluate(
  () => document.querySelector('[data-placeholder^="问点什么"]')?.textContent ?? "",
);
if (!typed.includes("generate_storyboard")) {
  await dumpInputState("打字丢失");
  await input.click();
  await page.keyboard.type(MSG, { delay: 20 });
  await page.waitForTimeout(400);
}
await dumpInputState("发送前");
await send.click({ timeout: 300_000 });

// 分镜 flow 真跑约 1-3 分钟：轮询画布直到分镜表行数变化
let rows = null;
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 4000));
  const { body: c } = await api(`/projects/${pid}/canvas`);
  const sl = (c?.nodes ?? []).find((n) => n.id === "n_e2e_shotlist");
  const n = sl?.data?.rows?.length ?? 0;
  if (n >= 5) {
    rows = sl.data.rows;
    console.log(`分镜表已更新（${n} 行，用时 ${Math.round((Date.now() - t0) / 1000)}s）`);
    break;
  }
  if (Date.now() - t0 > 420_000) {
    console.log(`超时：分镜表行数仍是 ${n}；聊天末态：${(await page.locator("body").innerText()).slice(-400).replace(/\n+/g, " | ")}`);
    break;
  }
}

// 等本轮完全结束再断言（中途可能还在建卡/汇报）
await send.waitFor({ state: "visible", timeout: 300_000 });
await new Promise((r) => setTimeout(r, 2500));

const { body: canvas } = await api(`/projects/${pid}/canvas`);
const nodes = canvas?.nodes ?? [];
const sl = nodes.find((n) => n.id === "n_e2e_shotlist");
const finalRows = sl?.data?.rows ?? [];

check("分镜表已写回（行数 ≥5，非占位）", finalRows.length >= 5, `${finalRows.length} 行`);
check(
  "写回的是已有分镜表卡（节点 id 不变）",
  Boolean(sl) && finalRows.length > 0,
  sl ? `n_e2e_shotlist 仍在，${finalRows.length} 行` : "分镜表卡丢失",
);
const hasAction = finalRows.filter((r) => (r.action ?? "").trim()).length;
check("行画面描述非空", finalRows.length > 0 && hasAction >= Math.ceil(finalRows.length * 0.8), `${hasAction}/${finalRows.length}`);
const withFields = finalRows.filter((r) => (r.shotSize ?? "").trim() || (r.cameraMove ?? "").trim()).length;
check("景别/运镜字段落库", finalRows.length > 0 && withFields >= Math.ceil(finalRows.length * 0.6), `${withFields}/${finalRows.length}`);
const withAesthetic = finalRows.filter((r) => (r.lighting ?? "").trim() || (r.sound ?? "").trim()).length;
check("光影/音效透传不丢（ops rows 契约）", withAesthetic >= 1, `${withAesthetic}/${finalRows.length} 行带光影或音效`);
const storyboardCount = nodes.filter((n) => n.data?.nodeType === "storyboard").length;
check("没有铺独立分镜卡群", storyboardCount === 0, `${storyboardCount} 张 storyboard 卡`);
const shotlistCount = nodes.filter((n) => n.data?.nodeType === "shotlist").length;
check("没有重复建分镜表卡", shotlistCount === 1, `${shotlistCount} 张分镜表`);
const realErrors = hasReal404
  ? consoleErrors
  : consoleErrors.filter((e) => !e.startsWith("Failed to load resource"));
check(
  "页面 console 无错误",
  realErrors.length === 0 && notFound.length === 0,
  (realErrors[0] ?? notFound[0] ?? "").slice(0, 140),
);

await page.screenshot({ path: "/tmp/chat-storyboard-done.png" });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "全部通过" : `${failed.length} 项失败`}（${results.length} 项）`);
process.exit(failed.length === 0 ? 0 : 1);
