"use client";

/** 参考图采纳落画布：候选 → 建图片卡（refSource=research）→ 连线到资产卡。
 *  单资产面板与批量审阅面板共用。落位 = 资产卡正下方一行排开，
 *  已有考据参考卡时向下顺延一行，避免叠压上次采纳的卡。 */

import {
  NODE_FOOTPRINT,
  absolutePosition,
  nodeSize,
  useCanvasStore,
} from "@/lib/canvas/store";
import type { RefCandidate } from "@/lib/ref-research";

/**
 * 批量采纳：每个资产一组候选，建卡连到资产卡正下方。
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
    const size = nodeSize(asset);
    // 已有考据参考卡占了几行：新卡顺延到下一空行
    const existingRows = st.nodes.filter(
      (n) =>
        n.data.refSource === "research" &&
        st.edges.some((e) => e.target === nodeId && e.source === n.id),
    );
    const rowOffset = existingRows.length > 0 ? fp.h + 24 : 0;
    candidates.forEach((c, i) => {
      const newId = st.addNode({
        position: {
          x: origin.x + i * (fp.w + 24),
          y: origin.y + size.h + 48 + rowOffset,
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
