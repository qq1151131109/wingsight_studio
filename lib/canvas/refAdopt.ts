"use client";

/** 参考图采纳落画布：候选 → 建图片卡（refSource=research）→ 连线到资产卡。
 *  单资产面板、批量审阅面板、调研完成自动采纳三方共用。
 *
 *  落位（2026-09-11 参考卡风暴后重做）：全部收进项目级「考据参考」组框
 *  （data.refGroup="research" 单例）。组框**默认展开**（同日用户拍板：参考图
 *  是要核对的原料，收起等于让人多点一次才看得见），需要时可手动折叠成胶囊
 *  （172×40，子卡 hidden，连线数据仍在——出图参考链路零影响：前端
 *  buildRefSequence 与服务端 _canvas_ref_cards 都按 edges/nodes 收参考、
 *  不过滤 hidden，实测核实过）。
 *  此前「资产所在列下方各占一条横带」的落位是给单资产小批量设计的，
 *  冯太后项目 52 资产 × 3 张一次性对账物化，抻成 2350×4100px 的画布 sprawl
 *  （用户反馈「乱七八糟」）。
 *
 *  网格行距按**真实卡高**算（2026-09-11 重叠事故）：图片卡媒体自适应后高度
 *  121~454 不等（竖图是横图的三倍），早期按 footprint 高度定行距（224）必然
 *  让高卡压到下一行、末行还会伸出组框（091102 实测：一张连「盛加垟村」的
 *  参考卡挂在框外 190px）。现在 = 行式流入按「该行最高卡 + gapY」推进，
 *  建卡当刻按候选图的宽高比预估高度，图片载入后的重排再校准到像素。 */

import {
  NODE_FOOTPRINT,
  absolutePosition,
  nodeSize,
  useCanvasStore,
  type WingNode,
} from "@/lib/canvas/store";
import { adoptRefCandidates, listRefCandidates } from "@/lib/ref-research";
import type { RefCandidate } from "@/lib/ref-research";
import { useRefStatusStore } from "@/lib/refStatus";

/** 考据参考组框的认领标记（单例：一个项目恒定一个） */
export const REF_GROUP_FLAG = "refGroup";

/** 组内网格：4 列（image 卡 256 宽 × 4 + 间距 + 内边距 ≈ 1148，展开时一屏可读）。
 *  gapY 是「行与行之间」的最小留白，实际行距由该行最高卡决定（见 packRefGrid）。 */
const REF_GRID = { cols: 4, gapX: 28, gapY: 28, padX: 20, padTop: 44, padBottom: 20 };

/** 图片卡媒体自适应后的卡高（useMediaFitHeight 的公式，浏览器实测标定：
 *  卡高 = 53 + 254 × 图高/图宽——26 是卡身上下 chrome、254 是媒体盒宽、
 *  另 27 是媒体盒内的来源行）。建卡当刻图还没载入，用它把行高一次排对
 *  （不预估的话就是「先按 200 排、载入后再重叠」的老路）。 */
export function refCardHeight(w: number, h: number, fallbackH: number): number {
  if (!w || !h) return fallbackH;
  return Math.min(760, Math.max(96, Math.round(53 + 254 * (h / w))));
}

/** 行式流入（纯函数）：4 列，行距 = 该行最高卡 + gapY——高卡不再压下一行 */
export function packRefGrid(
  items: { w: number; h: number }[],
  grid: typeof REF_GRID = REF_GRID,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let y = grid.padTop;
  for (let i = 0; i < items.length; i += grid.cols) {
    const row = items.slice(i, i + grid.cols);
    const rowH = Math.max(...row.map((r) => r.h));
    row.forEach((r, c) => {
      out.push({ x: grid.padX + c * (r.w + grid.gapX), y });
    });
    y += rowH + grid.gapY;
  }
  return out;
}

/** 组框该有的尺寸 = 已落位内容的包围盒 + 内边距（纯函数）。
 *  必须按**位置**算而不是按卡数算：末行单张卡的高度就是组框该有的高度。
 *  返回 width/height（xyflow 只认这两个键——早期返回 {w,h} 写进 style 等于
 *  什么都没改，组框尺寸一直停在建组当刻的估算值，末行于是挂在框外）。 */
export function refGroupSizeFor(
  placed: { x: number; y: number; w: number; h: number }[],
  grid: typeof REF_GRID = REF_GRID,
): { width: number; height: number } {
  if (placed.length === 0) return { width: 220, height: 120 };
  const maxX = Math.max(...placed.map((r) => r.x + r.w));
  const maxY = Math.max(...placed.map((r) => r.y + r.h));
  return {
    width: Math.max(220, maxX + grid.padX),
    height: Math.max(120, maxY + grid.padBottom),
  };
}

