/**
 * E2E：分镜行→资产引用解析与出图软闸。
 * 锁三个通道（lib/canvas/shotRefs.ts）：① 结构化 refIds ② 行内 @名称
 * ③ 全名兜底（无 @ 的完整资产标题，ai-moive-studio 按名解析范式）——
 * 分镜先于资产生成时行文本天然含资产名，出图时活解析自动挂参考。
 * 另锁软闸文案点名具体镜头（镜N）与参考图穿线（referenceImages/labels、
 * 资产→镜头图连线）。出图任务走 route mock，不消耗真实额度。
 * 前置：agent(8123) + 前端(8008) 在跑。
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;
const png1px =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-shotref-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;

const CHAR_IMG = "/agent-service/assets/e2e_char_ref.png";
const PROP_IMG = "/agent-service/assets/e2e_prop_ref.png";
await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    nodes: [
      {
        id: "ref_char", type: "character", position: { x: 0, y: 0 },
        data: { nodeType: "character", title: "侲子领首者", body: "少年侲队领首", imageUrl: CHAR_IMG, status: "ready" },
      },
      {
        id: "ref_prop", type: "prop", position: { x: 420, y: 0 },
        data: { nodeType: "prop", title: "火炬", body: "燃烧的火把", imageUrl: PROP_IMG, status: "ready" },
      },
      {
        id: "ref_shotlist", type: "shotlist", position: { x: 900, y: 0 },
        data: {
          nodeType: "shotlist",
          title: "整场戏的镜头清单",
          rows: [
            // 全名兜底档：无 @，正文含完整资产标题
            { rid: "r1", shotSize: "特写", action: "侲子领首者猛然仰头奋力呐喊" },
            // @名称 档
            { rid: "r2", shotSize: "全景", action: "@火炬 划出弧线" },
            // 无引用（合法空镜）
            { rid: "r3", shotSize: "远景", action: "夜色渐深宫灯次第亮起" },
          ],
        },
      },
    ],
    edges: [],
    viewport: { x: 40, y: 40, zoom: 0.8 },
  }),
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 2400, height: 1100 } });
if (TOKEN)
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["wingsight_studio_token", TOKEN],
  );
const page = await context.newPage();

// 软闸 confirm：收集弹窗文案并接受（继续出图）
const dialogs = [];
page.on("dialog", async (d) => {
  dialogs.push(d.message());
  await d.accept();
});

// 出图任务 mock：捕获请求体（referenceImages/labels 穿线断言用）
let imageReq = null;
await page.route("**/agent-service/storyboard/images", (route) => {
  if (route.request().method() === "POST") {
    imageReq = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "e2e_ref_job" }) });
  }
  return route.continue();
});
await page.route("**/agent-service/storyboard/images/e2e_ref_job", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      status: "done",
      images: [
        { rid: "r1", ok: true, imageUrl: png1px },
        { rid: "r2", ok: true, imageUrl: png1px },
        { rid: "r3", ok: true, imageUrl: png1px },
      ],
    }),
  }),
);

await page.goto(`${BASE}/project/${pid}`);
await page.locator("text=整场戏的镜头清单").first().waitFor({ timeout: 15000 });
// 画风闸前置：全局画风直接写 store
await page.evaluate(() => window.__wsCanvasStore?.setState({ projectStyle: "测试画风" }));

// 选中分镜表卡（点头部防误触行内编辑；顶部悬浮工具条会拦指针，若超时改走 store 选中）
const shotNode = page
  .locator(".react-flow__node")
  .filter({ hasText: "整场戏的镜头清单" })
  .first();
await shotNode.click({ position: { x: 200, y: 60 }, timeout: 5000 }).catch(() => {});
await page.waitForTimeout(300);

// 出图按钮的可访问名是 aria-label（勾选行批量出图…），不是可见文本「出图·N 镜」
const genBtn = page.getByRole("button", { name: /勾选行批量出图/ }).first();
await genBtn.click();
await page.waitForTimeout(1500);

// 1) 软闸点名：只有镜3 无参考
check(
  "A1 软闸点名缺参考镜头（镜3）",
  dialogs.length > 0 && /镜3/.test(dialogs[0]) && !/镜1/.test(dialogs[0]) && !/镜2/.test(dialogs[0]),
  dialogs[0]?.slice(0, 60) ?? "（无弹窗）",
);
check("A2 文案含行内 @ 引导", /@资产名/.test(dialogs[0] ?? ""), dialogs[0]?.slice(0, 60));

// 2) 参考图穿线：r1 全名兜底命中角色、r2 @ 命中道具、r3 空
await page.waitForTimeout(2500);
const shots = imageReq?.shots ?? [];
const byRid = Object.fromEntries(shots.map((s) => [s.rid, s]));
check(
  "B1 r1 全名兜底命中角色定妆照",
  (byRid.r1?.referenceImages ?? []).includes(CHAR_IMG),
  JSON.stringify(byRid.r1?.referenceImages),
);
check(
  "B2 r1 参考职责标签正确",
  JSON.stringify(byRid.r1?.referenceLabels ?? []).includes("侲子领首者"),
  JSON.stringify(byRid.r1?.referenceLabels),
);
check(
  "B3 r2 @名称命中道具设定图",
  (byRid.r2?.referenceImages ?? []).includes(PROP_IMG),
  JSON.stringify(byRid.r2?.referenceImages),
);
check(
  "B4 r3 空镜无参考仍可出图",
  (byRid.r3?.referenceImages ?? []).length === 0,
  JSON.stringify(byRid.r3?.referenceImages),
);

// 3) 参考落卡：镜头图卡带「资产→镜头图」连线（open-ai-canvas 范式）
await page.waitForTimeout(2500);
const graph = await page.evaluate(() => {
  const s = window.__wsCanvasStore.getState();
  const imgNodes = s.nodes.filter((n) => n.data.nodeType === "image");
  return {
    imgCount: imgNodes.length,
    edges: s.edges.filter((e) =>
      ["ref_char", "ref_prop"].includes(e.source) &&
      imgNodes.some((n) => n.id === e.target),
    ).length,
  };
});
check("C1 镜头图卡已物化（3 张）", graph.imgCount === 3, `图卡=${graph.imgCount}`);
check("C2 资产→镜头图连线建立", graph.edges >= 2, `连线=${graph.edges}`);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
await api(`/projects/${pid}`, { method: "DELETE" });
if (failed.length > 0) process.exit(1);
