/**
 * 一次性验证：旧 Look 小卡（176×132）→ 标准图片卡尺寸迁移 + 媒体区不越界。
 * 自建测试项目，验证完删除。
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8008";
const API = `${BASE}/agent-service`;
const png1px =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const proj = await fetch(`${API}/projects`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `e2e-look-unify-${Date.now()}` }),
}).then((r) => r.json());
const pid = proj.id;
console.log(`测试项目: ${pid}`);

await fetch(`${API}/projects/${pid}/canvas`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    viewport: { x: 0, y: 0, zoom: 0.6 },
    nodes: [
      { id: "c1", type: "character", position: { x: 0, y: 0 },
        data: { nodeType: "character", title: "陈文乐", status: "ready", imageUrl: png1px } },
      { id: "co1", type: "costume", position: { x: 0, y: 380 },
        data: { nodeType: "costume", title: "庭审西装", status: "ready", imageUrl: png1px } },
      // 旧 Look 小卡：176×132，look1 连角色+服饰（双源），look2 只连角色
      { id: "l1", type: "image", position: { x: 288, y: 0 }, style: { width: 176, height: 132 },
        data: { nodeType: "image", title: "陈文乐·庭审造型", body: "深色西装，领带收紧，眼神疲惫", imageUrl: png1px, status: "ready" } },
      { id: "l2", type: "image", position: { x: 288, y: 168 }, style: { width: 176, height: 132 },
        data: { nodeType: "image", title: "陈文乐·幼年孤儿装", imageUrl: png1px, status: "ready" } },
      // 孤立小卡（无资产连线）：就地放大路径
      { id: "l3", type: "image", position: { x: 700, y: 500 }, style: { width: 176, height: 132 },
        data: { nodeType: "image", title: "普通小图", imageUrl: png1px, status: "ready" } },
    ],
    edges: [
      { id: "e1", source: "c1", target: "l1" },
      { id: "e2", source: "co1", target: "l1" },
      { id: "e3", source: "c1", target: "l2" },
    ],
  }),
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`${BASE}/project/${pid}`);
await page.waitForTimeout(2500);
await page.evaluate(() => window.__wsSetViewport?.({ x: -50, y: -50, zoom: 0.5 }));
await page.waitForTimeout(3500); // 等 debounce 落库

// 1) DOM 断言：图片不越界卡体
const overflow = await page.evaluate(() => {
  const out = [];
  for (const nid of ["l1", "l2", "l3"]) {
    const node = document.querySelector(`[data-id="${nid}"]`);
    const img = node?.querySelector("img");
    if (!node || !img) {
      out.push(`${nid}: 节点或图片未渲染`);
      continue;
    }
    const card = node.querySelector(".ws-card")?.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    if (!card) {
      out.push(`${nid}: 无卡体`);
      continue;
    }
    const outside =
      ir.left < card.left - 1 || ir.right > card.right + 1 ||
      ir.top < card.top - 1 || ir.bottom > card.bottom + 1;
    out.push(`${nid}: ${outside ? "越界" : "ok"} (img ${Math.round(ir.width)}x${Math.round(ir.height)} @${Math.round(ir.top)}, card h=${Math.round(card.height)})`);
  }
  return out;
});
for (const line of overflow) console.log(`  ${line}`);

// 2) 落库断言：尺寸已迁标准 + 同组重铺网格
await new Promise((r) => setTimeout(r, 1500));
const canvas = await fetch(`${API}/projects/${pid}/canvas`).then((r) => r.json());
const get = (id) => (canvas?.nodes ?? []).find((n) => n.id === id);
const sz = (n) => {
  const s = n?.style?.width ? `${n.style.width}x${n.style.height}` : "";
  const wh = n?.width ? ` (w=${n.width},h=${n.height})` : "";
  return `${s}${wh}`;
};
console.log(`  l1=${sz(get("l1"))} l2=${sz(get("l2"))} l3=${sz(get("l3"))}（期望均 256x260）`);
console.log(`  l1@(${get("l1")?.position?.x},${get("l1")?.position?.y}) l2@(${get("l2")?.position?.x},${get("l2")?.position?.y})`);
const overlap =
  Math.abs(get("l1")?.position?.y - get("l2")?.position?.y) < 260 &&
  Math.abs(get("l1")?.position?.x - get("l2")?.position?.x) < 256;
console.log(overlap ? "  l1/l2 网格间距不足（叠压）" : "  l1/l2 无叠压");

await browser.close();
await fetch(`${API}/projects/${pid}`, { method: "DELETE" });
console.log("测试项目已删除");
