/**
 * E2E 回归：画布摘要上下文工程（summarizeCanvas，agent 的读通道）。
 *  - 媒体标记带 URL（图/视频/音频）——聊天出图工具 reference_images 的输入源
 *  - 调研卡标注卷宗 id
 *  - 超预算降级：先全省正文（不是硬切半行），连线永远保留
 * 前置：前端(8008) 在跑（纯前端逻辑，agent 只用于建项目）。
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8008";
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
  const r = await fetch(`${BASE}/agent-service${path}`, {
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

// ---------- 测试项目 + 画布 ----------
const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-summary-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;

const LONGBODY = "超长正文标记LONGBODY" + "这段正文的存在是为了把摘要顶超预算。".repeat(6);
const nodes = [
  {
    id: "sum_img",
    type: "image",
    position: { x: 0, y: 0 },
    data: { nodeType: "image", title: "镜头 02 图", imageUrl: "/agent-service/assets/e2e_sum_marker.png" },
  },
  {
    id: "sum_vid",
    type: "video",
    position: { x: 320, y: 0 },
    data: { nodeType: "video", title: "开场视频", videoUrl: "/agent-service/assets/e2e_sum_marker.mp4" },
  },
  {
    id: "sum_res",
    type: "research",
    position: { x: 640, y: 0 },
    data: { nodeType: "research", title: "卓文君调研", researchId: "e2e_research_id" },
  },
];
// 30 张长正文卡：把摘要顶超预算，验证「先全省正文」降级
for (let i = 0; i < 30; i++) {
  nodes.push({
    id: `long${i}`,
    type: "note",
    position: { x: (i % 6) * 260, y: 300 + Math.floor(i / 6) * 220 },
    data: { nodeType: "note", title: `便签${i}`, body: `${LONGBODY}${i}` },
  });
}
await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ nodes, edges: [{ id: "e1", source: "sum_img", target: "sum_vid" }], viewport: { x: 0, y: 0, zoom: 0.5 } }),
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
if (TOKEN)
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["wingsight_studio_token", TOKEN],
  );
const page = await context.newPage();
try {
  await page.goto(`${BASE}/project/${pid}`);
  await page.locator(".react-flow__node").first().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(2000);
  const summary = await page.evaluate(() =>
    window.__summarizeCanvas(["sum_img"]),
  );
  check(
    "图片卡标记带 URL",
    summary.includes("图:/agent-service/assets/e2e_sum_marker.png"),
    summary.split("\n").find((l) => l.includes("sum_img")) ?? "no line",
  );
  check("视频卡标记带 URL", summary.includes("视频:/agent-service/assets/e2e_sum_marker.mp4"));
  check("调研卡标注卷宗 id", summary.includes("（调研卷宗 e2e_research_id）"));
  check("选中标记保留", summary.includes("sum_img [选中]") || summary.includes("[选中]"));
  check("连线行保留", summary.includes("- 连线"));

  // 超预算降级：正文先全省（LONGBODY 不出现），节点行不丢、无硬切半行
  check("超预算先全省正文", !summary.includes("LONGBODY"), `len=${summary.length}`);
  check("节点行数完整（非硬切）", (summary.match(/^- /gm) ?? []).length === 34 && !summary.includes("…（已截断）"),
    `行数=${(summary.match(/^- /gm) ?? []).length}`);
  check("选中卡正文保留", summary.includes("sum_img"), "");
} catch (e) {
  console.error("执行中断：", e.message);
} finally {
  await browser.close();
  await api(`/projects/${pid}`, { method: "DELETE" }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
