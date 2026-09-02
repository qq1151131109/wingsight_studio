/**
 * E2E：分镜表「调研参考图」跨卸载续链回归。
 * onlyRenderVisibleElements 会把移出视口的节点卸载——批量调研进行中平移画布，
 * 旧实现进度/终态面板全在组件内 state，卡片一卸载就"按钮复原、无报错、面板
 * 永不弹"。现任务锚在卡数据 refBatchJobId 上：卸载重挂后恢复进度、终态照弹审阅。
 * 全程 route mock（不消耗搜索配额）；自建测试项目，跑完即删。
 *
 * 前置：agent(8123) + 前端(8008) 在跑。
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;

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
  if (!TOKEN) throw new Error("未取到 token（AUTH_ENABLED=true 需要有效 AUTH_PASSWORD）");
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 造测试项目：分镜表 + 两张资产卡 ----------
const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-refbatch-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}: ${JSON.stringify(proj)}`);
const pid = proj.id ?? proj.project?.id;
console.log(`测试项目: ${pid}`);

const asset = (id, title, y) => ({
  id,
  type: "character",
  position: { x: -550, y },
  data: {
    nodeType: "character",
    title,
    body: `${title}的设定正文（供调研出词）`,
    assetSource: "n_e2e_sl",
  },
});
await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    nodes: [
      asset("n_e2e_a1", "青铜爵", 0),
      asset("n_e2e_a2", "玉璋", 260),
      {
        id: "n_e2e_sl",
        type: "shotlist",
        position: { x: 300, y: 0 },
        data: { nodeType: "shotlist", title: "分镜表", body: "测试正文（供出图来源）", rows: [] },
      },
    ],
    edges: [],
    viewport: { x: 600, y: 350, zoom: 1 },
  }),
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.addInitScript(
  ([key, value]) => window.localStorage.setItem(key, value),
  ["wingsight_studio_token", TOKEN],
);
const page = await context.newPage();

// route mock：POST 发批 → 固定 batchId；GET 状态 = 首查起 4s 内 running，之后 done
await page.route("**/agent-service/projects/*/refs/batch-research", (route) => {
  if (route.request().method() !== "POST") return route.fallback();
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ batchId: "e2e_ref_batch" }),
  });
});
let firstPollAt = 0;
let pollCount = 0;
await page.route("**/agent-service/projects/*/refs/batch-research/e2e_ref_batch", (route) => {
  pollCount++;
  if (!firstPollAt) firstPollAt = Date.now();
  const running = Date.now() - firstPollAt < 7000;
  const item = (nodeId, name, status = "done") => ({ nodeId, name, status, error: "" });
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(
      running
        ? { batchId: "e2e_ref_batch", status: "running", total: 2, done: 1, current: "玉璋", items: [item("n_e2e_a1", "青铜爵", "running")] }
        : {
            batchId: "e2e_ref_batch",
            status: "done",
            total: 2,
            done: 2,
            current: "",
            items: [item("n_e2e_a1", "青铜爵"), item("n_e2e_a2", "玉璋")],
          },
    ),
  });
});
await page.route("**/agent-service/projects/*/refs/candidate-summary", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([
      { nodeId: "n_e2e_a1", total: 5, adopted: 0, recommended: 2 },
      { nodeId: "n_e2e_a2", total: 3, adopted: 0, recommended: 1 },
    ]),
  }),
);
await page.route("**/agent-service/projects/*/refs/candidates**", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(
      ["qa", "qb"].map((q, i) => ({
        id: `${new URL(route.request().url()).searchParams.get("nodeId")}-c${i}`,
        nodeId: new URL(route.request().url()).searchParams.get("nodeId"),
        query: q,
        provider: "google",
        title: `考据图 ${i + 1}`,
        pageUrl: "https://example.com/page",
        sourceDomain: "example.com",
        sourceUrl: "https://example.com/img.jpg",
        assetUrl: "/agent-service/assets/e2e-mock.jpg",
        width: 800,
        height: 600,
        adopted: false,
        recommended: i === 0,
        recReason: "形制吻合",
        createdAt: new Date().toISOString(),
      })),
    ),
  }),
);

await page.goto(`${BASE}/project/${pid}`);
await page.waitForSelector(".react-flow__node", { timeout: 15000 });

const setVp = (vp) =>
  page.evaluate((v) => window.__wsSetViewport?.(v), vp);
const slNode = () =>
  page.locator(".react-flow__node").filter({ hasText: "分镜表" });
const researchBtn = () =>
  slNode().getByRole("button", { name: "批量调研参考图" });
const waitNodeText = (nodeText, text, timeout = 8000) =>
  page
    .locator(".react-flow__node")
    .filter({ hasText: nodeText })
    .getByText(text)
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);

await setVp({ x: 600, y: 350, zoom: 1 });
await sleep(600);
await researchBtn().waitFor({ state: "visible", timeout: 10000 });

// 1) 点击直接开跑（无确认弹窗），锚写进卡数据，按钮进调研中
await researchBtn().click();
await page.waitForFunction(
  () =>
    window.__wsCanvasStore?.getState().nodes.find((n) => n.id === "n_e2e_sl")?.data
      .refBatchJobId === "e2e_ref_batch",
  { timeout: 8000 },
);
check("1 发起后任务锚写进卡数据", true);
await page.waitForFunction(() => {
  const btn = [...document.querySelectorAll(".react-flow__node")]
    .flatMap((n) => [...n.querySelectorAll("button")])
    .find((b) => b.getAttribute("aria-label") === "批量调研参考图");
  return btn && /调研中/.test(btn.textContent ?? "");
}, { timeout: 8000 });
check("2 按钮显示调研中进度", true, "（首查即出 running）");

// 1.5) 资产卡同步亮「调研中」（running 集合来自批量轮询 items）
const a1Running = await waitNodeText("青铜爵", "参考图调研中…", 8000);
check("2.5 资产卡亮调研中状态", a1Running);

// 2) 平移把分镜表卡甩出视口 → RF 卸载该卡
await setVp({ x: -3200, y: 350, zoom: 1 });
await sleep(900);
check(
  "3 卡片移出视口被卸载",
  (await slNode().count()) === 0,
  `残余=${await slNode().count()}`,
);
await sleep(2500); // 旧实现的孤儿轮询此刻仍会跑，但按钮状态已随组件蒸发

// 3) 平移回来 → 重挂载，凭锚恢复进度
await setVp({ x: 600, y: 350, zoom: 1 });
await slNode().waitFor({ state: "visible", timeout: 10000 });
const resumed = await page.waitForFunction(() => {
  const btn = [...document.querySelectorAll(".react-flow__node")]
    .flatMap((n) => [...n.querySelectorAll("button")])
    .find((b) => b.getAttribute("aria-label") === "批量调研参考图");
  return btn && /调研中/.test(btn.textContent ?? "");
}, { timeout: 8000 })
  .then(() => true)
  .catch(() => false);
check("4 重挂载后恢复调研中（核心回归）", resumed);
const btnText = await researchBtn().textContent().catch(() => "");
console.log(`   重挂载后按钮: ${btnText?.trim()}`);

// 4) 后端到终态 → 自动弹审阅面板、锚清掉
await page.getByText("调研结果审阅").waitFor({ state: "visible", timeout: 15000 });
check("5 终态自动弹审阅面板", true);
const anchorGone = await page.waitForFunction(
  () =>
    window.__wsCanvasStore?.getState().nodes.find((n) => n.id === "n_e2e_sl")?.data
      .refBatchJobId === undefined,
  { timeout: 5000 },
)
  .then(() => true)
  .catch(() => false);
check("6 收尾后锚已清（重开不复活）", anchorGone);

// 5.5) 终态后汇总刷新：资产卡亮「N 张参考候选待选」徽标（点开即找参考图面板）
const badge = await waitNodeText("青铜爵", "5 张参考候选待选", 10000);
check("7 资产卡亮候选待选徽标", badge);
const runningGone = await page
  .getByText("参考图调研中…")
  .waitFor({ state: "hidden", timeout: 5000 })
  .then(() => true)
  .catch(() => false);
check("8 调研中状态随终态熄灭", runningGone);

await browser.close();

// 自清理
await api(`/projects/${pid}`, { method: "DELETE" });

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  console.log("失败项:", failed.map((f) => f.name).join("；"));
  process.exit(1);
}
