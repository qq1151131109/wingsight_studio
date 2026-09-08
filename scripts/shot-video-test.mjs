/**
 * E2E：分镜行→图生视频落卡全链（mock 出视频，不消耗视频额度）。
 * 隔离：自建测试项目（?pid= 直达），结束自删，不碰用户画布。
 *
 * A 组：批量出视频——图卡正下方建视频卡（首帧血缘连线）+ 分镜表→视频卡连线
 *       （一键成片按连线收集）+ 行 videoNodeId 回填 + videoJobId 收尾即清
 * B 组：断点恢复——videoJobId 还在卡上时挂载续轮询收尾（视频卡 loading→ready）
 * C 组（REAL=1）：真跑 1 条 cogvideox-flash（免费档）走 API 全链
 *
 * 前置：agent(8123) + 前端(8008) 在跑；C 组需 BIGMODEL_API_KEY。
 */
import { execSync } from "node:child_process";
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
  console.log(TOKEN ? "已登录（AUTH_ENABLED=true）" : "未取到 token（auth 关闭，按匿名跑）");
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---------- 造项目 + 分镜数据 ----------
const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-shotvideo-${Date.now()}` }),
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

// fixture 视频（真实 mp4 上传成资产，mock job 的 videoUrl 指向它）
execSync(
  `ffmpeg -y -loglevel error -f lavfi -i testsrc=duration=1:size=320x180:rate=10 /tmp/e2e_vfx.mp4`,
);
const fxUp = await api(`/assets?name=e2e_vfx.mp4`, {
  method: "POST",
  headers: { "Content-Type": "video/mp4" },
  body: readFileSync(`/tmp/e2e_vfx.mp4`),
});
const FIXTURE_VIDEO = fxUp.body?.url ?? "";
if (!FIXTURE_VIDEO) throw new Error(`fixture 视频上传失败: ${JSON.stringify(fxUp.body)}`);

const imgNode = (id, st = "ready") => ({
  id,
  type: "image",
  position: { x: 800, y: 0 },
  data: { nodeType: "image", title: id, status: st, ...(st === "ready" ? { imageUrl: png1px } : {}) },
});

const rowsA = [
  { rid: "r1", action: "老陈抬头", cameraMove: "缓慢推进", imageNodeId: "n_img1" },
  { rid: "r2", action: "少女推门", cameraMove: "跟拍", imageNodeId: "n_img2" },
  { rid: "r3", action: "掌柜擦碗（无图）" },
];
await save(
  [
    {
      id: "n_script",
      type: "script",
      position: { x: 0, y: 0 },
      data: { nodeType: "script", title: "测试剧本", body: "雨夜茶馆。" },
    },
    {
      id: "n_sl",
      type: "shotlist",
      position: { x: 300, y: 0 },
      data: { nodeType: "shotlist", title: "分镜表", rows: rowsA, status: "ready" },
    },
    imgNode("n_img1"),
    imgNode("n_img2"),
  ],
  [
    { id: "e_s", source: "n_script", target: "n_sl" },
    { id: "e_i1", source: "n_sl", target: "n_img1" },
    { id: "e_i2", source: "n_sl", target: "n_img2" },
  ],
);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.addInitScript(
  ([key, value]) => window.localStorage.setItem(key, value),
  ["wingsight_studio_token", TOKEN],
);
const page = await context.newPage();

// ---------- A 组：批量出视频（mock job：两轮 running 后 done，2 成 1 败） ----------
let jobCalls = 0;
await page.route("**/agent-service/storyboard/videos", (route) => {
  if (route.request().method() === "POST") {
    const body = route.request().postDataJSON();
    // 可出视频行 = 有 ready 图卡的 r1/r2（r3 无图卡不带）
    const okRows = (body.shots ?? []).filter((s) => ["r1", "r2"].includes(s.rid));
    if (okRows.length !== 2 || (body.shots ?? []).some((s) => s.rid === "r3")) {
      return route.fulfill({
        status: 400,
        contentType: "text/plain",
        body: `mock 预检失败：shots 应只含 r1/r2，实际 ${JSON.stringify((body.shots ?? []).map((s) => s.rid))}`,
      });
    }
    if (!okRows.every((s) => s.imageUrl && s.prompt)) {
      return route.fulfill({ status: 400, contentType: "text/plain", body: "mock 预检失败：缺 imageUrl/prompt" });
    }
    if (!okRows.every((s) => s.prompt.includes("参考图1（首帧）"))) {
      return route.fulfill({ status: 400, contentType: "text/plain", body: "mock 预检失败：prompt 缺图N 参考编号行" });
    }
    if (body.params?.aspect !== "16:9" || body.params?.model !== "rh-minimax-h3") {
      return route.fulfill({
        status: 400,
        contentType: "text/plain",
        body: `mock 预检失败：params 应为 rh-minimax-h3/16:9，实际 ${JSON.stringify(body.params)}`,
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobId: "e2e_vjob" }),
    });
  }
  return route.continue();
});
await page.route("**/agent-service/storyboard/videos/e2e_vjob", (route) => {
  jobCalls++;
  const body =
    jobCalls <= 2
      ? { status: "running", images: [] }
      : {
          status: "done",
          images: [
            { rid: "r1", ok: true, videoUrl: FIXTURE_VIDEO },
            { rid: "r2", ok: false, error: "模拟：视频额度不足" },
          ],
        };
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
});

await page.goto(`${BASE}/project/${pid}`);
await page.waitForTimeout(1600);
await page.evaluate(() => window.__wsSetViewport?.({ x: 0, y: 0, zoom: 0.6 }));
await page.evaluate(() => {
  const st = window.__wsCanvasStore.getState();
  const shot = st.nodes.find((n) => n.data.nodeType === "shotlist");
  if (shot) st.selectNodes([shot.id]);
});
await page.waitForTimeout(400);

// 出视频按钮（aria-label=tooltip 前缀「勾选行批量生成镜头视频」）
const vbtn = page.locator('button[aria-label*="批量生成镜头视频"]').first();
check("A1 出视频按钮出现且计数 2 镜", (await vbtn.textContent()).includes("出视频·2 镜"), await vbtn.textContent().catch(() => ""));
await vbtn.evaluate((el) => el.click());
await page.waitForTimeout(12000); // mock 轮询（3s 间隔）两轮 running + done

let canvas = (await api(`/projects/${pid}/canvas`)).body;
const nodesA = canvas?.nodes ?? [];
const edgesA = canvas?.edges ?? [];
const vidNodes = nodesA.filter((n) => n.data.nodeType === "video");
check("A2 视频卡建成 ×2", vidNodes.length === 2, `${vidNodes.length} 张`);

const r1row = (nodesA.find((n) => n.id === "n_sl")?.data.rows ?? []).find((r) => r.rid === "r1");
const r2row = (nodesA.find((n) => n.id === "n_sl")?.data.rows ?? []).find((r) => r.rid === "r2");
check("A3 行 videoNodeId 回填", Boolean(r1row?.videoNodeId) && Boolean(r2row?.videoNodeId), `r1=${r1row?.videoNodeId} r2=${r2row?.videoNodeId}`);
check(
  "A4 首帧血缘 + 分镜表→视频卡连线",
  edgesA.some((e) => e.source === "n_img1" && e.target === r1row?.videoNodeId) &&
    edgesA.some((e) => e.source === "n_img2" && e.target === r2row?.videoNodeId) &&
    edgesA.some((e) => e.source === "n_sl" && e.target === r1row?.videoNodeId),
  `edges=${edgesA.length}`,
);
const v1 = nodesA.find((n) => n.id === r1row?.videoNodeId);
const v2 = nodesA.find((n) => n.id === r2row?.videoNodeId);
check("A5 r1 视频卡 ready 带视频", v1?.data.status === "ready" && v1?.data.videoUrl === FIXTURE_VIDEO, `${v1?.data.status} ${v1?.data.videoUrl}`);
check("A6 r1 视频卡位置在图卡下方", v1 && v1.position.y > (nodesA.find((n) => n.id === "n_img1")?.position.y ?? 1e9), `y=${v1?.position.y}`);
check("A7 r2 视频卡 error 带原因", v2?.data.status === "error" && String(v2?.data.errorMessage).includes("额度不足"), `${v2?.data.status}`);
check(
  "A8 收尾 videoJobId 已清",
  !(nodesA.find((n) => n.id === "n_sl")?.data.videoJobId),
  `videoJobId=${nodesA.find((n) => n.id === "n_sl")?.data.videoJobId}`,
);
// 成片按钮态：出视频后视频卡被选中（分镜表工具条收起），先选回分镜表
// 仅 1 段成片源（r1 ready；r2 失败）→ 成片需 2 段，按钮应禁用
await page.evaluate(() => {
  const st = window.__wsCanvasStore.getState();
  st.selectNodes(["n_sl"]);
});
await page.waitForTimeout(400);
const composeBtn = page.locator('button[aria-label*="拼接成片"]');
const composeDisabled = await composeBtn.first().isDisabled().catch(() => null);
check("A9 成片按钮态（仅 1 段视频源时应禁用）", composeDisabled === true, `disabled=${composeDisabled}`);

// ---------- B 组：断点恢复（videoJobId 挂卡 → 挂载续轮询收尾） ----------
await page.unrouteAll({ behavior: "ignoreErrors" });
jobCalls = 0;
await page.route("**/agent-service/storyboard/videos/e2e_vjob_resume", (route) => {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      status: "done",
      images: [{ rid: "r1", ok: true, videoUrl: FIXTURE_VIDEO }],
    }),
  });
});
await save(
  [
    {
      id: "n_script",
      type: "script",
      position: { x: 0, y: 0 },
      data: { nodeType: "script", title: "测试剧本", body: "雨夜茶馆。" },
    },
    {
      id: "n_sl",
      type: "shotlist",
      position: { x: 300, y: 0 },
      data: {
        nodeType: "shotlist",
        title: "分镜表",
        rows: [{ rid: "r1", action: "老陈抬头", imageNodeId: "n_img1", videoNodeId: "n_vid_resume" }],
        videoJobId: "e2e_vjob_resume",
        status: "ready",
      },
    },
    imgNode("n_img1"),
    {
      id: "n_vid_resume",
      type: "video",
      position: { x: 800, y: 260 },
      data: { nodeType: "video", title: "镜头 01 视频", status: "loading", imageUrl: png1px },
    },
  ],
  [{ id: "e_s", source: "n_script", target: "n_sl" }],
);
await page.goto(`${BASE}/project/${pid}`);
await page.waitForTimeout(8000); // 挂载即续轮询（3s 间隔）
canvas = (await api(`/projects/${pid}/canvas`)).body;
const vidR = (canvas?.nodes ?? []).find((n) => n.id === "n_vid_resume");
check("B1 恢复轮询把视频卡收成 ready", vidR?.data.status === "ready" && vidR?.data.videoUrl === FIXTURE_VIDEO, `${vidR?.data.status}`);
check(
  "B2 恢复后 videoJobId 已清",
  !((canvas?.nodes ?? []).find((n) => n.id === "n_sl")?.data.videoJobId),
);

await browser.close();

// ---------- C 组（REAL=1）：真跑 1 条 RunningHub MiniMax H3 参考生视频 ----------
if (process.env.REAL === "1") {
  // 首帧 fixture：真图上传成资产（RunningHub 工作流上传通道走本地 bytes）
  execSync(
    `ffmpeg -y -loglevel error -f lavfi -i testsrc=duration=1:size=320x240:rate=5 -frames:v 1 /tmp/e2e_vfx.jpg`,
  );
  const imgUp = await api(`/assets?name=e2e_vfx.jpg`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: readFileSync(`/tmp/e2e_vfx.jpg`),
  });
  const FIXTURE_IMG = imgUp.body?.url ?? "";
  const { body: start } = await api(`/storyboard/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shots: [
        {
          rid: "r_real",
          name: "镜头1",
          prompt:
            "运镜：缓慢推进；画面：午后山坡风吹草动，光线柔和\n参考图1（首帧）：画面与构图基准，从该画面起运镜",
          imageUrl: FIXTURE_IMG,
        },
      ],
      params: { model: "rh-minimax-h3", duration: 5, resolution: "540p", aspect: "16:9" },
      project_id: pid,
    }),
  });
  const jid = start?.jobId;
  check("C1 真任务启动", Boolean(jid), JSON.stringify(start).slice(0, 80));
  if (jid) {
    let done = false;
    let last = "";
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const { body: job } = await api(`/storyboard/videos/${jid}`);
      last = JSON.stringify(job).slice(0, 120);
      if (job?.status === "done" || job?.status === "cancelled") {
        const item = (job.images ?? []).find((x) => x.rid === "r_real");
        check("C2 真出视频成功", item?.ok && Boolean(item.videoUrl), last);
        if (item?.videoUrl) {
          // videoUrl 已是 /agent-service/assets/... 完整路径，直接挂 BASE
          const head = await fetch(`${BASE}${item.videoUrl}`, {
            headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
          });
          check("C3 视频资产可下载", head.ok, `HTTP ${head.status}`);
        }
        done = true;
        break;
      }
    }
    if (!done) check("C2 真出视频成功", false, `超时：${last}`);
  }
}

// ---------- 收尾：删测试项目 ----------
const del = await api(`/projects/${pid}`, { method: "DELETE" });
check("清理测试项目", del.status === 200 || del.status === 204, `HTTP ${del.status}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("失败项:", failed.map((f) => f.name).join(" / "));
  process.exit(1);
}
