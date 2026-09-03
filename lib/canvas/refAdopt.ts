"use client";

/** 参考图采纳落画布：候选 → 建图片卡（refSource=research）→ 连线到资产卡。
 *  单资产面板、批量审阅面板、调研完成自动采纳三方共用。
 *  落位 = 资产所在「列」底部的带状区：拆解网格行距只有 24px，直接放资产
 *  正下方会压到下一行资产卡；同列多个资产按行序各占一条横带，该资产已有
 *  参考卡时再顺延到最低参考卡之下。 */

import {
  NODE_FOOTPRINT,
  absolutePosition,
  nodeSize,
  useCanvasStore,
} from "@/lib/canvas/store";
import { adoptRefCandidates, listRefCandidates } from "@/lib/ref-research";
import type { RefCandidate } from "@/lib/ref-research";
import { useRefStatusStore } from "@/lib/refStatus";

const ASSET_TYPES = ["character", "scene", "prop", "costume"];

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
 * 批量采纳：每个资产一组候选，建卡连线到该资产所在列的参考带。
 * 返回新建卡 id 列表（供 flash 定位）。
 */
export function adoptRefRows(
  rows: { nodeId: string; candidates: RefCandidate[] }[],
): string[] {
  const st = useCanvasStore.getState();
  const fp = NODE_FOOTPRINT.image;
  const created: string[] = [];
  for (const { nodeId, candidates } of rows) {
    const asset = st.nodes.find((n) => n.id === nodeId);
    if (!asset || candidates.length === 0) continue;
    const origin = absolutePosition(st.nodes, asset);
    // 同列资产（|绝对 x 差|≤80）：取整列最低卡底作参考带起点，本资产的
    // 行序决定带偏移——网格里每一行资产的参考卡各占一条横带互不叠压
    const col = st.nodes
      .filter(
        (n) =>
          ASSET_TYPES.includes(String(n.data.nodeType)) &&
          Math.abs(absolutePosition(st.nodes, n).x - origin.x) <= 80,
      )
      .map((n) => ({ p: absolutePosition(st.nodes, n), s: nodeSize(n), id: n.id }))
      .sort((a, b) => a.p.y - b.p.y);
    const colBottom = Math.max(...col.map((c) => c.p.y + c.s.h));
    const bandIdx = Math.max(
      0,
      col.findIndex((c) => c.id === asset.id),
    );
    let y0 = colBottom + 24 + bandIdx * (fp.h + 16);
    // 该资产已有参考卡：新带顺延到最低参考卡之下（手动追加不叠自动采纳）
    const existingRefs = st.nodes.filter(
      (n) =>
        n.data.refSource === "research" &&
        st.edges.some((e) => e.target === nodeId && e.source === n.id),
    );
    if (existingRefs.length > 0) {
      const exBottom = Math.max(
        ...existingRefs.map(
          (n) => absolutePosition(st.nodes, n).y + nodeSize(n).h,
        ),
      );
      y0 = Math.max(y0, exBottom + 16);
    }
    candidates.forEach((c, i) => {
      const newId = st.addNode({
        position: {
          x: origin.x + i * (fp.w + 24),
          y: y0,
        },
        style: { width: fp.w, height: fp.h },
        data: {
          nodeType: "image",
          title: (c.title || "参考图").slice(0, 40),
          body: c.sourceDomain ? `来源：${c.sourceDomain}` : "",
          imageUrl: c.assetUrl,
          status: "ready",
          refSource: "research",
        },
      });
      created.push(newId);
      st.connect({ source: newId, target: nodeId });
    });
  }
  return created;
}
