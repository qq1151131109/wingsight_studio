/**
 * E2E：生成输入条 @ 内联引用（open-ai-canvas 结构化 token 范式）。
 * 隔离：自建测试项目（?pid 直达），出图任务走 route mock，不耗真实额度。
 *
 * 覆盖：@ 候选弹层 / chip 内联进正文 / @ 本卡自己（图生图自引）/ Backspace
 * 整 chip 删除 / 提交 payload 的编号契约（参考图编号：图N=《卡名》+ 数组顺序）。
 *
 * 前置：agent(8123) + 前端(8008) 在跑。
 * 运行：node scripts/mention-inline-test.mjs
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;
const pngBlue =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const pngRed =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function api(path, init) {
  const r = await fetch(`${API}${path}`, {
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
}

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

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---------- 测试项目：带图源卡 + 带图目标卡（自引场景）----------
const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-mention-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;
const save = (nodes, edges, meta) =>
  api(`/projects/${pid}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes, edges, viewport: { x: 0, y: 0, zoom: 0.8 }, ...(meta ? { meta } : {}) }),
  });
await save(
  [
    {
      id: "n_src",
      type: "image",
      position: { x: 0, y: 0 },
      data: { nodeType: "image", title: "设定图A", status: "ready", imageUrl: pngBlue },
    },
    {
      id: "n_tgt",
      type: "image",
      position: { x: 320, y: 0 },
      // genPrompt=已生成谱系卡：本测的补出/取消/refIds 持久化是原位语义
      //（上传图派生分支由 ref-pipeline §13 覆盖）
      data: { nodeType: "image", title: "目标卡", status: "ready", imageUrl: pngRed, genPrompt: "旧图快照" },
    },
    // 7 张角色卡 + 1 张场景卡：复现旧版「全局排序截 6 条」把非角色类型
    // 和本卡自己挤出候选的拥挤场景
    ...["甲", "乙", "丙", "丁", "戊", "己", "庚"].map((s, i) => ({
      id: `n_c${i}`,
      type: "character",
      position: { x: 640 + (i % 4) * 200, y: Math.floor(i / 4) * 240 },
      data: { nodeType: "character", title: `角色${s}`, status: "ready" },
    })),
    {
      id: "n_scene",
      type: "scene",
      position: { x: 640, y: 480 },
      data: { nodeType: "scene", title: "场景甲", status: "ready" },
    },
  ],
  [],
  { visualStyle: "电影感写实" },
);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.addInitScript(
  ([key, value]) => window.localStorage.setItem(key, value),
  ["wingsight_studio_token", TOKEN],
);
const page = await context.newPage();

// route mock：出图任务按 jobMode 响应（捕获提交 payload 供断言）
let genPayload = null;
let jobMode = "done"; // "done"（全部成功）| "partial"（仅第 1 张成功）| "running"（挂起）
let deleteCalled = false;
let lastShots = [];
let lastDescription = "";
await page.route(
  "**/agent-service/storyboard/images",
  async (route) => {
    if (route.request().method() === "POST") {
      genPayload = route.request().postDataJSON();
      lastShots = genPayload?.shots ?? [];
      lastDescription = String(lastShots[0]?.description ?? "");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobId: "e2e_mention_job" }),
      });
    }
    return route.fallback();
  },
);
await page.route("**/agent-service/storyboard/images/e2e_mention_job", (route) => {
  if (route.request().method() === "DELETE") {
    deleteCalled = true;
    return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  }
  const images = lastShots.map((s, i) =>
    jobMode === "partial" && i > 0
      ? { rid: s.rid, ok: false, error: "模拟：候选失败" }
      : { rid: s.rid, ok: true, imageUrl: pngBlue },
  );
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      status: jobMode === "running" ? "running" : "done",
      images: jobMode === "running" ? lastShots.map((s) => ({ rid: s.rid, ok: false })) : images,
    }),
  });
});

