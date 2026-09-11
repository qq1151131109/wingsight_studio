"use client";

/** 参考图采纳落画布：候选 → 建图片卡（refSource=research）→ 连线到资产卡。
 *  单资产面板、批量审阅面板、调研完成自动采纳三方共用。
 *
 *  落位（2026-09-11 参考卡风暴后重做）：全部收进项目级「考据参考」组框
 *  （data.refGroup="research" 单例）——组框**默认折叠**成胶囊（172×40），
 *  子卡 hidden 不渲染不挡视线，但连线数据仍在：出图参考链路零影响
 *  （前端 buildRefSequence 与服务端 _canvas_ref_cards 都按 edges/nodes 收
 *  参考、不过滤 hidden，实测核实过）。点胶囊展开可看全部参考的网格。
 *  此前「资产所在列下方各占一条横带」的落位是给单资产小批量设计的，
 *  冯太后项目 52 资产 × 3 张一次性对账物化，抻成 2350×4100px 的画布 sprawl
 *  （用户反馈「乱七八糟」）。 */

import {
  NODE_FOOTPRINT,
  absolutePosition,
  nodeSize,
  useCanvasStore,
} from "@/lib/canvas/store";
import { adoptRefCandidates, listRefCandidates } from "@/lib/ref-research";
import type { RefCandidate } from "@/lib/ref-research";
import { useRefStatusStore } from "@/lib/refStatus";

/** 考据参考组框的认领标记（单例：一个项目恒定一个） */
export const REF_GROUP_FLAG = "refGroup";

/** 追加网格：4 列（image 卡 256 宽 × 4 + 间距 + 内边距 ≈ 1140，展开时一屏可读） */
const REF_GRID = { cols: 4, gapX: 24, gapY: 24, padX: 16, padTop: 44, padBottom: 16 };

/** 找到（或当场建）考据参考组框。系统物化路径建组即折叠——研究参考是
 *  出图的原料不是画布主角，默认收起；想核对形制点胶囊展开。 */
function ensureRefGroup(
  st: ReturnType<typeof useCanvasStore.getState>,
  firstCards: number,
): { id: string; collapsed: boolean } {
  const existing = st.nodes.find(
    (n) => n.data.nodeType === "group" && n.data.refGroup === "research",
  );
  if (existing) {
    return { id: existing.id, collapsed: Boolean(existing.data.collapsed) };
  }
  const fp = NODE_FOOTPRINT.image;
  const rows = Math.ceil(Math.max(1, firstCards) / REF_GRID.cols);
  const w =
    REF_GRID.padX * 2 + REF_GRID.cols * fp.w + (REF_GRID.cols - 1) * REF_GRID.gapX;
  const h =
    REF_GRID.padTop +
    rows * fp.h +
    (rows - 1) * REF_GRID.gapY +
    REF_GRID.padBottom;
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
      style: { width: 172, height: 40 },
      data: {
        nodeType: "group",
        title: "考据参考",
        refGroup: "research",
        collapsed: true,
        prevSize: { w, h },
        body: "",
      },
    },
    { history: "skip" },
  );
  return { id, collapsed: true };
}

/** 组框内容的包围盒（子卡相对坐标系）+ 外边距 → 组该有的尺寸 */
function refGroupSize(st: ReturnType<typeof useCanvasStore.getState>, gid: string) {
  const members = st.nodes.filter((n) => n.parentId === gid);
  if (members.length === 0) return { w: 220, h: 120 };
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const m of members) {
    const s = nodeSize(m);
    maxX = Math.max(maxX, m.position.x + s.w);
    maxY = Math.max(maxY, m.position.y + s.h);
  }
  return {
    w: Math.max(220, maxX + REF_GRID.padX + REF_GRID.gapX),
    h: Math.max(120, maxY + REF_GRID.padBottom),
  };
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
    adoptRefRows([{ nodeId, candidates: picks }]);
    void useRefStatusStore.getState().refresh(projectId, { force: true });
  } catch (exc) {
    console.warn("自动采纳参考图失败（可在找参考图弹窗手动采纳）", exc);
  }
}

/**
 * 批量采纳：每个资产一组候选，建图片卡连线到资产卡——卡全部落进
 * 「考据参考」折叠组框（追加网格），不再摊在资产区下方。
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
  const group = ensureRefGroup(st, total);
  // 追加起点：现有成员 bbox 之下开新 4 列网格（存量迁移进来的卡保持原相对
  // 排布，新卡不叠上去）
  const members = st.nodes.filter((n) => n.parentId === group.id);
  let originY = REF_GRID.padTop;
  for (const m of members) {
    originY = Math.max(originY, m.position.y + nodeSize(m).h + REF_GRID.gapY);
  }
  const created: string[] = [];
  let i = 0;
  for (const { nodeId, candidates } of rows) {
    const asset = st.nodes.find((n) => n.id === nodeId);
    if (!asset || candidates.length === 0) continue;
    candidates.forEach((c, j) => {
      const slot = i + j;
      const col = slot % REF_GRID.cols;
      const row = Math.floor(slot / REF_GRID.cols);
      const newId = st.addNode(
        {
          position: {
            x: REF_GRID.padX + col * (fp.w + REF_GRID.gapX),
            y: originY + row * (fp.h + REF_GRID.gapY),
          },
          parentId: group.id,
          hidden: group.collapsed,
          style: { width: fp.w, height: fp.h },
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
        opts,
      );
      created.push(newId);
      st.connect({ source: newId, target: nodeId }, opts);
    });
    i += candidates.length;
  }
  // 组尺寸跟进：展开态直接改 style；折叠态写进 prevSize（展开时还原到包住全部）
  const g = useCanvasStore.getState().nodes.find((n) => n.id === group.id);
  if (g) {
    const size = refGroupSize(useCanvasStore.getState(), group.id);
    const collapsed = Boolean(g.data.collapsed);
    if (collapsed) {
      useCanvasStore.getState().updateNodeData(
        group.id,
        { prevSize: size },
        { history: "skip" },
      );
    } else {
      useCanvasStore.setState((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === group.id ? { ...n, style: { ...n.style, ...size } } : n,
        ),
      }));
    }
  }
  return created;
}
