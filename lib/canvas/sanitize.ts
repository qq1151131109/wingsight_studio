/**
 * 画布数据消毒（装载边界）：剥离指向不存在节点的 parentId/连线。
 * 背景：多会话并发保存曾产生过"孤儿子卡"（组框丢失、坐标仍是相对值），
 * 直接进渲染管线会引发 xyflow 告警和布局错乱——必须在 loadCanvas 后过滤。
 */

import type { WingEdge, WingNode } from "./store";

export interface SanitizeResult {
  nodes: WingNode[];
  edges: WingEdge[];
  removedNodes: number;
  removedEdges: number;
  fixedParents: number;
}

export function sanitizeCanvas(
  nodes: WingNode[],
  edges: WingEdge[],
): SanitizeResult {
  const ids = new Set(
    nodes.filter((n) => n && typeof n.id === "string").map((n) => n.id),
  );
  const cleanNodes: WingNode[] = [];
  const seenIds = new Set<string>();
  let removedNodes = 0;
  let fixedParents = 0;
  for (const n of nodes) {
    if (!n || typeof n.id !== "string" || typeof n.data?.nodeType !== "string") {
      removedNodes += 1;
      continue;
    }
    if (seenIds.has(n.id)) {
      // 重复 id（多会话竞态/重放）：React key 唯一性要求，保留首个
      removedNodes += 1;
      continue;
    }
    seenIds.add(n.id);
    if (n.parentId && !ids.has(n.parentId)) {
      // 组框丢失的孤儿卡：脱离分组（坐标按绝对值近似处理，交给用户微调）
      const { parentId: _p, extent: _e, ...rest } = n;
      cleanNodes.push(rest as WingNode);
      fixedParents += 1;
      continue;
    }
    cleanNodes.push(n);
  }
  const liveIds = new Set(cleanNodes.map((n) => n.id));
  const cleanEdges: WingEdge[] = [];
  let removedEdges = 0;
  for (const e of edges) {
    if (!e || !liveIds.has(e.source) || !liveIds.has(e.target) || e.source === e.target) {
      removedEdges += 1;
      continue;
    }
    cleanEdges.push(e);
  }
  return { nodes: cleanNodes, edges: cleanEdges, removedNodes, removedEdges, fixedParents };
}