/** 找到（或当场建）考据参考组框。系统物化路径建组即**展开**（2026-09-11 用户
 *  拍板：参考图是出图要核对的原料，默认收起等于藏起来）；尺寸由建卡后的
 *  relayoutRefGroup 整组重排定。 */
function ensureRefGroup(st: ReturnType<typeof useCanvasStore.getState>): {
  id: string;
  collapsed: boolean;
} {
  const existing = st.nodes.find(
    (n) => n.data.nodeType === "group" && n.data.refGroup === "research",
  );
  if (existing) {
    installRefLayoutWatcher();
    return { id: existing.id, collapsed: Boolean(existing.data.collapsed) };
  }
  const fp = NODE_FOOTPRINT.image;
  // 落位：可见内容 bbox 左下角再往下留白（不压任何卡，也不抢视口）
  let minX = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const n of st.nodes) {
    if (n.hidden) continue;
    const abs = absolutePosition(st.nodes, n);
    const s = nodeSize(n);
    minX = Math.min(minX, abs.x);
    maxY = Math.max(maxY, abs.y + s.h);
  }
  const pos =
    Number.isFinite(minX) && Number.isFinite(maxY)
      ? { x: minX, y: maxY + 120 }
      : { x: 0, y: 0 };
  const id = st.addNode(
    {
      position: pos,
      style: { width: fp.w + REF_GRID.padX * 2, height: 160 },
      data: {
        nodeType: "group",
        title: "考据参考",
        refGroup: "research",
        collapsed: false,
        body: "",
      },
    },
    { history: "skip" },
  );
  installRefLayoutWatcher();
  return { id, collapsed: false };
}

/** 写组框尺寸（系统写入，不进撤销栈）。xyflow 认 style.width/height */
function setRefGroupSize(gid: string, size: { width: number; height: number }): void {
  useCanvasStore.setState((s) => ({
    nodes: s.nodes.map((n) =>
      n.id === gid ? { ...n, style: { ...n.style, ...size } } : n,
    ),
  }));
}

/** 同列上下相邻两卡是否压在一起（自愈触发判据） */
function hasVerticalOverlap(members: WingNode[]): boolean {
  const cols = new Map<number, { y: number; h: number }[]>();
  for (const m of members) {
    const key = Math.round(m.position.x);
    cols.set(key, [...(cols.get(key) ?? []), { y: m.position.y, h: nodeSize(m).h }]);
  }
  for (const list of cols.values()) {
    list.sort((a, b) => a.y - b.y);
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].y < list[i - 1].y + list[i - 1].h - 1) return true;
    }
  }
  return false;
}

/**
 * 组内重排（系统区，不进撤销栈、不动连线）：
 *  - `force`：刚建了卡，整组按当前尺寸重排（新卡入列；存量卡的旧重叠一并修掉）
 *  - 非 force：只在检测到重叠时重排（自愈），否则只把组框尺寸跟到实际内容
 *    —— 尺寸跟不上就会「卡挂在框外」（091102「盛加垟村」那张越界 190px 的
 *    参考卡就是组框高只按 footprint 算的结果）。
 *  折叠态只更新 prevSize（展开时还原到包住全部卡）。
 */
export function relayoutRefGroup(opts?: { force?: boolean }): boolean {
  installRefLayoutWatcher();
  const st = useCanvasStore.getState();
  const g = st.nodes.find(
    (n) => n.data.nodeType === "group" && n.data.refGroup === "research",
  );
  if (!g) return false;
  const members = st.nodes.filter((n) => n.parentId === g.id);
  if (members.length === 0) return false;
  const boxOf = (list: { position: { x: number; y: number }; w: number; h: number }[]) =>
    refGroupSizeFor(list.map((m) => ({ ...m.position, w: m.w, h: m.h })));
  const size = boxOf(members.map((m) => ({ position: m.position, ...nodeSize(m) })));
  if (g.data.collapsed) {
    // prevSize 的契约是 {w,h}（store.toggleGroupCollapse 展开时按它还原）
    st.updateNodeData(
      g.id,
      { prevSize: { w: size.width, h: size.height } },
      { history: "skip" },
    );
    return false;
  }
  if (!opts?.force && !hasVerticalOverlap(members)) {
    setRefGroupSize(g.id, size);
    return false;
  }
  // 阅读顺序 = 先 y 后 x（现有网格本就是行式落位，排序即恢复创建序）
  const ordered = [...members].sort(
    (a, b) => a.position.y - b.position.y || a.position.x - b.position.x,
  );
  const slots = packRefGrid(ordered.map((m) => nodeSize(m)));
  const posById = new Map(ordered.map((m, i) => [m.id, slots[i]] as const));
  const packed = refGroupSizeFor(
    ordered.map((m, i) => ({ ...slots[i], ...nodeSize(m) })),
  );
  useCanvasStore.setState((s) => ({
    nodes: s.nodes.map((n) => {
      const p = posById.get(n.id);
      if (p) return { ...n, position: p };
      if (n.id === g.id) return { ...n, style: { ...n.style, ...packed } };
      return n;
    }),
  }));
  return true;
}

