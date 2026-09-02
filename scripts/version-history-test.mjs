/**
 * E2E 回归：版本历史弹窗（NodeMediaHistory master-detail 重设计）。
 * 历史事故：弹窗原是节点树内裸 fixed 定位，被 React Flow viewport transform
 * 劫持——宽度被钉死在卡宽、缩略图 144×96、对比区 h-72 竖图全是黑边。
 * 重设计后经 OverlayModal portal 到 body，左大图（contain 跟比例）+ 右版本
 * 列表 + A/B 滑杆进主预览区。本脚本锁住：
 *  - portal 生效：弹窗宽度远大于卡宽（≥720px）
 *  - 列表三行（当前/V2/V1）、竖图预览撑满高度
 *  - 选行切换预览与提示词、A/B 对比开关、设为当前回滚（store 断言）
 *  - Esc 关闭
 * 前置：前端(8008) 在跑（纯前端状态，agent 只用于建项目）。
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

/** 竖图 9:16 占位（带版本号大字），data URL 不碰 agent 静态目录 */
const svg = (label, bg) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="${bg}"/><text x="360" y="620" font-size="180" fill="white" text-anchor="middle" font-family="sans-serif">${label}</text><text x="360" y="800" font-size="64" fill="rgba(255,255,255,.75)" text-anchor="middle" font-family="sans-serif">720x1280</text></svg>`,
  );
const IMG_V1 = svg("V1", "#4a3f35");
const IMG_V2 = svg("V2", "#6b4a2f");
const IMG_CUR = svg("V3", "#2f4a5a");

// ---------- 测试项目 + 带两个历史版本的图片卡 ----------
const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-verhist-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;

await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    nodes: [
      {
        id: "e2e_ver_img",
        type: "image",
        position: { x: 0, y: 0 },
        data: {
          nodeType: "image",
          title: "镜头 02 图",
          imageUrl: IMG_CUR,
          genPrompt: "当前版本提示词：倀子领首者猛然仰头，面庞剧烈扭曲，双眼怒睁奋力呐喊。",
          versions: [
            { url: IMG_V1, at: "09-01 18:12", prompt: "V1 提示词：夜色中火把队列远去，火星划出弧线。" },
            { url: IMG_V2, at: "09-02 07:05", prompt: "V2 提示词：火光中的仰头呐喊，面部剧烈扭曲。" },
          ],
        },
      },
    ],
    edges: [],
    viewport: { x: 60, y: 60, zoom: 1 },
  }),
});

// ---------- 浏览器 ----------
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
if (TOKEN)
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["wingsight_studio_token", TOKEN],
  );
const page = await context.newPage();
const shot = (name) => page.screenshot({ path: new URL(`./verhist-${name}.png`, import.meta.url).pathname });
try {
  await page.goto(`${BASE}/project/${pid}`);
  await page.locator('img[alt="镜头 02 图"]').first().waitFor({ state: "visible", timeout: 15000 });

  // 悬浮卡面出角标操作条，点 V 徽标开弹窗
  await page.locator('img[alt="镜头 02 图"]').first().hover();
  await page.locator('[aria-label^="版本历史"]').first().click();
  await page.getByText("版本历史 · 镜头 02 图").waitFor({ state: "visible", timeout: 5000 });
  await page.waitForTimeout(400);

  // 1. portal 生效：弹窗宽度远超卡宽（旧 bug 是被钉死在卡宽 ~300px）
  const modalBox = await page
    .locator("div", { has: page.getByText("版本历史 · 镜头 02 图") })
    .last()
    .evaluate((el) => {
      const host = el.closest(".max-w-5xl") ?? el;
      const r = host.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
  check("弹窗宽度脱离卡宽（portal 生效）", modalBox.w >= 720, `w=${Math.round(modalBox.w)}`);

  // 2. 列表三行 + 竖图预览撑满高度
  for (const label of ["当前", "V2", "V1"]) {
    const n = await page.locator("button", { hasText: new RegExp(`^${label}`) }).count();
    check(`列表行「${label}」存在`, n >= 1);
  }
  const preview = await page.evaluate(() => {
    const img = document.querySelector(".max-w-5xl .bg-black img");
    if (!img) return null;
    const r = img.getBoundingClientRect();
    return { h: Math.round(r.height), w: Math.round(r.width), natural: img.naturalWidth };
  });
  check("竖图预览按比例撑满高度（≥420px）", !!preview && preview.h >= 420 && preview.natural > 0,
    preview ? `${preview.w}x${preview.h}` : "no img");
  await shot("default");

  // 3. 默认态：当前版本 → 主按钮为禁用「当前版本」
  const curBtnDisabled = await page.getByRole("button", { name: "当前版本", exact: true }).isDisabled();
  check("默认选中当前版，主按钮禁用", curBtnDisabled);

  // 4. 选 V2 行：预览与提示词切换
  await page.locator("button", { hasText: /^V2/ }).first().click();
  await page.waitForTimeout(300);
  const v2Shown = await page.evaluate(() => {
    const img = document.querySelector(".max-w-5xl .bg-black img");
    return img ? img.src.includes("6b4a2f") : false;
  });
  check("选行切换预览（V2 图）", v2Shown);
  const promptTxt = await page.getByText("V2 提示词：火光中的仰头呐喊").count();
  check("提示词跟随选中版本", promptTxt >= 1);
  const restoreVisible = await page.getByRole("button", { name: "设为当前版本" }).isVisible();
  check("历史版出现「设为当前版本」主按钮", restoreVisible);
  await shot("selected");

  // 5. A/B 对比：开关后双图 + 滑杆出现，预览区高度跟住
  await page.getByRole("button", { name: "与当前版本对比" }).click();
  await page.waitForTimeout(400);
  const ab = await page.evaluate(() => {
    const host = document.querySelector(".max-w-5xl .bg-black .cursor-ew-resize");
    if (!host) return null;
    const imgs = host.querySelectorAll("img");
    const r = host.getBoundingClientRect();
    return { imgs: imgs.length, h: Math.round(r.height), w: Math.round(r.width) };
  });
  check("A/B 对比双图滑杆出现在主预览区", !!ab && ab.imgs === 2 && ab.h >= 420,
    ab ? `${ab.imgs}图 ${ab.w}x${ab.h}` : "no host");
  await shot("compare");

  // 6. 设为当前：回滚 + store 断言（与 Lightbox.restoreVersion 同契约）
  await page.getByRole("button", { name: "设为当前版本" }).click();
  await page.waitForTimeout(500);
  const closed = (await page.getByText("版本历史 · 镜头 02 图").count()) === 0;
  check("回滚后弹窗关闭", closed);
  const store = await page.evaluate(() => {
    const st = window.__wsCanvasStore?.getState();
    const n = st?.nodes?.find((x) => x.id === "e2e_ver_img");
    return n
      ? {
          cur: n.data.imageUrl?.includes("4a3f35") ? "V1" : n.data.imageUrl?.includes("6b4a2f") ? "V2" : "V3",
          vCount: (n.data.versions ?? []).length,
          prompt: String(n.data.genPrompt ?? "").slice(0, 6),
        }
      : null;
  });
  check("主图切到 V2、旧当前入档（versions=2）", store?.cur === "V2" && store?.vCount === 2,
    store ? `cur=${store.cur} versions=${store.vCount}` : "no node");
  check("genPrompt 随回滚切换", (store?.prompt ?? "").startsWith("V2 提示"), store?.prompt);

  // 7. 重开：点预览进灯箱，Esc 先关灯箱（弹窗保留），再 Esc 关弹窗
  await page.locator('img[alt="镜头 02 图"]').first().hover();
  await page.locator('[aria-label^="版本历史"]').first().click();
  await page.getByText("版本历史 · 镜头 02 图").waitFor({ state: "visible", timeout: 5000 });
  await page.locator(".max-w-5xl .bg-black img").first().click();
  await page.getByText("滚轮缩放 · 拖拽平移").waitFor({ state: "visible", timeout: 5000 });
  check("点预览进灯箱看原尺寸", true);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const lbClosed = (await page.getByText("滚轮缩放 · 拖拽平移").count()) === 0;
  const modalKept = (await page.getByText("版本历史 · 镜头 02 图").count()) > 0;
  check("灯箱 Esc 只关灯箱、弹窗保留", lbClosed && modalKept);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Esc 关闭弹窗", (await page.getByText("版本历史 · 镜头 02 图").count()) === 0);
} catch (e) {
  await shot("fail").catch(() => {});
  console.error("执行中断：", e.message);
} finally {
  await browser.close();
  await api(`/projects/${pid}`, { method: "DELETE" }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
