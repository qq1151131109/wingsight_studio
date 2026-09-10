/**
 * 聊天侧改图闭环回归（2026-09-10 审计缺口的修复回归）。
 *
 * 背景：图片出图走**前端直连管线**（卡片输入条 → directImagegen，不经聊天）——
 * 所以此前 agent 在聊天里收到「改一下这张图」时手上没有等价工具：只能退化成
 * 图生图近似，或含糊地让用户自己去点输入条；而 `canvas_ops update_node` 回填
 * imageUrl 是纯覆盖、旧图不入档、无法回滚（与 revise-assets「版本档案是回滚」
 * 直接矛盾）。修复两件：
 *   1. 新增前端工具 `regenerate_card_image`（复用 directImagegen：改图语义 /
 *      版本档案 / 无谱系卡派生新卡三条语义天然与输入条同源）；
 *   2. `ops.update_node` 覆盖主图/主视频前归档旧媒体（幂等）。
 *
 * 断言（agent SSE 与出图 job 全程 route mock：不烧 LLM、不出真图）：
 *   A 聊天里说「把帽子改成斗笠」→ agent(mock) 调 regenerate_card_image
 *     A1 卡片换成新图（落库 imageUrl = 新图）  A2 旧图入版本档案（可回滚）
 *     A3 状态 ready   A4 卡上 V2 角标   A5 卡面展示新图（DOM）
 *   B 无谱系上传图卡（无 genPrompt/genShot）→ 派生新卡：源卡原图不动、无档案
 *   C 派生新卡承接结果，且与原图连线（血缘）
 *   D 未选画风 → 工具拒绝出图（画风闸不被绕过）：图为原样、无版本档案
 *
 * 前置：agent(8123) + 前端(8008) 在跑。自建临时项目，结束删除。
 * 运行：node scripts/chat-revise-image-test.mjs
 *      WS_BASE=http://127.0.0.1:8010 node scripts/...   # 指到别的前端实例
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.WS_BASE || "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const OLD1 = "/agent-service/assets/rev_old1.png";
const NEW1 = "/agent-service/assets/rev_new1.png";
const OLD2 = "/agent-service/assets/rev_old2.png";
const NEW2 = "/agent-service/assets/rev_new2.png";
const OLD3 = "/agent-service/assets/rev_old3.png";
const NEW3 = "/agent-service/assets/rev_new3.png";
const OLD4 = "/agent-service/assets/rev_old4.png";
const NEW4 = "/agent-service/assets/rev_new4.png";

const createdPids = [];

/** 建项目 + 画布夹具。styled=false 用于画风闸用例（meta 不带 visualStyle）。 */
async function makeProject(tag, nodes, styled = true) {
  const { body: proj } = await api("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `e2e-revise-image-${tag}-${Date.now() % 100000}` }),
  });
  const pid = proj.id ?? proj.project?.id;
  if (!pid) throw new Error("建项目失败：" + JSON.stringify(proj).slice(0, 300));
  createdPids.push(pid);
  await api(`/projects/${pid}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nodes,
      edges: [],
      viewport: { x: 80, y: 340, zoom: 0.55 },
      meta: styled ? { visualStyle: "测试画风：素描写实，柔和自然光" } : {},
    }),
  });
  return pid;
}

/** 读落库画布（断言以库为准，DOM 只作 UI 反映的旁证） */
async function readCanvas(pid) {
  const { body } = await api(`/projects/${pid}/canvas`);
  const nodes = typeof body?.nodes === "string" ? JSON.parse(body.nodes) : body?.nodes ?? [];
  const edges = typeof body?.edges === "string" ? JSON.parse(body.edges) : body?.edges ?? [];
  return { nodes, edges };
}
const nodeOf = (nodes, id) => nodes.find((n) => n.id === id);
const versionsOf = (n) => n?.data?.versions ?? [];

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
/** 让 mock 的 agent「调用」改图工具 */
function toolCallRun(nodeId, prompt) {
  const runId = `run-${Math.random().toString(36).slice(2, 8)}`;
  const mid = `m-${runId}`;
  const tcId = `tc-${runId}`;
  return sse([
    { type: "RUN_STARTED", threadId: "mock-thread", runId },
    { type: "TEXT_MESSAGE_START", messageId: mid, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: mid, delta: "好，我来改这张图。" },
    { type: "TEXT_MESSAGE_END", messageId: mid },
    { type: "TOOL_CALL_START", toolCallId: tcId, toolCallName: "regenerate_card_image", parentMessageId: mid },
    { type: "TOOL_CALL_ARGS", toolCallId: tcId, delta: JSON.stringify({ node_id: nodeId, prompt }) },
    { type: "TOOL_CALL_END", toolCallId: tcId },
    { type: "RUN_FINISHED", threadId: "mock-thread", runId },
  ]);
}
function textRun(text) {
  const runId = `run-${Math.random().toString(36).slice(2, 8)}`;
  const mid = `m-${runId}`;
  return sse([
    { type: "RUN_STARTED", threadId: "mock-thread", runId },
    { type: "TEXT_MESSAGE_START", messageId: mid, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: mid, delta: text },
    { type: "TEXT_MESSAGE_END", messageId: mid },
    { type: "RUN_FINISHED", threadId: "mock-thread", runId },
  ]);
}

/** 起页 + 装 mock：出图 job 返回固定新图；agent run 首轮回工具调用，其后回文本 */
async function openCase(pid, { toolNodeId, toolPrompt, newUrl }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  if (TOKEN)
    await ctx.addInitScript(
      ([k, v]) => window.localStorage.setItem(k, v),
      ["wingsight_studio_token", TOKEN],
    );
  const page = await ctx.newPage();
  let runSeq = 0;
  // 具体 job 路由后注册（Playwright 后注册优先），避免被通用 run 路由吃掉
  await page.route("**/agent-service/storyboard/images", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobId: "mock-job-1" }),
    });
  });
  await page.route("**/agent-service/storyboard/images/mock-job-1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "done", images: [{ rid: "mock-0", ok: true, imageUrl: newUrl }] }),
    });
  });
  await page.route("**/agent-service", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    runSeq += 1;
    const body = runSeq === 1 ? toolCallRun(toolNodeId, toolPrompt) : textRun("（mock）改图已提交。");
    try {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body });
    } catch {
      /* 页面侧已 abort：fulfill 落空属预期 */
    }
  });
  await page.goto(`${BASE}/project/${pid}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".react-flow__node", { timeout: 20000 });
  await page.waitForTimeout(1200);
  return { browser, page };
}

