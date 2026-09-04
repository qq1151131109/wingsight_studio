/**
 * E2E：图片节点操作层（doc/image-node-ops-spec.md P0/P1-1/P2）。
 * 锁四组契约：
 *  A 右键图片专属段——图片/资产卡出现（下载/复制/裁剪/多视角/打光），
 *    三视图仅角色卡出，文本卡不出段
 *  B 模板化动作管线——预设弹窗确认后：建新图片卡+连线、**源卡图不被覆盖**、
 *    GENERATE_EVENT 载荷（prompt 含模板句、referenceImages 含源图、rid 指新卡）
 *  C 画风闸——未选画风时新卡被拦（错误明报），不发任务
 *  D 裁剪——原位替换+旧图入版本档+撤销可回滚
 * 出图任务走 route mock（不耗真实额度）；裁剪上传走真实 /assets（小 PNG）。
 * 前置：agent(8123) + 前端(8008) 在跑。
 */
import { readFileSync } from "node:fs";
import zlib from "node:zlib";
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

// ---- 纯 node 造一张真 PNG（裁剪要真像素，data URL 一像素图不够） ----
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h, [r, g, b]) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]);
  for (let x = 0; x < w; x++) {
    // 左右渐变，裁剪后可从颜色大致辨认区域
    const t = Math.round((x / w) * 120);
    row.writeUInt8(Math.min(255, r + t), 1 + x * 3);
    row.writeUInt8(Math.min(255, g + t), 2 + x * 3);
    row.writeUInt8(Math.min(255, b + t), 3 + x * 3);
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const pngBuf = makePng(320, 200, [60, 90, 130]);
const up = await api("/assets?name=e2e_imgops_src.png", {
  method: "POST",
  headers: { "Content-Type": "image/png" },
  body: pngBuf,
});
if (up.status !== 200) throw new Error(`上传源图失败 ${up.status}`);
const SRC_URL = up.body.url;

const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-imgops-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;

await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    nodes: [
      {
        id: "img1", type: "image", position: { x: 0, y: 0 },
        data: { nodeType: "image", title: "测试底图", body: "", imageUrl: SRC_URL, genPrompt: "原图提示词：码头黄昏", status: "ready" },
      },
      {
        id: "ch1", type: "character", position: { x: 860, y: 0 },
        data: { nodeType: "character", title: "测试角色", body: "考古学家", imageUrl: SRC_URL, status: "ready" },
      },
      {
        id: "note1", type: "note", position: { x: 1400, y: 0 },
        data: { nodeType: "note", title: "备忘", body: "文本卡不该有图片段" },
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

// 出图任务 mock：捕获 POST 体（B 组断言）；GET 完成态回真实上传过的 URL
let genPosts = [];
let lastRid = "";
await page.route("**/agent-service/storyboard/images", (route) => {
  if (route.request().method() === "POST") {
    const body = route.request().postDataJSON();
    genPosts.push(body);
    lastRid = body.shots?.[0]?.rid ?? "";
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "e2e_imgops_job" }) });
  }
  return route.continue();
});
await page.route("**/agent-service/storyboard/images/e2e_imgops_job", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ status: "done", images: [{ rid: lastRid, ok: true, imageUrl: SRC_URL }] }),
  }),
);

await page.goto(`${BASE}/project/${pid}`);
await page.locator("text=测试底图").first().waitFor({ timeout: 15000 });
// 画风闸前置 + 关智能编排干扰（模板 prompt 已是完整指令，compose 语义此处无关）
await page.evaluate(() => {
  const st = window.__wsCanvasStore;
  st?.setState({ projectStyle: "测试画风" });
});

const nodeOf = (title) =>
  page.locator(".react-flow__node").filter({ hasText: title }).first();
async function openMenu(title) {
  await nodeOf(title).click({ button: "right", timeout: 5000 });
  await page.locator("text=图片操作").waitFor({ timeout: 4000 });
}

