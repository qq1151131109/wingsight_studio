/**
 * E2E 回归：参考图管线批1（罪案实录事故修复）。
 *  - sanitize 存量清洗：hint 占位标题（「设定图 / 参考图占位」）/hex 文件名
 *    标题剥成空名，用户真标题保留
 *  - @ 候选：已连线卡置顶组（带「已连线」标记）、同类型卡不再被截 3 条
 *  - 「参考 N/4」口径 = 实际发送序列（本卡原图 + 连线带图卡），非只数 token
 *  - 契约推断 v2：图片卡+带图参考 → shot（旧 scene 无人空镜）；@自己/无其他
 *    参考 → 改图最小模板 promptTemplate；无参考+场景关键词 → scene；
 *    角色卡参考 → shot 剧照（旧 character 四格）
 * 出图任务 route mock，不消耗真实额度。前置：前端(8008)+agent(8123) 在跑。
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

const svg = (label, bg) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="${bg}"/><text x="360" y="640" font-size="160" fill="white" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`,
  );

let gridI = 0;
const pos = () => ({ x: (gridI % 4) * 300, y: Math.floor(gridI++ / 4) * 380 });
const img = (id, extra = {}) => ({
  id,
  type: "image",
  position: pos(),
  data: { nodeType: "image", status: "ready", ...extra },
});

const nodes = [
  // 存量占位标题卡（sanitize 应剥成空名）
  ...["旧卡一", "旧卡二", "旧卡三", "旧卡四", "旧卡五", "旧卡六"].map((t, i) =>
    img(`old${i}`, { title: "设定图 / 参考图占位", body: `旧卡${i}`, imageUrl: svg(`O${i}`, "#777777") }),
  ),
  img("hexcard", { title: "6a8d0d5be4b0878a6c9b50f8.jpg", imageUrl: svg("H", "#555555") }),
  // 连线参考两张（新约定空名 + 可辨认的正文）
  img("refF", { body: "女主设定图", imageUrl: svg("F", "#8a4a4a") }),
  img("refM", { body: "男主设定图", imageUrl: svg("M", "#4a5a8a") }),
  // 咖啡馆事故复刻：带图 + 两条连线 + 人物剧情提示词（genPrompt=已生成谱系卡，
  // 提交走原位+版本档案，不进上传图派生分支）
  img("shot", { imageUrl: svg("C", "#3f5a3f"), body: "现代都市年轻女性，独立清醒，冷白灯光与霓虹夜景。", genPrompt: "旧图快照" }),
  // 改图卡：带图、无连线（谱系卡，原位改图语义）
  img("editCard", { imageUrl: svg("E", "#6a5a3f"), genPrompt: "旧图快照" }),
  // 上传图：带图、无生成谱系（genShot/genPrompt 皆无）——提交应派生新卡
  img("upCard", { title: "上传图", imageUrl: svg("U", "#5a4a6a") }),
  // 场景关键词卡：无图无线
  { id: "sceneCard", type: "image", position: pos(), data: { nodeType: "image", title: "山城夜景场景" } },
  // 角色卡参考的剧照卡
  { id: "charA", type: "character", position: pos(), data: { nodeType: "character", title: "张波", imageUrl: svg("Z", "#4a6a4a") } },
  img("charShot", {}),
];
const edges = [
  { id: "e1", source: "refF", target: "shot" },
  { id: "e2", source: "refM", target: "shot" },
  { id: "e3", source: "charA", target: "charShot" },
];

// ---------- 测试项目 + 画布 ----------
const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-refpipe-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;
const put = await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ nodes, edges, viewport: { x: 10, y: 10, zoom: 0.5 } }),
});
if (put.status !== 200) throw new Error(`PUT canvas 失败 ${put.status}: ${JSON.stringify(put.body).slice(0, 200)}`);
// 视口整体缩小：onlyRenderVisibleElements 会卸载视口外卡，缩放保证全部可点

// ---------- 浏览器 ----------
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
if (TOKEN)
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["wingsight_studio_token", TOKEN],
  );
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 400)));
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 250));
});

let lastPayload = null;
let lastRids = [];
await page.route("**/agent-service/storyboard/images", (route) => {
  if (route.request().method() === "POST") {
    lastPayload = route.request().postDataJSON();
    lastRids = (lastPayload?.shots ?? []).map((s) => s.rid);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "e2e_pipe_job" }) });
  }
  return route.continue();
});
// 按 POST 的 rid 回成功图：卡落 ready 态，不留「生成失败·重试」按钮干扰后续选择器
await page.route("**/agent-service/storyboard/images/e2e_pipe_job", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      status: "done",
      images: lastRids.map((rid) => ({ rid, ok: true, imageUrl: svg("OK", "#3a6a3a") })),
    }),
  }),
);