/** 成员卡高度变化（图片载入后媒体自适应）→ 防抖重排：建卡当刻的预估高度
 *  与实际差几像素是常态，重排把行距校准到真实卡高。只装一次。
 *  高度键同时看 `style.height`（fitNodeHeight 写的）与 `measured.height`
 *  （xyflow 量完回写的）——只认一个会漏：写 style 那刻 measured 还是旧值，
 *  而 nodeSize 优先读 measured。 */
let refLayoutUnsub: (() => void) | null = null;
let refLayoutTimer: ReturnType<typeof setTimeout> | null = null;

function installRefLayoutWatcher(): void {
  if (refLayoutUnsub) return;
  const heights = (nodes: WingNode[]): string => {
    const gid = nodes.find(
      (n) => n.data.nodeType === "group" && n.data.refGroup === "research",
    )?.id;
    if (!gid) return "";
    return nodes
      .filter((n) => n.parentId === gid)
      .map(
        (n) =>
          `${n.id}:${Number(n.style?.height) || 0}:${n.measured?.height ?? 0}`,
      )
      .sort()
      .join(",");
  };
  let prev = heights(useCanvasStore.getState().nodes);
  refLayoutUnsub = useCanvasStore.subscribe((s) => {
    const next = heights(s.nodes);
    if (next === prev) return;
    prev = next;
    if (refLayoutTimer) clearTimeout(refLayoutTimer);
    refLayoutTimer = setTimeout(() => {
      refLayoutTimer = null;
      relayoutRefGroup();
    }, 400);
  });
}

/** 每资产自动采纳目标张数：调研完成把推荐候选补齐到这个数，
 *  其余候选留在找参考图弹窗里手动增补 */
export const AUTO_REF_TARGET = 3;

/** 自动采纳在途/完成标记（模块级单例：ScriptCard 与各资产卡同时轮询
 *  同一批次，不加锁会对同一资产重复建卡） */
const autoAdoptSeen = new Set<string>();

export function autoAdoptKeyOnce(
  projectId: string,
  batchId: string,
  nodeId: string,
): boolean {
  // 键带批次号：同资产跨批次重调研（重跑语义）要能再次触发自动采纳
  const key = `${projectId}:${batchId}:${nodeId}`;
  if (autoAdoptSeen.has(key)) return false;
  autoAdoptSeen.add(key);
  return true;
}

/** 调研完成自动采纳：推荐候选补齐到 AUTO_REF_TARGET（已够不采，重复调研
 *  不堆积）。失败只 warn 不抛——这是便利层，弹窗里手动采纳仍然可用。 */
export async function autoAdoptTopRecommendations(
  projectId: string,
  nodeId: string,
): Promise<void> {
  try {
    const st = useCanvasStore.getState();
    if (!st.nodes.some((n) => n.id === nodeId)) return; // 卡已被删
    const cands = await listRefCandidates(projectId, nodeId);
    const need = AUTO_REF_TARGET - cands.filter((c) => c.adopted).length;
    if (need <= 0) return;
    // 按 LLM 适配度排序取 top-K（recRank 1=最推荐；无 rank 的历史行排最后）
    const picks = cands
      .filter((c) => c.recommended && !c.adopted)
      .sort((a, b) => (a.recRank || 99) - (b.recRank || 99))
      .slice(0, need);
    if (picks.length === 0) return;
    await adoptRefCandidates(
      projectId,
      nodeId,
      picks.map((c) => c.id),
    );
    // 系统采纳（调研跑完自动补 top-K）不进撤销栈：用户没点过「采纳」，
    // Ctrl+Z 不该把系统塞进来的卡撤掉——要退就删卡（删卡=取消采纳）
    adoptRefRows([{ nodeId, candidates: picks }], { history: "skip" });
    void useRefStatusStore.getState().refresh(projectId, { force: true });
  } catch (exc) {
    console.warn("自动采纳参考图失败（可在找参考图弹窗手动采纳）", exc);
  }
}

/**
 * 批量采纳：每个资产一组候选，建图片卡连线到资产卡——卡全部落进
 * 「考据参考」组框（行式网格），不再摊在资产区下方。
 * 返回新建卡 id 列表（供 flash 定位）。
 * opts.history="skip" 给系统对账用（打开项目自愈落卡不该进撤销栈）。
 */
