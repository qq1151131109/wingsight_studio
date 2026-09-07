/**
 * E2E：附件上传中发送不被静默丢弃（ChatInput submit 的 stale attachments 闭包回归）。
 * 场景复刻 2026-09-07 霸王龙项目事故：用户传图未等「上传中」消失就按 Enter——
 * submit await 完上传后仍读点击帧的闭包快照（status=uploading 三分支全不匹配），
 * 附件被丢、消息降级纯文本，agent 一张图都收不到（连发五次全中）。
 * 手法：route 把 /agent-service/assets 响应延迟 3s 制造竞态窗，Enter 发送
 * （发送按钮 disabled 会被 Playwright 动作性检查等过窗口，必须走 Enter——
 * 编辑器 onSubmit 无 uploading 闸，正是用户真实路径）。
 * 断言：落库用户消息带 WS_PARTS 多模态 envelope + 气泡图片缩略图可见。
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

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addInitScript((t) => t && localStorage.setItem("wingsight_studio_token", t), TOKEN);
const page = await ctx.newPage();
// 上传响应延迟 3s（制造「上传中点发送」的竞态窗口）
await page.route("**/agent-service/assets**", async (route) => {
  await new Promise((ok) => setTimeout(ok, 3000));
  const resp = await route.fetch();
  await route.fulfill({ response: resp });
});
await page.goto(`${BASE}/project/${pid}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(6000);
const asideVisible = await page.locator("aside").first().isVisible().catch(() => false);
if (!asideVisible) {
  await page.locator('button[aria-label="打开画布助手"]').click();
  await page.waitForTimeout(1500);
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const fileInput = page.locator("aside input[type=file]").first();
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
console.log(`落库用户消息: ${ok ? "✓ 带 WS_PARTS 多模态 envelope（附件没丢）" : "✗ 纯文本（附件被丢）"}`);
console.log("content 头 120 字:", String(last?.content ?? "").slice(0, 120));
// 用户气泡里媒体缩略图可见（前端渲染链路）
const thumb = await page.locator("aside img[alt='附件']").first().isVisible().catch(() => false);
console.log("气泡图片缩略图:", thumb ? "✓" : "✗");
await browser.close();
await api(`/projects/${pid}`, { method: "DELETE" });
console.log("已清理", pid);
process.exit(ok ? 0 : 1);