// ---------- A 菜单段 ----------
await openMenu("测试底图");
for (const item of ["下载图片", "复制图片", "复制出图提示词", "裁剪…", "多视角…", "打光…", "人物质感…"]) {
  check(`A1 图片卡菜单含「${item}」`, (await page.locator(`text=${item}`).count()) > 0);
}
check(
  "A2 图片卡菜单不含三视图（仅角色卡）",
  (await page.locator("text=三视图…").count()) === 0,
);
await page.keyboard.press("Escape");
await page.mouse.click(400, 600); // 关菜单

// ---------- A5 顶部工具条（主入口：选中即在卡上方，无需右键） ----------
// 经 store 选中（点卡会被媒体区 zoom/工具条拦指针，选区才是唯一变量）
await page.evaluate(() => window.__wsCanvasStore.getState().selectNodes(["img1"]));
await page.locator('[aria-label="生成其他机位视角"]').waitFor({ timeout: 5000 });
for (const t of ["裁剪画面比例", "生成其他机位视角", "替换画面光效", "人物质感精修", "解除比例锁定，任意拉伸"]) {
  check(`A5-1 图片卡顶部条含「${t}」`, (await page.locator(`[aria-label^="${t}"]`).count()) > 0);
}
check(
  "A5-2 图片卡顶部条不含三视图",
  (await page.locator('[aria-label^="生成三视图"]').count()) === 0,
);
await page.evaluate(() => window.__wsCanvasStore.getState().selectNodes(["ch1"]));
await page.locator('[aria-label^="生成三视图"]').waitFor({ timeout: 5000 });
check("A5-3 角色卡顶部条含三视图", (await page.locator('[aria-label^="生成三视图"]').count()) > 0);
await page.evaluate(() => window.__wsCanvasStore.getState().selectNodes(["note1"]));
await page.waitForTimeout(400);
check(
  "A5-4 文本卡顶部条无图片操作",
  (await page.locator('[aria-label^="生成其他机位视角"]').count()) === 0,
);

// ---------- A6 贴顶钳制：卡片在视口顶边时工具条压在标题行上（不被裁出屏） ----------
await page.evaluate(() => {
  const st = window.__wsCanvasStore.getState();
  // 把 img1 移到视口顶边（viewport y 负值 → 卡片屏幕 top < 96）
  st.setViewport({ x: 600, y: -40, zoom: 0.8 });
  st.selectNodes(["img1"]);
});
await page.waitForTimeout(600);
{
  const box = await page.locator('[aria-label="生成其他机位视角"]').boundingBox();
  check("A6-1 贴顶时工具条钳在应用头部下方", Boolean(box && box.y >= 40 && box.y <= 120), JSON.stringify(box));
}
await page.evaluate(() => {
  // 拉回正常位置：工具条回到卡片上方常规位
  window.__wsCanvasStore.getState().setViewport({ x: 600, y: 300, zoom: 0.8 });
});
await page.waitForTimeout(600);
{
  const box = await page.locator('[aria-label="生成其他机位视角"]').boundingBox();
  const card = await nodeOf("测试底图").boundingBox();
  check(
    "A6-2 离开顶边后工具条回到卡片上方",
    Boolean(box && card && box.y < card.y && box.y > 40),
    `toolbar.y=${box?.y} card.top=${card?.y}`,
  );
}
// ---------- A7 任意缩放档都可见（zoom<0.5 曾被 tiny 守卫藏掉——用户"看不到入口"根因） ----------
for (const z of [0.45, 0.3]) {
  await page.evaluate((zz) => {
    window.__wsCanvasStore.getState().setViewport({ x: 500, y: 400, zoom: zz });
  }, z);
  await page.waitForTimeout(500);
  check(
    `A7 zoom=${z} 时工具条仍可见`,
    (await page.locator('[aria-label="生成其他机位视角"]').count()) > 0,
  );
}
await page.evaluate(() => {
  window.__wsCanvasStore.getState().setViewport({ x: 500, y: 400, zoom: 0.8 });
});

await openMenu("测试角色");
check("A3 角色卡菜单含三视图", (await page.locator("text=三视图…").count()) > 0);
await page.mouse.click(400, 600);