async function sendChat(page, text) {
  const hidden = await page.evaluate(
    () => document.querySelector("aside.copilotKitSidebar")?.getAttribute("aria-hidden"),
  );
  if (hidden !== "false") {
    await page.locator('[aria-label="打开画布助手"]').click();
    await page.waitForTimeout(1500);
  }
  const editor = page.locator("aside .copilotKitInputEditor").first();
  await editor.click();
  await page.keyboard.type(text, { delay: 6 });
  await page.keyboard.press("Enter");
}

/** 轮询落库：等某卡 imageUrl 变成期望值（直连管线含 2.5s 轮询节拍） */
async function waitForImage(pid, nodeId, want, timeoutMs = 45000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const { nodes } = await readCanvas(pid);
    last = nodeOf(nodes, nodeId)?.data?.imageUrl ?? null;
    if (last === want) return last;
    await sleep(1000);
  }
  return last;
}

let failed = 0;
try {
  // ============ 用例 1：有谱系卡原位改图 + 版本归档 ============
  const N1 = "n_rev_1";
  const pid1 = await makeProject("lineage", [
    {
      id: N1,
      type: "image",
      position: { x: 0, y: 0 },
      data: {
        nodeType: "image",
        title: "测试图1",
        body: "一个戴帽子的男人站在雨里",
        imageUrl: OLD1,
        genPrompt: "一个戴帽子的男人站在雨里",
        status: "ready",
      },
    },
  ]);
  const c1 = await openCase(pid1, { toolNodeId: N1, toolPrompt: "把帽子改成斗笠", newUrl: NEW1 });
  await sendChat(c1.page, "把这张图的帽子改成斗笠");
  const got1 = await waitForImage(pid1, N1, NEW1);
  check("A1 聊天说改图 → 卡片换成新图", got1 === NEW1, `imageUrl=${String(got1)}`);
  const n1 = nodeOf((await readCanvas(pid1)).nodes, N1);
  const vs1 = versionsOf(n1);
  check("A2 旧图入版本档案（可回滚）", vs1.some((v) => v.url === OLD1), `versions=${JSON.stringify(vs1.map((v) => v.url))}`);
  check("A3 卡片状态回到 ready", n1?.data?.status === "ready", `status=${String(n1?.data?.status)}`);
  const badge1 = await c1.page
    .locator(`[data-id="${N1}"] [data-tip^="版本历史"]`)
    .first()
    .innerText()
    .catch(() => "");
  check("A4 卡上出现 V2 版本角标（UI 反映归档）", badge1.trim() === "V2", `badge=${badge1.trim()}`);
  const img1 = await c1.page.locator(`[data-id="${N1}"] img[src*="rev_new1"]`).count().catch(() => 0);
  check("A5 卡面展示新图（DOM）", img1 >= 1, `img=${img1}`);
  await c1.browser.close();

  // ============ 用例 2：无谱系上传图卡 → 派生新卡、原图不动 ============
  const N2 = "n_rev_2";
  const pid2 = await makeProject("derive", [
    {
      id: N2,
      type: "image",
      position: { x: 0, y: 0 },
      data: { nodeType: "image", title: "上传图", body: "", imageUrl: OLD2, status: "ready" },
    },
  ]);
  const c2 = await openCase(pid2, { toolNodeId: N2, toolPrompt: "背景换成雨夜", newUrl: NEW2 });
  await sendChat(c2.page, "把这张图的背景换成雨夜");
  const got2 = await waitForImage(pid2, N2, NEW2, 12000).catch(() => null);
  await sleep(3000);
  const { nodes: nodes2, edges: edges2 } = await readCanvas(pid2);
  const src2 = nodeOf(nodes2, N2);
  check("B1 源卡（无谱系）原图不动", src2?.data?.imageUrl === OLD2, `imageUrl=${String(src2?.data?.imageUrl)}`);
  check("B2 源卡未产生版本档案", versionsOf(src2).length === 0, `versions=${versionsOf(src2).length}`);
  const derived2 = nodes2.filter((n) => n.id !== N2 && String(n.data?.imageUrl ?? "") === NEW2);
  check("C1 派生新卡承接结果", derived2.length === 1, `新卡=${derived2.map((n) => n.id).join(",") || "无"}`);
  const linked =
    derived2.length === 1 &&
    edges2.some((e) => e.source === N2 && e.target === derived2[0].id);
  check("C2 派生新卡与原图连线（血缘）", Boolean(linked), `edges=${edges2.length}`);
  void got2;
  await c2.browser.close();

  // ============ 用例 3：未选画风 → 工具拒绝（画风闸不被绕过） ============
  const N3 = "n_rev_3";
  const pid3 = await makeProject(
    "nostyle",
    [
      {
        id: N3,
        type: "image",
        position: { x: 0, y: 0 },
        data: {
          nodeType: "image",
          title: "测试图3",
          body: "一只猫",
          imageUrl: OLD3,
          genPrompt: "一只猫",
          status: "ready",
        },
      },
    ],
    false,
  );
  const c3 = await openCase(pid3, { toolNodeId: N3, toolPrompt: "换成一只狗", newUrl: NEW3 });
  await sendChat(c3.page, "把这张图换成一只狗");
  await sleep(12000);
  const n3 = nodeOf((await readCanvas(pid3)).nodes, N3);
  check("D1 未选画风 → 不出图（图为原样）", n3?.data?.imageUrl === OLD3, `imageUrl=${String(n3?.data?.imageUrl)}`);
  check("D2 未选画风 → 无版本档案", versionsOf(n3).length === 0, `versions=${versionsOf(n3).length}`);
  await c3.browser.close();
  // ===== 用例 4：资产卡无谱系 → 原位重出（不派生；与输入条 deriveEdit 同口径）=====
  // 资产卡/分镜卡是那张图的本体，没有 genShot/genPrompt 也原位重出（版本档案
  // 兜底）；只有**图片卡**无谱系才派生新卡。判据漏 nodeType 会把资产设定图
  // 改到一张无关新卡上、资产本尊留在旧图（review 抓到的自身不一致）。
  const N4 = "n_rev_4";
  const pid4 = await makeProject("asset", [
    {
      id: N4,
      type: "character",
      position: { x: 0, y: 0 },
      data: {
        nodeType: "character",
        title: "测试角色",
        body: "一个将军",
        imageUrl: OLD4,
        status: "ready",
      },
    },
  ]);
  const c4 = await openCase(pid4, { toolNodeId: N4, toolPrompt: "换成戎装", newUrl: NEW4 });
  await sendChat(c4.page, "把这个角色的图换成戎装");
  const got4 = await waitForImage(pid4, N4, NEW4);
  check("E1 资产卡（无谱系）原位重出", got4 === NEW4, `imageUrl=${String(got4)}`);
  const nodes4 = (await readCanvas(pid4)).nodes;
  check("E2 不派生新卡（资产卡是那张图的本体）", nodes4.length === 1, `卡数=${nodes4.length}`);
  check(
    "E3 资产卡旧图入版本档案",
    versionsOf(nodeOf(nodes4, N4)).some((v) => v.url === OLD4),
    `versions=${JSON.stringify(versionsOf(nodeOf(nodes4, N4)).map((v) => v.url))}`,
  );
  await c4.browser.close();

} catch (exc) {
  failed = 1;
  console.error("✗ 运行异常：", exc instanceof Error ? exc.message : exc);
  if (exc instanceof Error && exc.stack) console.error(exc.stack.split("\n").slice(1, 4).join("\n"));
} finally {
  for (const pid of createdPids) {
    await api(`/projects/${pid}`, { method: "DELETE" }).catch(() => undefined);
  }
}

const pass = failed === 0 && results.every((r) => r.ok);
console.log(
  `\n${pass ? "✓✓ 聊天侧改图闭环通过" : "✗ 聊天侧改图闭环未过"}（${results.filter((r) => r.ok).length}/${results.length}）`,
);
process.exit(pass ? 0 : 1);
