/**
 * E2E：拆资产之后问一次「考据年代」（era），答了要落进画布 meta。
 *
 * 背景：`set_project_era` 是 agent 工具，而调研/拆解是用户点按钮发起、不经过
 * agent——生产 23 个项目 era 全是空的，跨项目考据复用因此从未生效。此前只把
 * 询问挂在「发起批量调研」那一刻，于是「拆完资产直接出图、从不点调研」的用户
 * 永远不被问到（八仙饭店实况）。现在拆解完成也要问一次。
 *
 * 隔离：自建测试项目；拆解任务走 route mock（不跑 flow、不出图）。
 * 无浏览器钩子依赖，生产模式下也能跑；前端需在跑（8008）。
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
}

async function api(path, init) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-era-prompt-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;
console.log(`测试项目: ${pid}`);

// 剧本卡（拆解锚点）
await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    nodes: [
      {
        id: "n_sc",
        type: "script",
        position: { x: 0, y: 0 },
        data: { nodeType: "script", title: "1973 八仙饭店", body: "夜，澳门黑沙环八仙饭店。黄志恒推门而入。" },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 0.6 },
    meta: { factuality: "real", era: "" },
  }),
});

const browser = await chromium.launch();
const page = await browser.newPage();
const dialogs = [];
page.on("dialog", (d) => {
  dialogs.push(d.message());
  // 答一个年代（确定性断言：它必须落进 meta.era）
  void d.accept("1973 年香港·澳门");
});

// 拆解任务 mock：POST 起 job，GET 直接 done + 一项资产
await page.route("**/agent-service/assets/decompose", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "e2e_djob" }) }),
);
await page.route("**/agent-service/assets/decompose/e2e_djob", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      status: "done",
      phase: "done",
      assets: [
        {
          type: "character",
          name: "黄志恒",
          description: "四十余岁男子，短发，白衬衫",
          visual_notes: "灰蓝调",
        },
      ],
    }),
  }),
);

await page.goto(`${BASE}/project/${pid}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.evaluate(() => window.__wsSetViewport?.({ x: 0, y: 0, zoom: 0.6 })).catch(() => {});

// 选中剧本卡 → 工具条「拆解资产」。工具条贴左缘时前段可能被活动栏盖住
// （xyflow NodeToolbar 无水平钳制，存量现象）——用 DOM click 绕过命中测试
const btn = page.locator('button[aria-label^="用拆解技能从剧本提取"]');
if ((await btn.count()) === 0) {
  await page.locator('[data-id="n_sc"]').first().click();
  await page.waitForTimeout(600);
}
await btn.first().evaluate((el) => el.click());
await page.waitForTimeout(6000); // 拆解（mock 立即回）+ 建卡 + 弹问

check("拆解后弹出了年代询问", dialogs.some((m) => m.includes("考据归档")), dialogs.join(" | ").slice(0, 160));
check(
  "询问文案讲清用途与留空语义",
  dialogs.some((m) => m.includes("复用考据结论") && m.includes("留空")),
  dialogs[0]?.replace(/\n/g, " ").slice(0, 120) ?? "(无弹窗)",
);
check("资产卡已建出（拆解链路没被拦）", (await page.locator('[data-id="n_sc"]').count()) > 0);

// 前端保存有 1.2s debounce，等它落库
await page.waitForTimeout(3000);
const { body: canvas } = await api(`/projects/${pid}/canvas`);
check(
  "答的年代已落进画布 meta.era（跨项目复用的作用域键）",
  canvas?.meta?.era === "1973 年香港·澳门",
  `era=${JSON.stringify(canvas?.meta?.era)}`,
);
const asset = (canvas?.nodes ?? []).find((n) => n?.data?.nodeType === "character");
check("角色资产卡落在画布上", Boolean(asset), asset?.data?.title ?? "(没有)");

await browser.close();
await api(`/projects/${pid}`, { method: "DELETE" });

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? "✗" : "✅"} 拆解后年代询问 ${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