await nodeOf("备忘").click({ button: "right", timeout: 5000 });
await page.waitForTimeout(400);
check("A4 文本卡无图片操作段", (await page.locator("text=图片操作").count()) === 0);
await page.mouse.click(400, 600);

// ---------- B 模板化动作 ----------
await openMenu("测试底图");
await page.locator("text=多视角…").click();
await page.locator("text=俯拍").waitFor({ timeout: 4000 });
await page.locator("text=俯拍").click();
await page.getByRole("button", { name: /生成多视角卡/ }).click();
await page.waitForTimeout(4000);

const stateB = await page.evaluate(() => {
  const st = window.__wsCanvasStore.getState();
  return {
    nodes: st.nodes.map((n) => ({ id: n.id, type: n.data.nodeType, title: n.data.title, img: n.data.imageUrl, status: n.data.status })),
    edges: st.edges.map((e) => ({ s: e.source, t: e.target })),
  };
});
const newCard = stateB.nodes.find((n) => n.title?.includes("俯拍"));
check("B1 生成新图片卡（标题含预设）", Boolean(newCard && newCard.type === "image"), JSON.stringify(newCard?.title));
check("B2 源卡连线到新卡", Boolean(newCard && stateB.edges.some((e) => e.s === "img1" && e.t === newCard.id)), JSON.stringify(stateB.edges));
check("B3 源卡图不被覆盖", stateB.nodes.find((n) => n.id === "img1")?.img === SRC_URL);
const shot = genPosts[0]?.shots?.[0];
// compose 开时模板 prompt 走 instruction 字段（description=编号注记+prompt）
const instr = shot?.instruction ?? shot?.prompt ?? "";
check(
  "B4 载荷 prompt 含模板句与源上下文",
  instr.includes("机位") && instr.includes("完全一致") && instr.includes("码头黄昏"),
  instr.slice(0, 80),
);
check("B5 载荷参考含源图", (shot?.referenceImages ?? []).includes(SRC_URL), JSON.stringify(shot?.referenceImages));
check("B6 rid 指新卡（非源卡）", Boolean(newCard && shot?.rid?.startsWith(`${newCard.id}#`)), shot?.rid);
check("B7 新卡出图完成（ready）", newCard?.status === "ready" && Boolean(newCard?.img), `${newCard?.status} ${newCard?.img?.slice(0, 40)}`);

// ---------- C 画风闸 ----------
await page.evaluate(() => window.__wsCanvasStore?.setState({ projectStyle: "" }));
await openMenu("测试角色");
await page.locator("text=打光…").click();
await page.locator("text=伦勃朗").waitFor({ timeout: 4000 });
await page.locator("text=伦勃朗").click();
await page.getByRole("button", { name: /生成打光卡/ }).click();
await page.waitForTimeout(1500);
const stateC = await page.evaluate(() => {
  const st = window.__wsCanvasStore.getState();
  const n = st.nodes.filter((x) => x.data.title?.includes("伦勃朗")).pop();
  return { err: n?.data.errorMessage ?? "", img: n?.data.imageUrl ?? "", count: st.nodes.length };
});
check("C1 无画风不发任务", genPosts.length === 1, `posts=${genPosts.length}`);
check("C2 新卡错误明报未选画风", stateC.err.includes("未选画风"), stateC.err.slice(0, 50));
check("C3 源卡（角色）图不被覆盖", stateC.img !== SRC_URL || !stateC.img, stateC.img.slice(0, 40));
await page.keyboard.press("Escape");
await page.evaluate(() => window.__wsCanvasStore?.setState({ projectStyle: "测试画风" }));

