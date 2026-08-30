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
  /** 遗留 looks[] 迁移拆出的 Look 图片卡数（一张卡一张图） */
  migratedLooks: number;
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
  // 遗留 looks[] 迁移（一张卡一张图）：角色卡上的 Look 变体拆成独立图片卡，
  // 角色卡 → Look卡 连线表达派生关系；迁后 looks 字段剥离，再次装载即幂等
  const byId = new Map(cleanNodes.map((n) => [n.id, n]));
  const extraNodes: WingNode[] = [];
  const extraEdges: WingEdge[] = [];
  let migratedLooks = 0;
  for (const n of cleanNodes) {
    const looks = n.data.looks;
    if (n.data.nodeType !== "character" || !Array.isArray(looks) || looks.length === 0) {
      continue;
    }
    delete n.data.looks;
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    const abs = parent
      ? {
          x: parent.position.x + n.position.x,
          y: parent.position.y + n.position.y,
        }
      : { ...n.position };
    const charW =
      (typeof n.style?.width === "number" ? n.style.width : 0) || 256;
    // 落点：角色可视位置右侧一列；在组内时摆到组框外右缘（避免叠组内兄弟卡）
    const baseX = parent
      ? parent.position.x +
        ((typeof parent.style?.width === "number" ? parent.style.width : 0) || 480) +
        32
      : abs.x + charW + 32;
    const gen = () => Math.random().toString(36).slice(2, 10);
    looks.forEach((l, i) => {
      if (!l?.imageUrl) return;
      const lid = `n_${gen()}`;
      extraNodes.push({
        id: lid,
        type: "image",
        position: { x: baseX, y: abs.y + i * 168 },
        style: { width: 176, height: 132 },
        data: {
          nodeType: "image",
          title: `${n.data.title || "角色"}·${l.label || "造型"}`.slice(0, 40),
          body: "",
          imageUrl: l.imageUrl,
          status: "ready",
        },
      });
      extraEdges.push({ id: `e_${gen()}`, source: n.id, target: lid });
      migratedLooks += 1;
    });
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
  return {
    nodes: [...cleanNodes, ...extraNodes],
    edges: [...cleanEdges, ...extraEdges],
    removedNodes,
    removedEdges,
    fixedParents,
    migratedLooks,
  };
}
