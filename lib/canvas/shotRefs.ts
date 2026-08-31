/**
 * 分镜行 ↔ 资产卡引用解析（共享纯函数）：行内出图参考、行 @候选下拉、
 * sanitize 存量迁移三处共用同一实现，避免逻辑漂移。
 * 规则：结构化 refIds 优先，文本 @名称 兜底——最长名优先匹配（防「小雨」
 * 误命中「小雨萍」），已命中的区间不再被更短名覆盖。
 */

import type { ShotRow, WingEdge, WingNode } from "./store";

const ASSET_TYPES = ["character", "scene", "prop", "costume"];

/** Look 图卡判定：image 卡且有来自资产卡的连线 = 派生参考图（一张卡一张图
 *  重构后，造型变体都是这种卡），可被行内 @ 引用当一致性参考。
 *  有分镜表入边的镜头派生图不算——它们是产出不是造型参考 */
export function isLookCard(
  n: WingNode | undefined,
  nodes: WingNode[],
  edges: WingEdge[],
): boolean {
  if (
    !n ||
    n.data.nodeType !== "image" ||
    !(n.data.title as string)?.trim()
  ) {
    return false;
  }
  return edges.some((e) => {
    if (e.target !== n.id) return false;
    const src = nodes.find((m) => m.id === e.source);
    if (!src) return false;
    if (src.data.nodeType === "shotlist") return false;
    return ASSET_TYPES.includes(String(src.data.nodeType));
  });
}

/** 文本 @名称 兜底匹配：返回命中的候选卡 id（跨卡命中区间不重叠） */
export function mentionedRefIds(
  text: string,
  nodes: WingNode[],
  edges: WingEdge[],
): string[] {
  const cands = nodes
    .filter(
      (n) =>
        (ASSET_TYPES.includes(String(n.data.nodeType)) ||
          isLookCard(n, nodes, edges)) &&
        (n.data.title as string)?.trim(),
    )
    .sort(
      (a, b) =>
        (b.data.title as string).length - (a.data.title as string).length,
    );
  const found: string[] = [];
  const spans: [number, number][] = [];
  for (const n of cands) {
    const token = `@${n.data.title}`;
    let from = 0;
    for (;;) {
      const i = text.indexOf(token, from);
      if (i === -1) break;
      const end = i + token.length;
      if (!spans.some(([s0, e0]) => i < e0 && end > s0)) {
        spans.push([i, end]);
        found.push(n.id);
      }
      from = i + 1;
    }
  }
  return found;
}

/** 行引用解析：结构化 refIds ∪ 文本 @名称 兜底，合并去重（refIds 在前） */
export function resolveRowRefIds(
  row: Pick<ShotRow, "refIds" | "action" | "dialogue">,
  nodes: WingNode[],
  edges: WingEdge[],
): string[] {
  const ids = new Set<string>(row.refIds ?? []);
  mentionedRefIds(`${row.action ?? ""}${row.dialogue ?? ""}`, nodes, edges).forEach(
    (id) => ids.add(id),
  );
  return [...ids];
}
