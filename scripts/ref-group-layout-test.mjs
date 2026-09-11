/**
 * 「考据参考」组框布局回归（2026-09-11 091102 事故）。
 *
 * 事故两件：① 组内网格行距写死 footprint 高 + gap（224），而图片卡媒体自适应
 * 后高度 121~454 不等（竖图是横图的三倍）→ 高卡压到下一行；② 组框高只按
 * footprint 算、没跟真实卡高 → 末行整排/单卡挂在框外（实测一张连「盛加垟村」
 * 的参考卡越界 190px，用户看到的就是「生成的图没放到分组里」）。
 * 同日用户还拍板：组框**默认展开**（参考图是要核对的原料，收起等于藏起来）。
 *
 * 断言：
 *   A 卡高预估公式（浏览器实测标定：卡高 = 53 + 254 × 图高/图宽）
 *   B 纯函数 packRefGrid：行距 = 该行最高卡 + gapY（高卡不压下一行）
 *   C 纯函数 refGroupSizeFor：包住所有卡 + 内边距
 *   D 采纳落卡：新建组框默认展开、子卡按候选宽高比预估高度、组框包住全部子卡
 *   E 自愈重排：给一个「固定 224 行距 + 竖图」的旧布局 → 重排后无重叠、框包住
 *   F 幂等：无重叠时重排不动位置（只同步组框尺寸）
 *
 * 运行：pnpm dlx tsx scripts/ref-group-layout-test.mjs（tsx 解析 TS 与路径别名）
 */
import {
  adoptRefRows,
  packRefGrid,
  refCardHeight,
  refGroupSizeFor,
  relayoutRefGroup,
} from "../lib/canvas/refAdopt.ts";
import { NODE_FOOTPRINT, useCanvasStore } from "../lib/canvas/store.ts";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

const GRID = { cols: 4, gapX: 28, gapY: 28, padX: 20, padTop: 44, padBottom: 20 };
const FP = NODE_FOOTPRINT.image;

/* ---------- A 卡高预估 ---------- */
{
  const portrait = refCardHeight(800, 1200, FP.h);
  const landscape = refCardHeight(800, 556, FP.h);
  const unknown = refCardHeight(0, 0, FP.h);
  check("A1 竖图（800×1200）预估 ≈ 434", Math.abs(portrait - 434) <= 1, `${portrait}`);
  check(
    "A2 横图（800×556）预估 ≈ 230 且明显矮于竖图",
    Math.abs(landscape - 230) <= 2 && landscape < portrait,
    `${landscape}`,
  );
  check("A3 缺宽高退回 footprint 高", unknown === FP.h, `${unknown}`);
}

/* ---------- B 行式流入 ---------- */
{
  const items = [
    { w: FP.w, h: 230 },
    { w: FP.w, h: 434 }, // 竖图：本行最高的那张
    { w: FP.w, h: 180 },
    { w: FP.w, h: 230 },
    { w: FP.w, h: 230 },
  ];
  const slots = packRefGrid(items);
  const row0 = slots.slice(0, 4);
  const row1 = slots.slice(4);
  check("B1 首行 4 张同 y", row0.every((s) => s.y === GRID.padTop));
  check(
    "B2 行距 = 本行最高卡 + gapY（434+28）",
    row1[0].y === GRID.padTop + 434 + GRID.gapY,
    `y=${row1[0].y}`,
  );
  check("B3 行内 x 按列递进", row0[2].x === GRID.padX + 2 * (FP.w + GRID.gapX));
  // 同列相邻卡不重叠（本行高卡不再压下一行）
  const noOverlap = row1.every((s, i) => s.y >= row0[i].y + 434);
  check("B4 高卡行下方不重叠", noOverlap);
}

