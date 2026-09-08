/**
 * E2E 回归：卡片全屏文档模式（DocFullscreenEditor，2026-09-08）。
 * 覆盖：文本卡/剧本卡工具条「全屏」入口、打开即聚焦光标落文末（续写姿态）、
 * 全屏编辑与卡面正文实时同源（store 单一事实源）、Esc 关闭、落库持久化、
 * 剧本卡衬线/文本卡非衬线、万字长文可用性。
 * 前置：agent(8123) + 前端(8008) 在跑；无 LLM。
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

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

// ---------- 项目 + 文本卡 + 剧本卡 ----------
const { status: pst, body: proj } = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-doc-fullscreen-${Date.now()}` }),
});
if (pst !== 200 && pst !== 201) throw new Error(`建项目失败 ${pst}`);
const pid = proj.id ?? proj.project?.id;
try {
  const NOTE_BODY = "策划草案第一段：定位与观看问题。".repeat(2);
  const SCRIPT_BODY = ["第1场 内景 书房——夜", "关关趴在书桌上写作业，霸王龙蜷在台灯下打盹。"].join("\n");
  await api(`/projects/${pid}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nodes: [
        {
          id: "e2e_doc_note",
          type: "note",
          position: { x: 100, y: 300 },
          data: { nodeType: "note", title: "策划草案", body: NOTE_BODY },
        },
        {
          id: "e2e_doc_script",
          type: "script",
          position: { x: 700, y: 300 },
          data: { nodeType: "script", title: "第一集·剧本", body: SCRIPT_BODY },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }),
  });

  // ---------- 浏览器 ----------
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  if (TOKEN)
    await context.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      ["wingsight_studio_token", TOKEN],
    );
  const page = await context.newPage();
  await page.goto(`${BASE}/project/${pid}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  const modal = page.locator("div.fixed.inset-0.z-\\[1300\\]");
  const modalTa = modal.locator("textarea");
  const cardTextarea = (nodeId) =>
    page.locator(`[data-id="${nodeId}"] textarea`).first();
  const openFullscreen = async (nodeId) => {
    // 选中卡 → 悬浮工具条出现 → 点「全屏」
    await page.locator(`[data-id="${nodeId}"]`).first().click();
    await page.waitForTimeout(400);
    const btn = page.locator('button[aria-label^="全屏写作模式"]').first();
    await btn.click();
    await modal.waitFor({ state: "visible", timeout: 5000 });
  };

  // ---------- D1: 文本卡全屏打开，初始值与光标落文末 ----------
  await openFullscreen("e2e_doc_note");
  const d1 = await modalTa.evaluate((el) => ({ len: el.value.length, sel: el.selectionStart, focused: document.activeElement === el }));
  check(
    "D1 打开即聚焦、光标落文末（续写姿态）",
    d1.focused && d1.sel === d1.len && d1.len === NOTE_BODY.length,
    `focused=${d1.focused} sel=${d1.sel}/${d1.len}`,
  );

  // ---------- D2: 全屏打字 → 卡面正文实时同步（store 同源） ----------
  await modalTa.evaluate(() => document.execCommand("insertText", false, "【追加段】"));
  await page.waitForTimeout(600);
  const cardVal = await cardTextarea("e2e_doc_note").evaluate((el) => el.value);
  check(
    "D2 全屏编辑实时同步卡面正文",
    cardVal.endsWith("【追加段】"),
    `卡面尾部:「${cardVal.slice(-12)}」`,
  );

  // ---------- D3: 字数计数随打字更新 ----------
  const wc = await modal.locator("span.tabular-nums").first().textContent();
  check(
    "D3 头部字数随正文更新",
    wc.includes(`${NOTE_BODY.length + 5} 字`),
    `字数行:「${wc?.trim()}」`,
  );

  // ---------- D4: 文本卡非衬线 ----------
  const noteFont = await modalTa.evaluate((el) => getComputedStyle(el).fontFamily);
  check("D4 文本卡全屏非衬线体", !noteFont.includes("Serif"), noteFont.slice(0, 40));

  // ---------- D5: Esc 关闭 ----------
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("D5 Esc 关闭全屏编辑器", (await modal.count()) === 0);

  // ---------- D6: 剧本卡全屏（scriptTools 入口）+ 衬线体 ----------
  await openFullscreen("e2e_doc_script");
  const scriptFont = await modalTa.evaluate((el) => getComputedStyle(el).fontFamily);
  const d6val = await modalTa.evaluate((el) => el.value);
  check(
    "D6 剧本卡全屏打开（scriptTools 入口）",
    d6val === SCRIPT_BODY,
    `len=${d6val.length}`,
  );
  check("D6b 剧本卡全屏衬线体", scriptFont !== noteFont && /serif/i.test(scriptFont), scriptFont.slice(0, 40));

  // ---------- D7: 万字长文打开可用 ----------
  const LONG = "长文压测段落。画面与声音交替推进，节奏落在句读上。".repeat(400); // ≈1 万字
  await modalTa.evaluate((el, t) => {
    el.value = t; // 直接铺长文进 DOM（store 通道 D2 已验，此处测渲染面）
  }, LONG);
  const t0 = Date.now();
  await modalTa.press("End");
  await modalTa.evaluate(() => document.execCommand("insertText", false, "尾"));
  await page.waitForTimeout(300);
  const longOk = await modalTa.evaluate(
    (el, expectLen) => el.value.length === expectLen,
    LONG.length + 1,
  );
  check(
    "D7 万字长文全屏编辑可用",
    longOk && Date.now() - t0 < 3000,
    `${LONG.length + 1} 字，插入耗时 ${Date.now() - t0}ms`,
  );

  // ---------- D8: 关闭后落库持久化（服务端唯一事实源） ----------
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2200); // 画布 PUT debounce 1.2s
  const { body: canvas } = await api(`/projects/${pid}/canvas`);
  const serverNode = (canvas.nodes ?? []).find((n) => n.id === "e2e_doc_note");
  check(
    "D8 全屏编辑落库持久化",
    (serverNode?.data?.body ?? "").endsWith("【追加段】"),
    `服务端尾部:「${(serverNode?.data?.body ?? "").slice(-10)}」`,
  );

  // ---------- D9: 重开同源（读到服务端/ store 最新值） ----------
  await openFullscreen("e2e_doc_note");
  const d9 = await modalTa.evaluate((el) => el.value);
  check("D9 重开读到最新正文（同源不漂移）", d9.endsWith("【追加段】"), `len=${d9.length}`);
  await page.keyboard.press("Escape");

  await browser.close();
} finally {
  await api(`/projects/${pid}`, { method: "DELETE" });
  console.log("已清理", pid);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) process.exit(1);