// ---------- D 裁剪 ----------
await openMenu("测试底图");
await page.locator("text=裁剪…").click();
await page.locator("text=16:9").waitFor({ timeout: 4000 });
await page.locator("text=16:9").click();
await page.getByRole("button", { name: "裁剪", exact: true }).click();
await page.waitForTimeout(4000); // 真实上传 + 状态落库
const stateD = await page.evaluate(() => {
  const n = window.__wsCanvasStore.getState().nodes.find((x) => x.id === "img1");
  return { img: n.data.imageUrl ?? "", versions: n.data.versions ?? [], status: n.data.status };
});
check("D1 裁剪后原位替换（imageUrl 更新）", stateD.img !== SRC_URL && Boolean(stateD.img), stateD.img.slice(0, 44));
check("D2 旧图入版本档", stateD.versions.some((v) => v.url === SRC_URL), JSON.stringify(stateD.versions.map((v) => v.url)));
check("D3 状态 ready", stateD.status === "ready");
await page.keyboard.press("Control+z");
await page.waitForTimeout(600);
const stateD2 = await page.evaluate(() => {
  const n = window.__wsCanvasStore.getState().nodes.find((x) => x.id === "img1");
  return { img: n.data.imageUrl ?? "" };
});
check("D4 撤销回滚裁剪（原图恢复）", stateD2.img === SRC_URL, stateD2.img.slice(0, 44));

// ---------- E 自由缩放切换 ----------
await openMenu("测试底图");
await page.locator("text=自由缩放").click();
await page.waitForTimeout(300);
let flag = await page.evaluate(
  () => window.__wsCanvasStore.getState().nodes.find((n) => n.id === "img1").data.freeResize,
);
check("E1 切自由缩放（freeResize=true）", flag === true, String(flag));
await openMenu("测试底图");
await page.locator("text=锁定比例").click();
await page.waitForTimeout(1200); // 回弹等图加载
flag = await page.evaluate(
  () => window.__wsCanvasStore.getState().nodes.find((n) => n.id === "img1").data.freeResize,
);
check("E2 切回锁定（freeResize=false）", flag !== true, String(flag));

// ---------- F 宫格合成导出 ----------
await page.evaluate(() =>
  window.__wsCanvasStore.getState().selectNodes(["img1", "ch1"]),
);
await nodeOf("测试底图").click({ button: "right", timeout: 5000 });
await page.locator("text=合成宫格导出").waitFor({ timeout: 4000 });
const dlPromise = page.waitForEvent("download", { timeout: 15000 });
await page.locator("text=合成宫格导出").click();
const dl = await dlPromise;
check("F1 宫格导出触发下载", Boolean(dl), dl?.suggestedFilename() ?? "");
check("F2 下载文件名正确", (dl?.suggestedFilename() ?? "").includes("宫格导出"), dl?.suggestedFilename() ?? "");

// ---------- G 双击聚焦（open-ai-canvas focusCanvasImageNode 范式） ----------
// 前置：zoom 保持 1.0（lod 正常渲染 img），平移视口让卡片偏到角落
await page.evaluate(() => {
  const st = window.__wsCanvasStore.getState();
  st.setViewport({ x: 1800, y: 900, zoom: 1 });
  st.selectNodes([]);
});
await page.waitForTimeout(300);
// 图片本体 pointer-events-none（拖图=移卡，I 组），双击/单击落在容器上
const img1 = nodeOf("测试底图").locator('div[title="双击：视口聚焦本卡"]').first();
await img1.dblclick({ timeout: 5000 });
await page.waitForTimeout(900); // fitView duration 420ms + 余量
{
  const vp = await page.evaluate(() => window.__wsCanvasStore.getState().viewport);
  check(
    "G1 双击图片 → 视口聚焦（统一观感尺寸，zoom 有界 0.2–6）",
    vp.zoom >= 0.2 && vp.zoom <= 6,
    `zoom=${vp.zoom.toFixed(2)}`,
  );
  const card = await nodeOf("测试底图").boundingBox();
  const vw = page.viewportSize();
  const vh = page.viewportSize();
  const cx = card ? card.x + card.width / 2 : 0;
  check(
    "G2 卡片居中于视口",
    Boolean(card && Math.abs(cx - vw.width * 0.5) < vw.width * 0.18),
    `卡片中心 x=${Math.round(cx)} 视口中心=${Math.round(vw.width * 0.5)}`,
  );
  check(
    "G3 卡片统一观感尺寸（占视口高 ~78%±15%）",
    Boolean(card && Math.abs(card.height / vh.height - 0.78) < 0.15),
    `占比=${card ? (card.height / vh.height).toFixed(2) : "?"}`,
  );
}
// 单击图片不再弹灯箱（灯箱走角落 ⌕ 按钮，竞品共识：预览是显式动作）
await img1.click({ timeout: 5000 });
await page.waitForTimeout(400);
check(
  "G4 单击图片不弹大图",
  (await page.evaluate(() => !document.querySelector(".fixed.inset-0.z-\\[1300\\]"))) === true,
);