/* ---------- C 组框尺寸 ---------- */
{
  const items = [
    { w: FP.w, h: 230 },
    { w: FP.w, h: 434 },
    { w: FP.w, h: 230 },
    { w: FP.w, h: 230 },
    { w: FP.w, h: 300 }, // 第二行唯一一张
  ];
  const slots = packRefGrid(items);
  const placed = slots.map((s, i) => ({ ...s, ...items[i] }));
  const size = refGroupSizeFor(placed);
  const boxedW = placed.every((s) => s.x + s.w + GRID.padX <= size.width);
  const boxedH = placed.every((s) => s.y + s.h + GRID.padBottom <= size.height);
  check("C1 组框宽包容所有列", boxedW, `w=${size.width}`);
  check("C2 组框高包容末行（越界卡事故）", boxedH, `h=${size.height}`);
  check(
    "C3 组框高 = 末行底 + padBottom（不是行数×footprint）",
    size.height === slots[4].y + 300 + GRID.padBottom,
    `${size.height}`,
  );
  check(
    "C4 返回 xyflow 认的 width/height 键（{w,h} 写进 style 等于没改——越界卡根因）",
    size.width !== undefined && size.height !== undefined && size.w === undefined,
  );
}

/* ---------- D 采纳落卡（store 级） ---------- */
function resetCanvas(nodes = [], edges = []) {
  useCanvasStore.setState({
    projectId: "test-refgroup",
    hydrated: true,
    nodes,
    edges,
    dismissedReports: [],
    dismissedTopicRefs: [],
  });
}

{
  resetCanvas();
  const cand = (id, w, h) => ({
    id,
    nodeId: "asset1",
    query: "",
    provider: "serper",
    title: `候选 ${id}`,
    pageUrl: "",
    sourceDomain: "example.com",
    sourceUrl: "",
    assetUrl: `https://img.example.com/${id}.jpg`,
    width: w,
    height: h,
    adopted: true,
    recommended: true,
    recRank: 1,
    recReason: "",
    createdAt: "",
  });
  const assets = [{ id: "asset1", type: "scene", position: { x: 0, y: 0 }, style: { width: 288, height: 214 }, data: { nodeType: "scene", title: "钱库镇老街" } }];
  resetCanvas(assets);
  const created = adoptRefRows([
    { nodeId: "asset1", candidates: [cand("c1", 800, 1200), cand("c2", 800, 556), cand("c3", 800, 1200), cand("c4", 800, 556), cand("c5", 800, 1200)] },
  ]);
  const st = useCanvasStore.getState();
  const group = st.nodes.find((n) => n.data.nodeType === "group" && n.data.refGroup === "research");
  const kids = st.nodes.filter((n) => n.parentId === group?.id);
  check("D1 建出 5 张参考卡", created.length === 5 && kids.length === 5, `${created.length}`);
  check("D2 组框默认展开（collapsed=false）", group?.data.collapsed === false);
  check("D3 子卡不隐藏", kids.every((k) => !k.hidden));
  check(
    "D4 子卡高度按候选宽高比预估（竖图 434 / 横图 230）",
    kids.filter((k) => k.style.height === 434).length === 3 &&
      kids.filter((k) => k.style.height === 230).length === 2,
    kids.map((k) => k.style.height).join(","),
  );
  const groupBox = { w: group.style.width, h: group.style.height };
  const inside = kids.every((k) => k.position.x + k.style.width + GRID.padX <= groupBox.w && k.position.y + k.style.height + GRID.padBottom <= groupBox.h);
  check("D5 组框包住全部子卡", inside, `${groupBox.w}×${groupBox.h}`);
  const firstRowY = Math.min(...kids.map((k) => k.position.y));
  const firstRow = kids.filter((k) => k.position.y === firstRowY);
  check("D6 首行 4 列（第 5 张换行）", firstRow.length === 4, `${firstRow.length}`);
  check(
    "D7 第 5 张落在首行最高卡之下（竖图 434 + gapY）",
    kids.some((k) => k.position.y === firstRowY + 434 + GRID.gapY),
  );
  check("D8 连线：5 张卡都连到资产卡", st.edges.filter((e) => e.target === "asset1").length === 5);
}