await page.goto(`${BASE}/project/${pid}`);
// 首访编译+水合较慢：等画布节点真的渲染出来
await page.waitForFunction(
  () => document.querySelectorAll(".react-flow__node").length >= 2,
  { timeout: 60000 },
);
await page.evaluate(() => window.__wsSetViewport?.({ x: 300, y: 300, zoom: 0.8 }));
await page.waitForTimeout(1200);

// 选中目标卡（点标题区——图心被 mediaDragProps 占用，中心点击不产生选中）
// → 浮动面板出现
const tgtBox = await page
  .locator(".react-flow__node")
  .filter({ hasText: "目标卡" })
  .first()
  .boundingBox();
await page.mouse.click(tgtBox.x + 40, tgtBox.y + 8);
await page.waitForTimeout(1000);
const editor = page.locator(".ws-detail .ws-mention-input");
check("M0 输入条为内联引用编辑器", (await editor.count()) === 1);
await editor.click();

// 自引 chip：目标卡自带图 → 面板亮「本卡原图」
check(
  "M1 本卡原图 chip（自动并入提示）",
  (await page.getByText("本卡原图", { exact: true }).count()) > 0,
);

// @ 候选 + 内联 chip
await page.keyboard.type("雨夜", { delay: 30 });
await page.keyboard.type("@设", { delay: 60 });
await page.waitForTimeout(400);
const dropdownA = page.locator("button", { hasText: "设定图A" });
check("M2 @ 触发候选弹层", (await dropdownA.count()) > 0);
if ((await dropdownA.count()) > 0) await dropdownA.first().click();
await page.waitForTimeout(300);
check(
  "M3 chip 内联进正文（token 落在光标处）",
  (await page.locator('.ws-detail .ws-mention-input .ws-mention[data-mention-id="n_src"]').count()) === 1,
);
check("M4 @ 查询词被抠掉、正文保留", (await editor.textContent()).includes("雨夜"));

// Backspace 整 chip 删除
await page.keyboard.press("Backspace");
await page.waitForTimeout(200);
check(
  "M5 Backspace 整颗 chip 删除",
  (await page.locator('.ws-detail .ws-mention-input .ws-mention[data-mention-id="n_src"]').count()) === 0,
);

// 裸 @（无查询词）：本卡自己钉顶，场景不被 7 张角色挤出（分桶轮转）
await page.keyboard.type("@", { delay: 60 });
await page.waitForTimeout(300);
const bareDd = page.locator("button", { hasText: "本卡原图" });
check("M5a 裸 @ 候选含本卡自己（钉顶）", (await bareDd.count()) > 0);
check(
  "M5b 裸 @ 候选含场景卡（不被角色挤出）",
  (await page.locator("button", { hasText: "场景甲" }).count()) > 0,
);
await page.keyboard.press("Escape");
await page.keyboard.press("Backspace"); // 抠掉裸 @，还原到「雨夜」继续后续流程
await page.waitForTimeout(200);

// 重新引用 + @ 本卡自己（includeSelf）
await page.keyboard.type("@设", { delay: 60 });
await page.waitForTimeout(300);
await page.locator("button", { hasText: "设定图A" }).first().click();
await page.keyboard.type(" 与 ", { delay: 30 });
await page.keyboard.type("@目标", { delay: 60 });
await page.waitForTimeout(300);
const selfItem = page.locator("button", { hasText: "本卡原图" });
check("M6 @ 候选含本卡自己（includeSelf）", (await selfItem.count()) > 0);
if ((await selfItem.count()) > 0) await selfItem.first().click();
await page.waitForTimeout(200);
check(
  "M7 自引 chip 落正文",
  (await page.locator('.ws-detail .ws-mention-input .ws-mention[data-mention-id="n_tgt"]').count()) === 1,
);
// 已 @ 过的卡不再进候选（token 去重）
await page.keyboard.type("@", { delay: 60 });
await page.waitForTimeout(300);
check(
  "M7b 已 @ 过的卡不再进候选",
  (await page.locator("button", { hasText: "设定图A" }).count()) === 0 &&
    (await page.locator("button", { hasText: "本卡原图" }).count()) === 0,
);
await page.keyboard.press("Escape");
await page.keyboard.press("Backspace");
await page.waitForTimeout(200);

