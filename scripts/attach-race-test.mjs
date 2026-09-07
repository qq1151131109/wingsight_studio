/**
 * E2E：附件上传中发送不被静默丢弃（ChatInput submit 的 stale attachments 闭包回归）。
 * 场景复刻 2026-09-07 霸王龙项目事故：用户传图未等「上传中」消失就按 Enter——
 * submit await 完上传后仍读点击帧的闭包快照（status=uploading 三分支全不匹配），
 * 附件被丢、消息降级纯文本，agent 一张图都收不到（连发五次全中）。
 * 手法：route 把 /agent-service/assets 响应延迟 3s 制造竞态窗，Enter 发送
 * （发送按钮 disabled 会被 Playwright 动作性检查等过窗口，必须走 Enter——
 * 编辑器 onSubmit 无 uploading 闸，正是用户真实路径）。
 * 阶段 1：13 张一次拖入不截断（曾拍「一条 6 个」上限把 7 张静默砍掉，已删）。
 * 阶段 2：落库用户消息带 WS_PARTS 多模态 envelope + 气泡图片缩略图可见。
 * 隔离：自建测试项目，真跑一轮 LLM，结束自删。
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
    body: new URLSearchParams({ username: "admin", password: envLocal("AUTH_PASSWORD") }),
  });
  if (r.ok) TOKEN = (await r.json()).access_token;
}
async function api(path, init) {
  return fetch(`${API}${path}`, { ...init, headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(init?.headers ?? {}) } });
}
const proj = await (await api("/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `e2e-attach-race-${Date.now()}` }) })).json();
const pid = proj.id ?? proj.project?.id;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addInitScript((t) => t && localStorage.setItem("wingsight_studio_token", t), TOKEN);
const page = await ctx.newPage();
await page.goto(`${BASE}/project/${pid}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(6000);
const asideVisible = await page.locator("aside").first().isVisible().catch(() => false);
if (!asideVisible) {
  await page.locator('button[aria-label="打开画布助手"]').click();
  await page.waitForTimeout(1500);
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const fileInput = page.locator("aside input[type=file]").first();

// ---------- 阶段 1：批量不截断（曾拍「一条 6 个」上限，13 张静默砍 7 张） ----------
{
  const files = Array.from({ length: 13 }, (_, i) => ({
    name: `bulk-${String(i + 1).padStart(2, "0")}.png`,
    mimeType: "image/png",
    buffer: png,
  }));
  await fileInput.setInputFiles(files);
  await page
    .waitForFunction(
      () => {
        const t = [...document.querySelectorAll("aside .copilotKitInputContainer span")]
          .map((c) => c.textContent || "")
          .join("|");
        return !t.includes("上传中") && !t.includes("失败");
      },
      { timeout: 30000 },
    )
    .catch(() => {});
  const c = await page.evaluate(() => ({
    chips: document.querySelectorAll("aside [aria-label='移除附件']").length,
  }));
  check("13 张拖入不截断", c.chips === 13, `chip=${c.chips}`);
  for (let i = 0; i < c.chips; i++) {
    await page.locator("aside [aria-label='移除附件']").first().click();
  }
  await page.waitForTimeout(300);
}

// ---------- 阶段 2：上传中发送竞态 ----------
// 上传响应延迟 3s（制造「上传中点发送」的竞态窗口）
await page.route("**/agent-service/assets**", async (route) => {
  await new Promise((ok) => setTimeout(ok, 3000));
  const resp = await route.fetch();
  await route.fulfill({ response: resp });
});
await fileInput.setInputFiles([{ name: "race-tuzi.png", mimeType: "image/png", buffer: png }]);
await page.waitForTimeout(200); // chip 已出现、状态=上传中（3s 延迟窗内）
await page.locator(".ws-mention-input").first().click();
await page.keyboard.type("这张图收到了吗");
// 上传中按 Enter 发送（用户真实路径：编辑器 onSubmit 无 uploading 闸，
// 发送按钮 disabled 会被 Playwright 动作性检查等过竞态窗）
await page.keyboard.press("Enter");
console.log("已在上传中按 Enter 发送");
// 等：上传 3s + run + 落库 debounce 1.2s
await page.waitForTimeout(9000);
// 从服务端拉会话消息断言
const threads = await (await api(`/projects/${pid}/threads`)).json();
const tid = threads[0]?.id;
const msgs = await (await api(`/projects/${pid}/threads/${tid}/messages`)).json();
const userMsgs = msgs.filter((m) => m.role === "user");
const last = userMsgs.at(-1);
const ok = last && typeof last.content === "string" && last.content.includes("WS_PARTS::") && last.content.includes("race-tuzi.png");
check("落库消息带 WS_PARTS 多模态 envelope", !!ok, String(last?.content ?? "").slice(0, 90));
// 用户气泡里媒体缩略图可见（前端渲染链路）
const thumb = await page.locator("aside img[alt='附件']").first().isVisible().catch(() => false);
check("气泡图片缩略图可见", thumb);
await browser.close();
await api(`/projects/${pid}`, { method: "DELETE" });
console.log("已清理", pid);
const failed = results.filter((x) => !x.ok).length;
console.log(failed === 0 ? `\n全部 ${results.length} 项通过` : `\n${failed}/${results.length} 项失败`);
process.exit(failed === 0 ? 0 : 1);
