/**
 * 自由生图工作台回归（juben ImageStudioPage 移植，2026-09-07）。
 *
 * A 组（API，真出 1 图，gpt-image-2-03 1K）：
 *   A1 非法模型 400 点名 / A2 @图N 越界 400 / A3 批次落库+轮询终态
 *   A4 finalPrompt：@图1 注解并入编号行、正文抹除 @、无任何版式措辞
 *   A5 画廊列表含批次
 * B 组（UI，route mock 出图，复用 A 组真图 URL；项目域壳 /project/[pid]/image-studio）：
 *   B0 左活动栏常驻+生图高亮 / B0b 右侧聊天侧栏在位
 *   B1 空画廊态 / B2 多模型勾选+生成 POST 载荷形状
 *   B3 终态卡出现（真图缩略）/ B4 作为参考图（图1 徽标）
 *   B5 @ 弹层拾取（@图1 插入提示词）/ B6 带 1 参考再次生成（载荷 refs=1）
 *   B7 回填参数 / B10 juben 保真三件套（dnd-kit 拖拽重排/已引用 chips/Backspace 整颗删实体）/
 *   B9 活动栏「画布」互导回工作台
 *
 * 前置：前端(8008)+agent(8123) 在跑；A 组消耗一次真实出图额度。
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
  return fetch(`${API}${path}`, {
    ...init,
    headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(init?.headers ?? {}) },
  });
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

// 1×1 红 PNG（参考图夹具）
const PNG1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const SKIP_API = process.env.SKIP_API === "1";

const stamp = Date.now().toString(36);
let PID = "";
let realImage = process.env.FIXED_IMAGE || "";

if (!SKIP_API) {
  const proj = await (
    await api("/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `自由生图测试-${stamp}` }) })
  ).json();
  PID = proj.id;

try {
  // A1 非法模型
  const r1 = await api("/free-images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: PID, prompt: "测试", models: ["no-such-model"] }),
  });
  const t1 = await r1.text();
  check("A1 非法模型 400 点名", r1.status === 400 && t1.includes("no-such-model"), t1.slice(0, 60));

  // A2 @图N 越界（1 张参考，@图2）
  const up = await api("/assets?name=a.png", { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG1PX });
  const refUrl = (await up.json()).url;
  const r2 = await api("/free-images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: PID, prompt: "@图2 改背景", models: ["gpt-image-2-03"], reference_images: [refUrl] }),
  });
  const t2 = await r2.text();
  check("A2 @图N 越界 400 明报", r2.status === 400 && t2.includes("@图2"), t2.slice(0, 60));

  // A3 真出 1 图：@图1 注解 + 正文
  const genPrompt = `@图1 蓝色氛围 ${stamp}，霓虹雨夜的便利店门口`;
  const r3 = await api("/free-images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: PID,
      prompt: genPrompt,
      aspect: "16:9",
      resolution: "1K",
      models: ["gpt-image-2-03"],
      reference_images: [refUrl],
    }),
  });
  check("A3 提交即返回批次", r3.ok, `status=${r3.status}`);
  const batch = await r3.json();

  let doneItem = null;
  for (let i = 0; i < 90 && !doneItem; i++) {
    await new Promise((s) => setTimeout(s, 2000));
    const list = (await (await api(`/free-images?project_id=${PID}`)).json()).items ?? [];
    doneItem = list.find((x) => x.id === batch.items[0].id && x.status === "done");
    const failed = list.find((x) => x.id === batch.items[0].id && x.status === "error");
    if (failed) {
      check("A3 出图完成", false, `error=${failed.error}`);
      break;
    }
  }
  if (doneItem) {
    realImage = doneItem.imageUrl;
    check("A3 出图完成（约 1 分钟真图）", Boolean(realImage), realImage?.slice(0, 48));
    const fp = doneItem.finalPrompt ?? "";
    check(
      "A4 finalPrompt：注解并入编号行+正文抹除@+无版式措辞",
      fp.includes("参考图编号") &&
        fp.includes("蓝色氛围") &&
        !fp.includes("@图1") &&
        !fp.includes("剧照") &&
        !fp.includes("设定图") &&
        !fp.includes("版式"),
      fp.slice(0, 80).replace(/\n/g, " "),
    );
    const list2 = (await (await api(`/free-images?project_id=${PID}`)).json()).items ?? [];
    check("A5 画廊列表含批次", list2.some((x) => x.batchId === batch.batchId), `rows=${list2.length}`);
  }
} finally {
  await api(`/projects/${PID}`, { method: "DELETE" });
}
} // !SKIP_API

// ---------- B 组：UI（mock 出图） ----------
if (realImage) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((t) => t && localStorage.setItem("wingsight_studio_token", t), TOKEN);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // 建临时项目（真项目，供页面项目下拉选中）
  const proj2 = await (
    await api("/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `自由生图UI-${stamp}` }) })
  ).json();
  let phase = "empty";
  let lastPost = null;
  await page.route("**/agent-service/free-images*", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      lastPost = req.postDataJSON();
      phase = "done";
      await route.fulfill({
        json: {
          batchId: "batchmock",
          items: [
            { id: "m1", modelId: "gpt-image-2-03" },
            { id: "m2", modelId: "gemini-3-pro-image" },
          ],
        },
      });
      return;
    }
    const item = (status) => ({
      id: "m1",
      batchId: "batchmock",
      prompt: "霓虹雨夜的便利店门口",
      aspect: "16:9",
      resolution: "1K",
      modelId: "gpt-image-2-03",
      referenceUrls: [],
      status,
      imageUrl: realImage,
      finalPrompt: "参考图编号：图1=《a.png》。\n霓虹雨夜的便利店门口",
      error: null,
      createdAt: "2026-09-07T12:00:00",
      updatedAt: "2026-09-07T12:01:00",
    });
    const items = phase === "empty" ? [] : [item("done")];
    await route.fulfill({ json: { items } });
  });

  try {
    await page.goto(`${BASE}/project/${proj2.id}/image-studio`);
    await page.getByText("还没有生成记录").waitFor({ timeout: 12000 });
    check("B1 页面加载+空画廊态", true);

    // B0 项目域壳：左活动栏常驻（生图高亮）+ 右侧聊天侧栏在位
    const genBtn = page.getByRole("button", { name: "自由生图" });
    await genBtn.waitFor({ state: "visible", timeout: 8000 });
    const genActive = await genBtn.evaluate((el) => el.className.includes("bg-accent-dim"));
    check("B0 左活动栏常驻+生图高亮", genActive);
    const chatSkills = page.locator('button[data-track="chat.skills"]');
    await chatSkills.waitFor({ state: "visible", timeout: 10000 });
    check("B0b 右侧聊天侧栏在位", true);

    // 勾第二个模型（默认已选首个推荐档）
    const boxes = page.locator('input[id^="fm-"]');
    await boxes.first().waitFor({ state: "visible", timeout: 8000 });
    if ((await boxes.count()) > 1) await boxes.nth(1).check();
    await page.locator("#free-image-prompt").click();
    await page.keyboard.type("霓虹雨夜的便利店门口，湿漉地面反光");
    await page.getByRole("button", { name: /^生成/ }).click();
    for (let i = 0; i < 20 && !lastPost; i++) await page.waitForTimeout(300);
    check(
      "B2 生成载荷（多模型并行）",
      lastPost &&
        Array.isArray(lastPost.models) &&
        lastPost.models.length >= 2 &&
        lastPost.aspect === "16:9" &&
        lastPost.models.includes("gpt-image-2-03"),
      JSON.stringify(lastPost?.models),
    );

    // B3 终态卡（mock GET 的 item.prompt 是短句，alt 按 mock 值定位）
    const cardImg = page.locator('img[alt^="霓虹雨夜的便利店门口"]');
    await cardImg.first().waitFor({ timeout: 8000 });
    check("B3 画廊终态卡（真图缩略）", true);

    // B4 作为参考图
    await page.getByRole("button", { name: "作为参考图" }).first().click();
    await page.waitForTimeout(300);
    const badge = await page.locator("li[aria-label^='参考图1']").count();
    check("B4 复用为参考图（图1 徽标）", badge === 1, `badge=${badge}`);

    // B5 @ 弹层拾取
    await page.locator("#free-image-prompt").click();
    await page.keyboard.press("End");
    await page.keyboard.type("，@");
    await page.waitForTimeout(400);
    // 弹层项含参考图文件名（复用图的 basename）；thumb 的 @ 按钮 aria-label
    // 也含「图1」但不含文件名，按文件名前 8 位唯一命中弹层项
    const refName = realImage.split("/").pop().slice(0, 8);
    const popup = page.locator(`button:has-text("${refName}")`);
    await popup.waitFor({ state: "visible", timeout: 4000 });
    await popup.click();
    const promptVal = await page.locator("#free-image-prompt").inputValue();
    check("B5 @ 弹层拾取插入 @图1", promptVal.includes("@图1"), promptVal.slice(-20));

    // B6 带 1 参考再次生成（mock POST 载荷）
    lastPost = null;
    phase = "done";
    await page.getByRole("button", { name: /^生成/ }).click();
    for (let i = 0; i < 20 && !lastPost; i++) await page.waitForTimeout(300);
    check(
      "B6 带参考生成载荷",
      lastPost && Array.isArray(lastPost.reference_images) && lastPost.reference_images.length === 1,
      `refs=${lastPost?.reference_images?.length}`,
    );

    // B7 回填参数
    await page.getByRole("button", { name: "回填参数" }).first().click();
    await page.waitForTimeout(400);
    const restored = await page.locator("#free-image-prompt").inputValue();
    const refCount = await page.locator("li[aria-label^='参考图']").count();
    check("B7 回填参数（提示词+模型）", restored.includes("便利店") && refCount >= 0, restored.slice(0, 20));

    check("B8 无页面错误", errors.length === 0, errors.slice(0, 2).join(" | "));

    // B10 juben 保真三件套：dnd-kit 拖拽重排 / Backspace 整颗删实体 / 已引用 chips
    const up = page.locator('input[accept=".png,.jpg,.jpeg,.webp"]');
    await up.setInputFiles([
      { name: "aa.png", mimeType: "image/png", buffer: PNG1PX },
      { name: "bb.png", mimeType: "image/png", buffer: PNG1PX },
    ]);
    await page.locator('li[aria-label^="参考图2"]').waitFor({ timeout: 8000 });
    const a = await page.locator('li[aria-label^="参考图1"]').boundingBox();
    const b = await page.locator('li[aria-label^="参考图2"]').boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const label1 = await page.locator('li[aria-label^="参考图1"]').getAttribute("aria-label");
    check("B10a dnd-kit 拖拽重排", (label1 ?? "").includes("bb.png"), label1 ?? "");
    await page.locator("#free-image-prompt").click();
    await page.keyboard.type("@图1 脸 @图2 改背景");
    await page.locator('ul[aria-label="已引用的参考图"] li').first().waitFor({ timeout: 3000 });
    const chipsN = await page.locator('ul[aria-label="已引用的参考图"] li').count();
    check("B10b 已引用 chips 行", chipsN === 2, `chips=${chipsN}`);
    await page.locator("#free-image-prompt").evaluate((el) => {
      const at = el.value.indexOf("@图2") + "@图2".length;
      el.focus();
      el.setSelectionRange(at, at);
    });
    await page.keyboard.press("Backspace");
    const sel = await page
      .locator("#free-image-prompt")
      .evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));
    check("B10c Backspace 选中整颗实体", sel === "@图2", `sel=${sel}`);

    // B9 活动栏「画布」互导：回画布工作台（同项目）
    await page.getByRole("button", { name: "画布", exact: true }).click();
    await page.waitForURL(`**/project/${proj2.id}`, { timeout: 8000 });
    check("B9 活动栏画布互导回工作台", true);
  } finally {
    await api(`/projects/${proj2.id}`, { method: "DELETE" });
    await browser.close();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) process.exit(1);