// 提交：Ctrl+Enter → 捕获出图 payload
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(2500);
const desc = String(genPayload?.shots?.[0]?.description ?? "");
const refs = genPayload?.shots?.[0]?.referenceImages ?? [];
check(
  "M8 编号契约注入（图N=《卡名》）",
  desc.includes("参考图编号：图1=《设定图A》、图2=《目标卡》"),
  desc.slice(0, 80),
);
check("M9 正文图N 指代替换", desc.includes("雨夜图1 与 图2"), desc.slice(0, 100));
check(
  "M10 参考图数组顺序=编号序（@图优先，self 已 @ 不重复首位）",
  refs.length === 2 && refs[0] === pngBlue && refs[1] === pngRed,
  JSON.stringify(refs).slice(0, 100),
);

// 生成结果回填 + refIds 持久化（画布光环数据源）
await page.waitForTimeout(1500);
const { body: canvas } = await api(`/projects/${pid}/canvas`);
const tgt = (canvas?.nodes ?? []).find((n) => n.id === "n_tgt");
check(
  "M11 生成后 refIds 持久化（@引用光环）",
  JSON.stringify(tgt?.data?.refIds ?? []) === JSON.stringify(["n_src", "n_tgt"]),
  JSON.stringify(tgt?.data?.refIds),
);
const tgtNode = page.locator(".react-flow__node").filter({ hasText: "目标卡" }).first();

// ---- M12-M14：候选部分失败 → 补出（沿用入参快照） ----
jobMode = "partial";
await editor.click();
await page.locator("button", { hasText: "2 张" }).first().click();
await page.keyboard.type("，夜色深沉");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(3500); // 轮询间隔 2.5s
const bu = tgtNode.locator("button", { hasText: "补出 1 张" });
check("M12 部分失败亮出「补出 1 张」", (await bu.count()) === 1);
const m12Desc = genPayload?.shots?.[0]?.description ?? ""; // 补出前的最后一次提交
jobMode = "done";
await bu.first().click();
await page.waitForTimeout(3500);
check(
  "M13 补出成功追加候选（按钮消失）",
  (await tgtNode.locator("button", { hasText: "补出" }).count()) === 0,
);
check(
  "M14 补出沿用原入参快照（description 一致）",
  genPayload?.shots?.[0]?.description === m12Desc,
);

// ---- M15-M17：生成中取消 ----
jobMode = "running";
await editor.click();
await page.keyboard.type("再来一版");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(1000);
const cancelBtn = tgtNode.locator("button", { hasText: "取消" });
check("M15 生成中出现取消按钮", (await cancelBtn.count()) >= 1);
await cancelBtn.first().click();
await page.waitForTimeout(600);
check("M16 取消请求已发（DELETE）", deleteCalled);
check("M17 取消后卡回 ready（取消按钮消失）", (await tgtNode.locator("button", { hasText: "取消" }).count()) === 0);

// ---- M18-M19：聊天侧栏 @ 内联 chip（与画布面板同款 MentionInput）----
const chatBtn = page.locator("button").filter({ hasText: /助手/ }).first();
if (await chatBtn.count()) await chatBtn.click();
await page.waitForTimeout(1500);
const chatEd = page.locator(".copilotKitSidebar .ws-mention-input").first();
check("M18 聊天侧也挂内联引用编辑器", (await chatEd.count()) >= 1);
if ((await chatEd.count()) >= 1) {
  await chatEd.click();
  await page.keyboard.type("@甲", { delay: 60 });
  await page.waitForTimeout(400);
  await page
    .locator(".copilotKitSidebar button")
    .filter({ hasText: "角色甲" })
    .first()
    .click();
  await page.waitForTimeout(300);
  check(
    "M19 聊天侧 chip 内联进正文",
    (await chatEd.locator('.ws-mention[data-mention-id="n_c0"]').count()) === 1,
  );
  // 不真发送（会消耗 LLM）；draft 不持久化，刷新即清
}

await browser.close();
await api(`/projects/${pid}`, { method: "DELETE" });
const fails = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} 通过`);
process.exit(fails ? 1 : 0);