/* ---------- E 自愈重排（旧固定行距布局） ---------- */
{
  const nodes = [
    { id: "g1", type: "group", position: { x: 0, y: 0 }, style: { width: 1152, height: 7876 }, data: { nodeType: "group", title: "考据参考", refGroup: "research", collapsed: false, body: "" } },
  ];
  // 旧布局：行距写死 224，第 2 张是竖图（实际 454 高）→ 压住第 5 张
  for (let i = 0; i < 6; i += 1) {
    nodes.push({
      id: `r${i}`,
      type: "image",
      parentId: "g1",
      position: { x: 16 + (i % 4) * 280, y: 44 + Math.floor(i / 4) * 224 },
      style: { width: 256, height: i === 1 ? 454 : 230 },
      data: { nodeType: "image", title: `参考 ${i}`, refSource: "research", status: "ready" },
    });
  }
  resetCanvas(nodes);
  relayoutRefGroup();
  const st = useCanvasStore.getState();
  const group = st.nodes.find((n) => n.id === "g1");
  const kids = st.nodes.filter((n) => n.parentId === "g1");
  const byCol = new Map();
  for (const k of kids) byCol.set(k.position.x, [...(byCol.get(k.position.x) ?? []), k]);
  let overlapped = false;
  for (const list of byCol.values()) {
    list.sort((a, b) => a.position.y - b.position.y);
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].position.y < list[i - 1].position.y + list[i - 1].style.height) overlapped = true;
    }
  }
  check("E1 自愈后同列不再重叠（高卡不再压下一行）", !overlapped);
  check(
    "E2 组框尺寸跟到内容（不再让卡挂框外）",
    kids.every((k) => k.position.y + k.style.height + GRID.padBottom <= group.style.height) &&
      kids.every((k) => k.position.x + k.style.width + GRID.padX <= group.style.width),
    `${group.style.width}×${group.style.height}`,
  );
  check("E3 重排不动连线/不改子卡尺寸", kids.every((k) => k.style.width === 256 && k.style.height === (k.id === "r1" ? 454 : 230)));
}

/* ---------- F 幂等 ---------- */
{
  const st = useCanvasStore.getState();
  const before = st.nodes.filter((n) => n.parentId === "g1").map((n) => `${n.id}:${n.position.x},${n.position.y}`).sort().join("|");
  relayoutRefGroup();
  const after = useCanvasStore.getState().nodes
    .filter((n) => n.parentId === "g1")
    .map((n) => `${n.id}:${n.position.x},${n.position.y}`)
    .sort()
    .join("|");
  check("F1 无重叠时重排不动位置（幂等）", before === after);
  const grouped = useCanvasStore.getState().nodes.filter((n) => n.parentId === "g1");
  check("F2 重排不改子卡尺寸", grouped.every((k) => k.style.width === 256));
}

/* ---------- G 撤销语义与不留同格叠卡 ----------
 * 整批一次撤销快照（同 chainConnect/粘贴）：采纳三张 → Ctrl+Z 一次就该整批
 * 回退，且**任何一个中间态**都不能出现「几张卡并排叠在组内左上角」的临时位置
 * （逐张 commit 的老写法就是那样：快照里的卡还在临时坐标上）。 */
{
  const cand = (id, w, h) => ({
    id,
    nodeId: "asset1",
    query: "",
    provider: "serper",
    title: `候选 ${id}`,
    pageUrl: "",
    sourceDomain: "example.com",
    sourceUrl: "",
    assetUrl: `https://img.example.com/${id}.jpg`,
    width: w,
    height: h,
    adopted: true,
    recommended: true,
    recRank: 1,
    recReason: "",
    createdAt: "",
  });
  resetCanvas([
    { id: "asset1", type: "scene", position: { x: 0, y: 0 }, style: { width: 288, height: 214 }, data: { nodeType: "scene", title: "钱库镇老街" } },
  ]);
  adoptRefRows([
    { nodeId: "asset1", candidates: [cand("g1", 800, 556), cand("g2", 800, 556), cand("g3", 800, 556)] },
  ]);
  const beforeUndo = useCanvasStore.getState().nodes.filter((n) => n.parentId);
  const keys = beforeUndo.map((k) => `${k.position.x},${k.position.y}`);
  check("G1 三张卡落位各不相同（无叠格）", new Set(keys).size === keys.length, keys.join(" / "));
  check(
    "G2 位置在网格上（x = padX + 列 ×(卡宽+gapX)）",
    beforeUndo.every((k) => (k.position.x - GRID.padX) % (FP.w + GRID.gapX) === 0),
    keys.join(" / "),
  );
  useCanvasStore.getState().undo();
  const after = useCanvasStore.getState().nodes.filter((n) => n.parentId);
  check("G3 撤销一次整批回退（不是一张一张吐）", after.length === 0, `剩余 ${after.length} 张`);
  check("G4 撤销后连线一并回退", useCanvasStore.getState().edges.length === 0, `edges=${useCanvasStore.getState().edges.length}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
