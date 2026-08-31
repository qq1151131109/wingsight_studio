/**
 * E2E：分镜表卡批量出图断点恢复 + 批次聚合/补缺图 + 一键成片。
 * 隔离：自建测试项目（?pid= 直达），不碰用户画布。
 * 出图断点恢复用 route mock（不消耗真实出图额度）；成片走真实 ffmpeg。
 *
 * 前置：agent(8123) + 前端(8002) 在跑；本机有 ffmpeg。
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8002";
const API = `${BASE}/agent-service`;
const png1px =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function api(path, init) {
  const r = await fetch(`${API}${path}`, init);
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---------- 造测试项目 + 三轮画布数据 ----------
const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-shotlist-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}: ${JSON.stringify(proj)}`);
const pid = proj.id ?? proj.project?.id;
console.log(`测试项目: ${pid}`);

const save = (nodes, edges) =>
  api(`/projects/${pid}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes, edges, viewport: { x: 0, y: 0, zoom: 0.6 } }),
  });

const imgNode = (id, st, extra = {}) => ({
  id,
  type: "image",
  position: { x: 1100, y: 0 },
  data: { nodeType: "image", title: id, status: st, ...extra },
});

// A/B 共用：剧本 + 分镜表骨架
const scriptNode = {
  id: "n_e2e_script",
  type: "script",
  position: { x: 0, y: 0 },
  data: { nodeType: "script", title: "测试剧本", body: "雨夜茶馆，侦探老陈对着名单抽烟。" },
};

// ---------- Part A：断点恢复（route mock）+ 聚合 + 补缺图 ----------
const rowsA = [
  { rid: "r1", action: "镜头一：老陈抬头", finalPrompt: "老陈特写，烟气缭绕", imageNodeId: "n_e2e_imgA" },
  { rid: "r2", action: "镜头二：少女推门", imageNodeId: "n_e2e_imgB" },
  { rid: "r3", action: "镜头三：掌柜擦碗" },
  { rid: "r4", action: "镜头四：雨夜街景", finalPrompt: "雨夜街道空镜", imageNodeId: "n_e2e_imgC" },
  { rid: "r5", action: "镜头五：钥匙特写", imageNodeId: "n_e2e_imgD" },
];
await save(
  [
    scriptNode,
    {
      id: "n_e2e_sl",
      type: "shotlist",
      position: { x: 300, y: 0 },
      data: { nodeType: "shotlist", title: "分镜表", rows: rowsA, imageJobId: "e2e_job_ok", status: "ready" },
    },
    imgNode("n_e2e_imgA", "loading"),
    imgNode("n_e2e_imgB", "loading"),
    imgNode("n_e2e_imgC", "ready", { imageUrl: png1px }),
    imgNode("n_e2e_imgD", "error", { errorMessage: "额度不足" }),
  ],
  [
    { id: "e1", source: "n_e2e_script", target: "n_e2e_sl" },
    { id: "e2", source: "n_e2e_sl", target: "n_e2e_imgA" },
    { id: "e3", source: "n_e2e_sl", target: "n_e2e_imgB" },
  ],
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

// route mock：前两次 running，之后 done（一张成功一张失败）
let jobCalls = 0;
await page.route("**/agent-service/storyboard/images/e2e_job_ok", (route) => {
  jobCalls++;
  const body =
    jobCalls <= 2
      ? { status: "running", images: [] }
      : {
          status: "done",
          images: [
            { rid: "r1", ok: true, imageUrl: png1px },
            { rid: "r2", ok: false, error: "模拟：内容审核未过" },
          ],
        };
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
});

await page.goto(`${BASE}/project/${pid}`);
await page.waitForTimeout(1500);
// 视口摆回原点，保证目标卡在 onlyRenderVisibleElements 视野内
await page.evaluate(() => window.__wsSetViewport?.({ x: 0, y: 0, zoom: 0.6 }));
await page.waitForTimeout(9000); // 等 mock 轮询（2.5s 间隔）跑完

const stats = await page.locator("text=/已出图 \\d/").first().textContent().catch(() => "");
check("A1 批次聚合条", /已出图 2/.test(stats ?? "") && /失败 2/.test(stats ?? ""), `文案:「${stats}」`);
check("A2 恢复轮询真的发生", jobCalls >= 2, `mock 被调 ${jobCalls} 次`);

const queuing = await page.getByRole("button", { name: /出图中/ }).count();
check("A3 恢复后出图按钮回到可点态", queuing === 0);

const buque = await page.getByRole("button", { name: /补缺图·(\d+)/ }).first();
const buqueText = await buque.textContent().catch(() => "");
check("A4 补缺图按钮计数=3（r2失败/r3无卡/r5失败）", /补缺图·3/.test(buqueText ?? ""), `文案:「${buqueText}」`);

// r2 行缩略图应显示错误态（title 带出图失败原因）
const r2err = await page
  .locator('button[title*="模拟：内容审核未过"]')
  .count();
check("A5 失败镜缩略图带错误原因", r2err >= 1);

await page.waitForTimeout(2500); // 等 debounce 落库
const { body: canvasA } = await api(`/projects/${pid}/canvas`);
const slA = (canvasA?.nodes ?? []).find((n) => n.id === "n_e2e_sl");
check("A6 收尾后 imageJobId 已清", !slA?.data?.imageJobId, `imageJobId=${slA?.data?.imageJobId}`);