export function adoptRefRows(
  rows: { nodeId: string; candidates: RefCandidate[] }[],
  opts?: { history?: "commit" | "skip" },
): string[] {
  const st = useCanvasStore.getState();
  const fp = NODE_FOOTPRINT.image;
  const total = rows.reduce((n, r) => n + r.candidates.length, 0);
  if (total === 0) return [];
  const group = ensureRefGroup(st);
  // 整批一次撤销快照（同 chainConnect／粘贴的语义）：逐张 addNode/connect 各自
  // 压快照的话，Ctrl+Z 只能一张一张吐、中间态还是「并排叠在组内左上角」。
  // 建卡期间一律 history:"skip"，收尾整组重排一次（重排是 setState，本就不入栈）
  const sys = { history: "skip" as const };
  if (opts?.history !== "skip") st.commitHistory();
  const created: string[] = [];
  for (const { nodeId, candidates } of rows) {
    const asset = st.nodes.find((n) => n.id === nodeId);
    if (!asset || candidates.length === 0) continue;
    for (const c of candidates) {
      const newId = st.addNode(
        {
          // 位置先给组内左上角，收尾整组重排统一入列（高度按候选图宽高比预估）
          position: { x: REF_GRID.padX, y: REF_GRID.padTop },
          parentId: group.id,
          hidden: group.collapsed,
          style: { width: fp.w, height: refCardHeight(c.width, c.height, fp.h) },
          data: {
            nodeType: "image",
            title: (c.title || "参考图").slice(0, 40),
            body: c.sourceDomain ? `来源：${c.sourceDomain}` : "",
            imageUrl: c.assetUrl,
            status: "ready",
            refSource: "research",
            // 候选 id 落卡：删除这张卡 = 取消采纳（下次打开不再重建），
            // 也是对账反向修复的凭据（卡在而未采纳 → 补采纳）
            refCandidateId: c.id,
          },
        },
        sys,
      );
      created.push(newId);
      st.connect({ source: newId, target: nodeId }, sys);
    }
  }
  // 整组重排收尾：新卡入列 + 存量卡的旧重叠（固定行距时代留下的）一并修掉
  relayoutRefGroup({ force: true });
  return created;
}

/** 时代参考物化的入参（report.topicRefs 的一项） */
export interface TopicRefRow {
  topicKey: string;
  title: string;
  images: {
    id: string;
    url: string;
    title?: string;
    sourceDomain?: string;
  }[];
  servedNodeIds: string[];
}

/**
 * 时代参考池物化：主题图集 → 参考卡，**一张图一张卡、连到该主题的全部成员卡**
 * （同一批时代参考发给所有成员，画布上看得见「这几张卡的形制是同源的」）。
 *
 * 与 adoptRefRows 的关键差别在删除凭据：卡带 `topicRefId`（research_subject_refs
 * 行 id）而**不带** refCandidateId——主题图不在候选表里，误入 refCandidateId
 * 通道会打错表（unadopt/unadopt 广播/反向修复全按候选行工作）。删除这张卡由
 * store 记 meta.dismissedTopicRefs，对账按 id 跳过（「删了就不再来」，同参考卡
 * 语义）；同主题其余图照常物化。
 */
export function materializeTopicRefs(
  refs: TopicRefRow[],
  opts?: { history?: "commit" | "skip" },
): string[] {
  const st = useCanvasStore.getState();
  const fp = NODE_FOOTPRINT.image;
  const total = refs.reduce(
    (n, r) => n + r.images.filter((img) => img.url).length,
    0,
  );
  if (total === 0) return [];
  const group = ensureRefGroup(st);
  // 整批一次撤销快照 + 建卡期间 history:"skip"（同 adoptRefRows 的理由）
  const sys = { history: "skip" as const };
  if (opts?.history !== "skip") st.commitHistory();
  const created: string[] = [];
  for (const ref of refs) {
    const targets = ref.servedNodeIds.filter((id) =>
      st.nodes.some((n) => n.id === id),
    );
    if (targets.length === 0) continue;
    for (const img of ref.images) {
      if (!img.url) continue;
      const newId = st.addNode(
        {
          // 主题图只有 URL 没有原始宽高（图集表不存尺寸）：先按 footprint 落位，
          // 收尾整组重排 + 载入后的 watcher 重排（installRefLayoutWatcher）校准
          position: { x: REF_GRID.padX, y: REF_GRID.padTop },
          parentId: group.id,
          hidden: group.collapsed,
          style: { width: fp.w, height: fp.h },
          data: {
            nodeType: "image",
            title: (img.title || `${ref.title}·时代参考`).slice(0, 40),
            body: img.sourceDomain ? `来源：${img.sourceDomain}` : "",
            imageUrl: img.url,
            status: "ready",
            refSource: "research",
            topicRefId: img.id,
          },
        },
        sys,
      );
      created.push(newId);
      for (const t of targets) st.connect({ source: newId, target: t }, sys);
    }
  }
  relayoutRefGroup({ force: true });
  return created;
}