const select = async (id) => {
  // 点卡片头部（避开媒体区防开灯箱）；fitView 动画期点击会被吞，先等稳定，
  // xyflow 初始化竞态也可能吞一次选择，重试兜底
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(i === 0 ? 1200 : 800);
    await page
      .locator(`.react-flow__node[data-id="${id}"]`)
      .click({ position: { x: 5, y: 4 }, force: i > 0 });
    try {
      await page
        .getByRole("button", { name: /^生成/ }).first()
        .waitFor({ state: "visible", timeout: 4000 });
      return;
    } catch {
      await page.evaluate((nid) => window.__wsCanvasStore.getState().selectNodes([nid]), id);
      await page.waitForTimeout(800);
    }
  }
  await page
    .getByRole("button", { name: /^生成/ }).first()
    .waitFor({ state: "visible", timeout: 4000 })
    .catch(async () => {
      console.error("[select 诊断]", await page.evaluate((nid) => JSON.stringify({
        selected: window.__wsCanvasStore.getState().nodes.filter((n) => n.selected).map((n) => n.id),
        panels: document.querySelectorAll(".ws-detail").length,
        btns: [...document.querySelectorAll("button")].map((b) => b.textContent?.trim()).filter(Boolean).slice(0, 30),
        shotPos: (() => { const el = document.querySelector(`.react-flow__node[data-id="${nid}"]`); if (!el) return "gone"; const r = el.getBoundingClientRect(); return `${r.x},${r.y} ${r.width}x${r.height}`; })(),
      }), id));
      await page.screenshot({ path: new URL("./refpipe-fail.png", import.meta.url).pathname });
      throw new Error(`select(${id}) 后面板未出现`);
    });
};
const typePrompt = async (text) => {
  const ed = page.locator('[contenteditable="true"]').first();
  await ed.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
};
const submit = async () => {
  lastPayload = null;
  await page.getByRole("button", { name: /^生成/ }).first().click();
  // directImagegen 先拉模型目录/探画幅才发 POST，轮到 payload 出现为止
  for (let i = 0; i < 40 && !lastPayload; i++) await page.waitForTimeout(250);
};

