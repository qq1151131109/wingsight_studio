/**
 * @ 体系补缺回归（2026-09-08）：文档落卡 / 分镜表·调研卡进候选 / 聊天上传进素材库 /
 * 素材库拖入输入条建卡+引用。
 * 前置：agent(8123) + 前端(8008) 在跑；无 LLM（不发送消息）。
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { zipSync, strToU8 } from "fflate";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;

function envLocal(key) {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf-8").split("\n")) {
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

const { body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-mention-gaps-${Date.now()}` }),
});
const pid = proj.id ?? proj.project?.id;

// 画布预置：分镜表 + 调研卡 + 文本卡（验证候选分组）
await api(`/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    nodes: [
      { id: "SL_1", type: "shotlist", position: { x: 0, y: 0 },
        data: { nodeType: "shotlist", title: "第01集·分镜表", body: "", rows: [{ rid: "r1", action: "开场", shotSize: "全景" }] } },
      { id: "RS_1", type: "research", position: { x: 600, y: 0 },
        data: { nodeType: "research", title: "白骨精考据卷宗", body: "卷宗正文", researchId: "abc123456789" } },
      { id: "NOTE_1", type: "note", position: { x: 1200, y: 0 },
        data: { nodeType: "note", title: "普通文本卡", body: "正文" } },
      { id: "IMG_1", type: "image", position: { x: 1200, y: 400 },
        data: { nodeType: "image", title: "测试图卡", body: "", imageUrl: "/agent-service/assets/aaaa0000bbbb.png", status: "ready" } },
    ],
    edges: [],
    viewport: { x: 40, y: 40, zoom: 0.6 },
  }),
});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
if (TOKEN)
  await ctx.addInitScript(([k, v]) => window.localStorage.setItem(k, v), ["wingsight_studio_token", TOKEN]);
const page = await ctx.newPage();
await page.goto(`${BASE}/project/${pid}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
if (!(await page.locator("aside").first().isVisible().catch(() => false))) {
  await page.locator('button[aria-label="打开画布助手"]').click();
  await page.waitForTimeout(1500);
}

try {
  // ---------- G1: @ 候选含分镜表 / 调研卡分组 ----------
  const ed = page.locator(".ws-mention-input").first();
  await ed.click();
  await page.keyboard.type("@");
  await page.waitForTimeout(600);
  const tabs = await page.locator('button[aria-label^="分组"]').allInnerTexts();
  const tabText = tabs.join(" | ");
  check("G1a @ 候选出现「分镜表」组", /分镜表/.test(tabText), tabText.slice(0, 120));
  check("G1b @ 候选出现「调研」组", /调研/.test(tabText), tabText.slice(0, 120));
  // 选中调研卡（切到调研组 → 拾取）
  const researchTab = page.locator('button[aria-label="分组 调研 1"]');
  if (await researchTab.count()) {
    await researchTab.click();
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
  }
  const chipText = await page.locator(".ws-mention-input [data-mention-id]").first().innerText().catch(() => "");
  check("G1c 调研卡可拾取为 chip", /卷宗|考据/.test(chipText), chipText.trim());
  // 清掉 chip，避免影响后续
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);

  // ---------- G2: 上传 .txt → 自动建资料卡 ----------
  const docBody = "这是一份上传的资料：白骨精在典籍中的记载。".repeat(20);
  await page.locator("aside input[type=file]").first().setInputFiles([
    { name: "白骨精资料.txt", mimeType: "text/plain", buffer: Buffer.from(docBody, "utf-8") },
  ]);
  await page.waitForTimeout(4000);
  const { body: canvas1 } = await api(`/projects/${pid}/canvas`);
  const docCard = (canvas1.nodes ?? []).find((n) => (n.data?.title ?? "").includes("白骨精资料"));
  check(
    "G2a 上传文档自动建资料卡（标题=文件名）",
    Boolean(docCard) && docCard.data.nodeType === "note",
    docCard ? `${docCard.data.nodeType} / ${docCard.data.title}` : "未建卡",
  );
  check(
    "G2b 资料卡正文=提取全文",
    Boolean(docCard) && (docCard.data.body ?? "").includes("白骨精在典籍中的记载"),
    `正文 ${(docCard?.data?.body ?? "").length} 字`,
  );

  // ---------- G3: 上传图片 → 进素材库 ----------
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.locator("aside input[type=file]").first().setInputFiles([
    { name: "库图验证.png", mimeType: "image/png", buffer: png },
  ]);
  await page.waitForTimeout(4500);
  const { body: assets } = await api(`/projects/${pid}/assets`);
  const hit = (assets.assets ?? assets ?? []).find((a) => (a.title ?? "").includes("库图验证"));
  check("G3 聊天上传的图片进素材库", Boolean(hit), hit ? `${hit.kind} ${hit.url?.slice(0, 40)}` : "未入库");

  // ---------- G4: 素材库拖入聊天输入条 → 建卡 + 引用 chip ----------
  const before = ((await api(`/projects/${pid}/canvas`)).body.nodes ?? []).length;
  const dropped = await page.evaluate(() => {
    const box = document.querySelector(".copilotKitInputContainer");
    if (!box) return "no-container";
    const dt = new DataTransfer();
    dt.setData(
      "application/x-ws-asset-ref",
      JSON.stringify({ kind: "image", url: "/agent-service/assets/deadbeef0001.png", title: "拖入库图" }),
    );
    box.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return "dispatched";
  });
  await page.waitForTimeout(2600); // 画布 PUT debounce 1.2s + 网络余量
  const { body: canvas2 } = await api(`/projects/${pid}/canvas`);
  const after = (canvas2.nodes ?? []).length;
  const dragCard = (canvas2.nodes ?? []).find((n) => (n.data?.title ?? "") === "拖入库图");
  check(
    "G4a 库项拖入聊天 → 建媒体卡",
    Boolean(dragCard) && after === before + 1,
    `节点 ${before}→${after}${dragCard ? ` / ${dragCard.data.nodeType}` : ""}`,
  );
  const chip2 = await page.locator(".ws-mention-input [data-mention-id]").allInnerTexts().catch(() => []);
  check("G4b 拖入后输入条出现引用 chip", chip2.some((t) => /拖入库图/.test(t)), chip2.join(" | ").slice(0, 80));
  console.log(`   (drop 派发: ${dropped})`);

  // ---------- G5: 素材库拖入画布面板（NodeInputPanel）→ 就近建卡 + 参考 chip ----------
  // 用图片卡的面板：文本卡（kind=text）本来就没有参考 chip 行
  await page.locator('[data-id="IMG_1"]').first().click();
  await page.waitForTimeout(700);
  const panel = page.locator(".ws-detail.absolute.z-10").first();
  const panelVisible = await panel.isVisible().catch(() => false);
  if (panelVisible) {
    const refBefore = await panel.locator('.ws-mention-input [data-mention-id]').count();
    const before5 = ((await api(`/projects/${pid}/canvas`)).body.nodes ?? []).length;
    await panel.evaluate((el) => {
      const dt = new DataTransfer();
      dt.setData(
        "application/x-ws-asset-ref",
        JSON.stringify({ kind: "image", url: "/agent-service/assets/feedface0002.png", title: "面板拖入图" }),
      );
      el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await page.waitForTimeout(2600);
    const { body: canvas3 } = await api(`/projects/${pid}/canvas`);
    const after5 = (canvas3.nodes ?? []).length;
    const panelCard = (canvas3.nodes ?? []).find((n) => (n.data?.title ?? "") === "面板拖入图");
    check(
      "G5a 库项拖入画布面板 → 就近建媒体卡",
      Boolean(panelCard) && after5 === before5 + 1,
      `节点 ${before5}→${after5}${panelCard ? ` / ${panelCard.data.nodeType}` : ""}`,
    );
    const refAfter = await panel.locator('.ws-mention-input [data-mention-id]').count();
    check("G5b 面板 @ 引用 chip +1", refAfter === refBefore + 1, `${refBefore} → ${refAfter}`);
  } else {
    check("G5 画布面板未打开（跳过）", false, "NodeInputPanel 未出现");
  }

  // ---------- G6: .docx 走服务端提取 → 落资料卡 ----------
  const DOCX_TEXT = "这是 docx 资料正文：官渡之战兵力考证。";
  const docx = Buffer.from(
    zipSync({
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${DOCX_TEXT}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    }),
  );
  await page.locator("aside input[type=file]").first().setInputFiles([
    {
      name: "官渡考证.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: docx,
    },
  ]);
  await page.waitForTimeout(5000);
  const { body: canvasDocx } = await api(`/projects/${pid}/canvas`);
  const docxCard = (canvasDocx.nodes ?? []).find((n) => (n.data?.title ?? "") === "官渡考证");
  check(
    "G6 docx 走服务端提取并落资料卡",
    Boolean(docxCard) && (docxCard.data.body ?? "").includes(DOCX_TEXT),
    docxCard ? `正文 ${(docxCard.data.body ?? "").length} 字` : "未建卡",
  );

  // ---------- G7: 大文本（≈150KB，超过旧 64KB 上限）→ 落卡且正文不截断 ----------
  const BIG = "大文本压测段落：白骨精在典籍中的记载。".repeat(6000) + "【结尾标记】";
  await page.locator("aside input[type=file]").first().setInputFiles([
    { name: "大剧本.txt", mimeType: "text/plain", buffer: Buffer.from(BIG, "utf-8") },
  ]);
  await page.waitForTimeout(6000);
  const { body: canvasBig } = await api(`/projects/${pid}/canvas`);
  const bigCard = (canvasBig.nodes ?? []).find((n) => (n.data?.title ?? "") === "大剧本");
  check(
    "G7 大文本落卡（正文不截断，尾部标记在）",
    Boolean(bigCard) && (bigCard.data.body ?? "").endsWith("【结尾标记】"),
    bigCard ? `正文 ${(bigCard.data.body ?? "").length} 字 / 期望 ${BIG.length}` : "未建卡",
  );

  // ---------- G8: 空文本文件 → 明报错误（不卡在「上传中」被静默丢弃） ----------
  await page.locator("aside input[type=file]").first().setInputFiles([
    { name: "空文件.txt", mimeType: "text/plain", buffer: Buffer.from("", "utf-8") },
  ]);
  await page.waitForTimeout(3000);
  const chips8 = await page.locator(".copilotKitInputContainer span").allInnerTexts().catch(() => []);
  const errChip = chips8.find((t) => t.includes("空文件.txt"));
  check(
    "G8 空文本文件明报失败态",
    Boolean(errChip) && /失败/.test(errChip),
    errChip ? errChip.replaceAll("\n", " ").slice(0, 60) : "未找到 chip",
  );
  const { body: canvasEmpty } = await api(`/projects/${pid}/canvas`);
  check(
    "G8b 空文件不建卡",
    !(canvasEmpty.nodes ?? []).some((n) => (n.data?.title ?? "") === "空文件"),
  );

} finally {
  await browser.close();
  await api(`/projects/${pid}`, { method: "DELETE" });
  console.log("已清理", pid);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exit(1);