// ---------- H 加号手柄（建上下游卡） ----------
// 曾双重坏死：① zoom<0.5 被 LOD 藏掉（96 节点总览时"画布上没有加号"）
// ② 菜单挂在 .ws-card 内被 overflow:hidden 整个裁掉（9adec014e 引入裁剪
// 误伤）——菜单进 DOM 但不可见。修复：菜单挂根节点 + 浮层/菜单/命中半径
// 按 1/zoom 反向补偿（屏幕恒定尺寸，任意缩放档可读可点）
await page.evaluate(() => {
  const st = window.__wsCanvasStore.getState();
  st.selectNodes([]);
  st.setViewport({ x: 60, y: 120, zoom: 1 });
});
await page.waitForTimeout(400);
const hCard = nodeOf("备忘");
{
  // 悬停显现 + 点右加号弹「建下游卡」菜单（可见、在屏内）
  const cb = await hCard.boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, { steps: 3 });
  await page.waitForTimeout(300);
  const rightPlus = hCard.locator(".ws-plus").nth(1);
  const pb = await rightPlus.boundingBox();
  check(
    "H1 zoom=1 悬停浮现加号（opacity=1）",
    (await rightPlus.evaluate((el) => Number(getComputedStyle(el).opacity))) > 0.9,
  );
  await page.mouse.click(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.waitForTimeout(400);
  const menuLabel = page.locator("text=建下游卡").first();
  const mb = await menuLabel.boundingBox();
  check(
    "H2 点加号弹建卡菜单且在屏内可见（不被卡裁剪）",
    Boolean(mb && mb.x >= 0 && mb.y >= 0 && (await menuLabel.isVisible())),
    JSON.stringify(mb && { x: Math.round(mb.x), y: Math.round(mb.y) }),
  );
  check(
    "H2b 点加号不选中卡片（工具条不弹，低缩放贴顶时工具条会盖住加号）",
    (await page.evaluate(() => !window.__wsCanvasStore.getState().nodes.find((n) => n.id === "note1")?.selected)) &&
      (await page.locator(".react-flow__node-toolbar").count()) === 0,
  );
  await page.screenshot({ path: "/tmp/e2e-h2-menu.png" });
  // 点「文本」建下游卡：新卡 + 连线
  const before = await page.evaluate(() => {
    const s = window.__wsCanvasStore.getState();
    return { n: s.nodes.length, e: s.edges.length };
  });
  await page.getByRole("button", { name: "文本", exact: true }).last().click();
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => {
    const s = window.__wsCanvasStore.getState();
    return {
      n: s.nodes.length,
      e: s.edges.length,
      linked: s.edges.some((x) => x.source === "note1"),
    };
  });
  check("H3 菜单建下游卡（新卡+连线）", after.n === before.n + 1 && after.e === before.e + 1 && after.linked, JSON.stringify({ before, after }));
}
{
  // 低缩放档（0.3）：加号可见且屏幕尺寸 ~22px（未补偿会是 ~7px）、菜单可读。
  // 先取消选中：H3 建的新卡被自动选中，其贴顶钳制的工具条在低缩放档会
  // 盖住 note1 右侧加号（复现过点击落在工具条按钮上）
  await page.evaluate(() => {
    const st = window.__wsCanvasStore.getState();
    st.selectNodes([]);
    st.setViewport({ x: 60, y: 60, zoom: 0.3 });
  });
  await page.waitForTimeout(500);
  const cb = await hCard.boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, { steps: 3 });
  await page.waitForTimeout(300);
  const rightPlus = hCard.locator(".ws-plus").nth(1);
  const pb = await rightPlus.boundingBox();
  check(
    "H4 zoom=0.3 加号仍显现且屏幕尺寸可读（≥16px）",
    Boolean(pb && pb.width >= 16 && (await rightPlus.evaluate((el) => Number(getComputedStyle(el).opacity))) > 0.9),
    pb ? `w=${pb.width.toFixed(0)}` : "no box",
  );
  await page.mouse.click(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.waitForTimeout(400);
  const mb = await page.locator("text=建下游卡").first().boundingBox();
  check(
    "H5 zoom=0.3 菜单反缩放补偿后可读（宽 ≥60px）",
    Boolean(mb && mb.width >= 60 && (await page.locator("text=建下游卡").first().isVisible())),
    mb ? `w=${mb.width.toFixed(0)}` : "no menu",
  );
  await page.screenshot({ path: "/tmp/e2e-h5-lowzoom.png" });
  await page.mouse.click(200, 800); // 关菜单
}
{
  // ---------- I 图片区拖动=移动整卡（viedeo 范式：图片本体 pointer-events-none，
  // 引用拖拽收拢到悬浮抓手——曾因 HTML5 拖拽+nodrag 整个屏蔽节点拖动） ----------
  await page.evaluate(() => {
    const st = window.__wsCanvasStore.getState();
    st.selectNodes([]);
    st.setViewport({ x: 40, y: 140, zoom: 1 });
  });
  await page.waitForTimeout(500);
  const iCard = nodeOf("测试底图");
  const imgEl = iCard.locator("img").first();
  check(
    "I1 图片 pointer-events=none（点击/拖拽穿透到节点层）",
    (await imgEl.evaluate((el) => getComputedStyle(el).pointerEvents)) === "none",
  );
  check(
    "I2 图片区悬浮引用抓手（双载荷：输入条/聊天）",
    (await iCard.locator('[aria-label^="拖到输入条/聊天框"]').count()) === 1,
  );
  const cb = await iCard.boundingBox();
  const before = await page.evaluate(
    () => window.__wsCanvasStore.getState().nodes.find((n) => n.id === "img1").position,
  );
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width / 2 + 160, cb.y + cb.height / 2 + 120, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await page.evaluate(
    () => window.__wsCanvasStore.getState().nodes.find((n) => n.id === "img1").position,
  );
  check(
    "I3 拖图片区域移动整卡",
    after.x > before.x + 100 && after.y > before.y + 80,
    `(${Math.round(before.x)},${Math.round(before.y)})→(${Math.round(after.x)},${Math.round(after.y)})`,
  );
}
{
  // 拖拽连线仍可用（connectOnClick 关闭只影响点击语义，拖拽走 mousedown）
  await page.evaluate(() => {
    window.__wsCanvasStore.getState().setViewport({ x: 60, y: 120, zoom: 0.6 });
  });
  await page.waitForTimeout(500);
  const src = await nodeOf("备忘").boundingBox();
  const dst = await nodeOf("测试角色").boundingBox();
  const e0 = await page.evaluate(() => window.__wsCanvasStore.getState().edges.length);
  await page.mouse.move(src.x + src.width + 4, src.y + src.height / 2 + 4);
  await page.mouse.down();
  // 落点对准目标卡左缘手柄（卡中心距手柄太远，超出 connectionRadius）
  await page.mouse.move(dst.x - 4, dst.y + dst.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const linked = await page.evaluate(() =>
    window.__wsCanvasStore.getState().edges.some((e) => e.source === "note1" && e.target === "ch1"),
  );
  check("H6 拖拽加号到目标卡连线（connectOnClick 关闭不误伤拖拽）", linked, `edges+${(await page.evaluate(() => window.__wsCanvasStore.getState().edges.length)) - e0}`);
}

await browser.close();
const fails = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} 通过`);
process.exit(fails ? 1 : 0);