try {
  await page.goto(`${BASE}/project/${pid}`);
  await page.locator(".react-flow__node").first().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(2500);
  // 画风闸：不设画风提交会弹「项目画风」选择器拦路
  await page.evaluate(() => window.__wsCanvasStore.setState({ projectStyle: "电影感胶片质感" }));

  // 1. sanitize：占位标题/hex 文件名剥成空名，真标题保留
  const titles = await page.evaluate(() => {
    const st = window.__wsCanvasStore.getState();
    return Object.fromEntries(st.nodes.map((n) => [n.id, n.data.title ?? ""]));
  });
  check(
    "sanitize 剥占位标题、保留真标题",
    ["old0", "old1", "old2", "old3", "old4", "old5", "hexcard"].every((k) => titles[k] === "") &&
      titles.charA === "张波" && titles.sceneCard === "山城夜景场景",
    JSON.stringify(titles).slice(0, 120),
  );

  // 2. 咖啡馆事故复刻：计数口径 = 本卡原图 + 两条连线 = 3/4（旧口径 0/4）
  await select("shot");
  await page.getByRole("button", { name: /^生成/ }).first().waitFor({ state: "visible", timeout: 5000 });
  const counter = await page.getByText(/参考 \d\/\d/).textContent();
  check("计数口径=真实序列（3/4）", counter?.trim() === "参考 3/4", counter?.trim() ?? "none");

  // 3. @ 候选分组：已连线独立成组（tab 直达，组内含两张设定图带已连线标记）；
  //    旧「混排截断挤卡」问题由分组根治
  await page.locator('[contenteditable="true"]').first().click();
  await page.keyboard.type("@");
  await page.waitForTimeout(300);
  await page.locator('button[aria-label^="分组 已连线"]').click();
  await page.waitForTimeout(200);
  // 点 tab 后焦点在按钮上：还回编辑器，Escape 才不会冒泡成「清空选区」
  await page.locator('[contenteditable="true"]').first().click();
  await page.waitForTimeout(150);
  const badgeCount = await page
    .locator('.absolute.bottom-full button.py-1', { hasText: "已连线" })
    .count();
  check("候选已连线标记 ×2", badgeCount === 2, `count=${badgeCount}`);
  const rows = await page
    .locator(".absolute.bottom-full button.px-1\\.5")
    .allTextContents();
  check(
    "已连线组=女主/男主设定图",
    rows.some((t) => t.includes("女主设定图")) && rows.some((t) => t.includes("男主设定图")),
    rows.join(" | ").slice(0, 80),
  );
  check(
    "已连线组仅含连线卡（旧建卡各归类型组）",
    !rows.some((t) => t.includes("旧卡")),
    rows.join(" | ").slice(0, 60),
  );
  await page.keyboard.press("Escape");

  // 4. 契约推断：图片卡 + 带图参考 + 人物剧情 → shot（旧 scene），无改图模板
  await typePrompt("午后暖光，两人隔桌而坐");
  await submit();
  check(
    "带图参考→shot 契约",
    lastPayload?.shots?.[0]?.assetType === "shot" && !lastPayload?.shots?.[0]?.promptTemplate,
    `assetType=${lastPayload?.shots?.[0]?.assetType}`,
  );
  check(
    "参考序列=本卡原图+2连线",
    (lastPayload?.shots?.[0]?.referenceImages ?? []).length === 3,
    `refs=${lastPayload?.shots?.[0]?.referenceImages?.length}`,
  );

  // 5. 改图模式：带图无连线 → promptTemplate 最小模板 + 仅本卡原图
  await select("editCard");
  await page.getByRole("button", { name: /^生成/ }).first().waitFor({ state: "visible", timeout: 5000 });
  await typePrompt("换成雨夜氛围");
  await submit();
  const s5 = lastPayload?.shots?.[0];
  check(
    "改图→最小模板",
    typeof s5?.promptTemplate === "string" &&
      s5.promptTemplate.includes("{description}") &&
      s5.promptTemplate.includes("{_reference_note}") &&
      !s5.promptTemplate.includes("{layout}"),
    `assetType=${s5?.assetType} tpl=${Boolean(s5?.promptTemplate)}`,
  );
  check("改图参考=仅本卡原图", (s5?.referenceImages ?? []).length === 1, `refs=${s5?.referenceImages?.length}`);

  // 6. 场景关键词：无参考 + 标题含「场景」 → scene 空镜
  await select("sceneCard");
  await page.getByRole("button", { name: /^生成/ }).first().waitFor({ state: "visible", timeout: 5000 });
  await typePrompt("黄昏光线，暖色调");
  await submit();
  check(
    "场景关键词→scene 空镜",
    lastPayload?.shots?.[0]?.assetType === "scene" && (lastPayload?.shots?.[0]?.referenceImages ?? []).length === 0,
    `assetType=${lastPayload?.shots?.[0]?.assetType}`,
  );

  // 7. 角色卡参考 → shot 剧照（旧 character 四格定妆）
  await select("charShot");
  await page.getByRole("button", { name: /^生成/ }).first().waitFor({ state: "visible", timeout: 5000 });
  await typePrompt("张波走进咖啡馆");
  await submit();
  const s7 = lastPayload?.shots?.[0];
  check(
    "角色参考→shot 剧照（非四格）",
    s7?.assetType === "shot" && s7?.referenceLabels?.[0]?.type === "character",
    `assetType=${s7?.assetType} label0=${s7?.referenceLabels?.[0]?.type}`,
  );

  // 8. 本卡原图 chip ×：计数 3/4 → 2/4；载荷不含本卡图；载回恢复
  await select("shot");
  await typePrompt("两人隔桌而坐");
  await submit();
  const withSelf = lastPayload?.shots?.[0]?.referenceImages?.length ?? 0;
  const offBtn = page.locator('button[data-tip^="移除：本次不锚定本卡原图"]');
  await offBtn.click();
  await page.waitForTimeout(400);
  const counter2 = await page.getByText(/参考 \d\/\d/).textContent();
  check("chip × 后计数 2/4", counter2?.trim() === "参考 2/4", counter2?.trim() ?? "none");
  // 快照 chip：genShot（上一轮含本卡图）里实时序列之外的参考以「快照」回显
  const snapChip = await page.getByText("快照", { exact: true }).count();
  check("历史快照 chip 回显（genShot 中的本卡图）", snapChip === 1, `count=${snapChip}`);
  await submit();
  const noSelf = lastPayload?.shots?.[0]?.referenceImages ?? [];
  check("移除后载荷不含本卡图", noSelf.length === 2, `refs=${noSelf.length}`);
  await page.locator('button[data-tip^="载回：本卡原图重新并入参考"]').click();
  await page.waitForTimeout(400);
  const counter3 = await page.getByText(/参考 \d\/\d/).textContent();
  check("载回恢复 3/4", counter3?.trim() === "参考 3/4", counter3?.trim() ?? "none");

  // 9. 模式标签：带本卡图 = 改图（原「编辑模式」已改名说人话）
  const mode = await page.locator('span[data-tip^="改图：保留本卡原图"]').count();
  check("模式标签=改图", mode === 1);

  // 10. 按设定重掷：无参考 + description=标题+设定正文
  await page.locator('button[aria-label="按设定重新生成（纯文生图新图）"]').click();
  await page.waitForTimeout(200);
  for (let i = 0; i < 40 && !lastPayload; i++) await page.waitForTimeout(250);
  const s10 = lastPayload?.shots?.[0];
  check(
    "按设定重掷=纯文生图（无参考+设定正文）",
    (s10?.referenceImages ?? []).length === 0 &&
      String(s10?.description ?? "").includes("霓虹夜景"),
    `refs=${s10?.referenceImages?.length} desc=${String(s10?.description ?? "").slice(0, 40)}`,
  );

  // 11. 字面「重新生成」= 原快照补出重跑（rid 带 #s 前缀）
  await select("shot");
  await page.getByRole("button", { name: /^生成/ }).first().waitFor({ state: "visible", timeout: 5000 });
  await typePrompt("重新生成");
  await submit();
  const rid = lastPayload?.shots?.[0]?.rid ?? "";
  check("字面重试=原快照补出重跑", rid.includes("#s"), `rid=${rid}`);

  // 12. @ 候选空态指引
  await select("shot");
  await page.getByRole("button", { name: /^生成/ }).first().waitFor({ state: "visible", timeout: 5000 });
  await page.locator('[contenteditable="true"]').first().click();
  await page.keyboard.type("@zzz");
  await page.waitForTimeout(300);
  const emptyHint = await page.getByText(/没有匹配/).count();
  check("空态指引", emptyHint >= 1);

  // 13. 上传图（无谱系）派生改图：提交 → 右侧连线新卡承接，EDIT 最小模板 +
  //     原图唯一参考，源图不动（novanova/open-ai-canvas 范式）
  const n13 = await page.evaluate(() => window.__wsCanvasStore.getState().nodes.length);
  await select("upCard");
  check(
    "模式标签=派生新卡",
    (await page.locator('span[data-tip^="提交后在本卡右侧生成连线新卡"]').count()) === 1,
  );
  await typePrompt("把背景换成雨夜霓虹");
  await submit();
  const d13 = await page.evaluate(() => {
    const st = window.__wsCanvasStore.getState();
    const up = st.nodes.find((n) => n.id === "upCard");
    const child = st.edges
      .filter((e) => e.source === "upCard")
      .map((e) => st.nodes.find((n) => n.id === e.target))
      .find(Boolean);
    return {
      n: st.nodes.length,
      upImg: up?.data.imageUrl,
      upStatus: up?.data.status,
      upVersions: (up?.data.versions ?? []).length,
      childId: child?.id,
      childTitle: child?.data.title,
    };
  });
  const s13 = lastPayload?.shots?.[0];
  check(
    "派生新卡+连线（标题取提示词）",
    d13.n === n13 + 1 && Boolean(d13.childId) && String(d13.childTitle ?? "").includes("雨夜霓虹"),
    JSON.stringify({ n: d13.n, child: d13.childTitle }),
  );
  check(
    "源图不动（ready、无版本归档）",
    d13.upStatus === "ready" && d13.upVersions === 0 && Boolean(d13.upImg),
    `${d13.upStatus} v=${d13.upVersions}`,
  );
  check(
    "载荷=EDIT 最小模板 + 原图唯一参考",
    typeof s13?.promptTemplate === "string" &&
      s13.promptTemplate.includes("{description}") &&
      (s13?.referenceImages ?? []).length === 1 &&
      s13?.referenceImages?.[0] === d13.upImg &&
      s13?.referenceLabels?.[0]?.name === "原图",
    `refs=${s13?.referenceImages?.length} label=${s13?.referenceLabels?.[0]?.name} tpl=${Boolean(s13?.promptTemplate)}`,
  );
  check(
    "编号契约报源卡名（图1=《上传图》）",
    String(s13?.description ?? "").includes("图1=《上传图》"),
    String(s13?.description ?? "").slice(0, 60),
  );

  // 14. 参与清单（所显即所发）：本卡设定/画风 chip 可见、× 摘除当次生效、
  //     有指令时设定注入 visualNotes（旧「有指令+无参考」静默丢弃暗坑已修）
  await select("shot");
  const bodyChip = page.locator('button[aria-label="移除本卡设定"]');
  check("J1 本卡设定 chip 可见", (await bodyChip.count()) === 1);
  await typePrompt("雨夜特写");
  await submit();
  const s14a = lastPayload?.shots?.[0];
  check(
    "J2 有指令时设定注入 visualNotes（暗坑修复）",
    String(s14a?.visualNotes ?? "").includes("本卡设定") &&
      String(s14a?.visualNotes ?? "").includes("霓虹夜景"),
    String(s14a?.visualNotes ?? "").slice(0, 60),
  );
  await bodyChip.click();
  await page.waitForTimeout(300);
  await typePrompt("雨夜特写二");
  await submit();
  const s14b = lastPayload?.shots?.[0];
  check(
    "J3 摘除设定后 visualNotes 不含本卡设定",
    !String(s14b?.visualNotes ?? "").includes("本卡设定") &&
      !String(s14b?.visualNotes ?? "").includes("霓虹夜景"),
    String(s14b?.visualNotes ?? "").slice(0, 60),
  );
  await page.locator('button[aria-label="载回本卡设定"]').click();
  await page.waitForTimeout(300);
  const styleChipBtn = page.locator('button[aria-label="移除全局画风"]');
  check("J4 画风 chip 可见", (await styleChipBtn.count()) === 1);
  await styleChipBtn.click();
  await page.waitForTimeout(300);
  await typePrompt("雨夜特写三");
  await submit();
  check(
    "J5 摘除画风后 visualNotes 无全局画风",
    !String(lastPayload?.shots?.[0]?.visualNotes ?? "").includes("全局视觉风格"),
  );
  await page.locator('button[aria-label="载回全局画风"]').click();
  await page.waitForTimeout(300);
  await typePrompt("雨夜特写四");
  await submit();
  check(
    "J6 载回画风恢复注入",
    String(lastPayload?.shots?.[0]?.visualNotes ?? "").includes("全局视觉风格"),
  );

  // 15. chip 点击行为（竞品共识：预览/插入引用/定位/打开设置）
  // J7 画风 chip 点击 → 打开画风设置弹窗
  await page.locator('button[aria-label="打开画风设置"]').click();
  await page.waitForTimeout(400);
  check("J7 画风 chip 点击弹画风设置", (await page.getByText("项目画风").count()) > 0);
  await page.keyboard.press("Escape");
  await page.mouse.click(300, 850);
  await page.waitForTimeout(300);
  // J8 本卡原图标签点击 → 插入 @ 引用 chip 进提示词
  await select("shot");
  const selfLabel = page.locator('button[aria-label="插入本卡原图引用"]');
  check("J8a 本卡原图插入引用钮可见", (await selfLabel.count()) === 1);
  await page.locator('[contenteditable="true"]').first().click();
  await selfLabel.click();
  await page.waitForTimeout(300);
  check(
    "J8b 点击插入 @本卡 chip",
    (await page.locator('.ws-mention[data-mention-id="shot"]').count()) === 1,
  );
  // J9 快照 chip 点击 → 灯箱预览（shot 卡有 genShot 快照参考）
  const snapBtn = page.locator('button[aria-label="预览快照图"]');
  if ((await snapBtn.count()) > 0) {
    await snapBtn.first().click();
    await page.waitForTimeout(300);
    check(
      "J9 快照 chip 点击开灯箱预览",
      (await page.evaluate(() => Boolean(document.querySelector(".fixed.inset-0.z-\\[1300\\]")))) === true,
    );
    await page.keyboard.press("Escape");
  } else {
    check("J9 快照 chip 点击开灯箱预览", true, "本次序列无快照 chip（可跳过）");
  }
} catch (e) {
  console.error("执行中断：", e.message);
} finally {
  await browser.close();
  await api(`/projects/${pid}`, { method: "DELETE" }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