// ---------- Part B：gone 路径（agent 无此任务 → 404） ----------
const rowsB = [
  { rid: "b1", action: "镜头一：门缝里的光", imageNodeId: "n_e2e_imgE" },
  { rid: "b2", action: "镜头二：老陈起身", imageNodeId: "n_e2e_imgF" },
];
await save(
  [
    scriptNode,
    {
      id: "n_e2e_sl",
      type: "shotlist",
      position: { x: 300, y: 0 },
      data: { nodeType: "shotlist", title: "分镜表", rows: rowsB, imageJobId: "e2e_job_dead", status: "ready" },
    },
    imgNode("n_e2e_imgE", "loading"),
    imgNode("n_e2e_imgF", "loading"),
  ],
  [{ id: "e1", source: "n_e2e_script", target: "n_e2e_sl" }],
);

await page.unrouteAll({ behavior: "ignoreErrors" });
await page.goto(`${BASE}/project/${pid}`);
await page.waitForTimeout(1500);
await page.evaluate(() => window.__wsSetViewport?.({ x: 0, y: 0, zoom: 0.6 }));
await page.waitForTimeout(6000);

const goneMsg = await page
  .locator("text=/出图任务已失效/")
  .first()
  .textContent()
  .catch(() => "");
check("B1 gone 路径提示任务失效", (goneMsg ?? "").includes("出图任务已失效"));
const deadErrors = await page.locator('button[title*="agent 重启"]').count();
check("B2 loading 图卡被置败", deadErrors >= 2, `${deadErrors} 张错误缩略图`);
await page.waitForTimeout(2500);
const { body: canvasB } = await api(`/projects/${pid}/canvas`);
const slB = (canvasB?.nodes ?? []).find((n) => n.id === "n_e2e_sl");
check("B3 gone 后 imageJobId 已清", !slB?.data?.imageJobId);

// ---------- Part C：一键成片（真实 ffmpeg） ----------
for (const n of ["v1", "v2"]) {
  execSync(
    `ffmpeg -y -loglevel error -f lavfi -i testsrc=duration=1:size=320x180:rate=10 /tmp/e2e_${n}.mp4`,
  );
  const buf = readFileSync(`/tmp/e2e_${n}.mp4`);
  const up = await api(`/assets?name=e2e_${n}.mp4`, {
    method: "POST",
    headers: { "Content-Type": "video/mp4" },
    body: buf,
  });
  if (up.status !== 200) throw new Error(`上传 ${n} 失败: ${JSON.stringify(up.body)}`);
  globalThis[`url_${n}`] = up.body.url;
}
console.log(`视频: ${globalThis.url_v1} | ${globalThis.url_v2}`);

const rowsC = [
  { rid: "c1", action: "镜头一：推门" },
  { rid: "c2", action: "镜头二：落座" },
];
await save(
  [
    scriptNode,
    {
      id: "n_e2e_sl",
      type: "shotlist",
      position: { x: 300, y: 0 },
      data: { nodeType: "shotlist", title: "分镜表", rows: rowsC, status: "ready" },
    },
    {
      id: "n_e2e_v1",
      type: "video",
      position: { x: 1250, y: 0 },
      data: { nodeType: "video", title: "镜头 01 视频", videoUrl: globalThis.url_v1, status: "ready" },
    },
    {
      id: "n_e2e_v2",
      type: "video",
      position: { x: 1250, y: 380 },
      data: { nodeType: "video", title: "镜头 02 视频", videoUrl: globalThis.url_v2, status: "ready" },
    },
  ],
  [
    // 故意一正一反两个方向，验证双向都能收进来
    { id: "e1", source: "n_e2e_sl", target: "n_e2e_v1" },
    { id: "e2", source: "n_e2e_v2", target: "n_e2e_sl" },
  ],
);

await page.goto(`${BASE}/project/${pid}`);
await page.waitForTimeout(1500);
await page.evaluate(() => window.__wsSetViewport?.({ x: 0, y: 0, zoom: 0.5 }));
await page.waitForTimeout(1500);

const composeBtn = page.getByRole("button", { name: /成片/ }).first();
const disabled = await composeBtn.isDisabled().catch(() => true);
check("C1 两段视频就位后成片按钮可点", !disabled);
await composeBtn.click();
await page.waitForTimeout(15000); // ffmpeg 拼接

const { body: canvasC } = await api(`/projects/${pid}/canvas`);
const compose = (canvasC?.nodes ?? []).find((n) => n?.data?.nodeType === "compose");
check("C2 成片卡已建", Boolean(compose));
const itemIds = compose?.data?.itemIds ?? [];
check(
  "C3 镜头序=画布从左到右（v1 前 v2 后）",
  itemIds[0] === "n_e2e_v1" && itemIds[1] === "n_e2e_v2",
  `itemIds=${JSON.stringify(itemIds)}`,
);
check("C4 产物视频已写回成片卡", Boolean(compose?.data?.videoUrl), `${compose?.data?.videoUrl ?? ""}`);
const edgesC = canvasC?.edges ?? [];
check(
  "C5 两段视频已连线进成片卡",
  edgesC.some((e) => e.source === "n_e2e_v1" && e.target === compose?.id) &&
    edgesC.some((e) => e.source === "n_e2e_v2" && e.target === compose?.id),
);

await browser.close();

// 自清理：删除测试项目（上传的 assets 文件为随机名运行时产物，留着无害）
await api(`/projects/${pid}`, { method: "DELETE" });

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  console.log("失败项:", failed.map((f) => f.name).join("；"));
  process.exit(1);
}
