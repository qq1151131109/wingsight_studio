/**
 * 画布操作契约（ops）——Agent 写通道的统一入口。
 *
 * 参考影策 canvas_apply_ops 的指令集设计，适配 React Flow 数据模型：
 *   add_node / update_node / delete_nodes / connect_nodes / set_viewport
 *
 * 校验从严：未知 op、非法参数一律记入 errors，不中断整批执行。
 */

import {
  NODE_META,
  useCanvasStore,
  type WingNodeType,
} from "./store";

export type AddNodeOp = {
  op: "add_node";
  nodeType: WingNodeType;
  title?: string;
  body?: string;
  /** 画布坐标；缺省时自动在现有内容右下侧找空位 */
  position?: { x: number; y: number };
  /** 指定 id（幂等用）；已存在则报错 */
  id?: string;
};

export type UpdateNodeOp = {
  op: "update_node";
  id: string;
  title?: string;
  body?: string;
};

export type DeleteNodesOp = {
  op: "delete_nodes";
  ids: string[];
};

export type ConnectNodesOp = {
  op: "connect_nodes";
  fromId: string;
  toId: string;
};

export type SetViewportOp = {
  op: "set_viewport";
  x: number;
  y: number;
  zoom?: number;
};

export type CanvasOp =
  | AddNodeOp
  | UpdateNodeOp
  | DeleteNodesOp
  | ConnectNodesOp
  | SetViewportOp;

export interface OpResult {
  applied: number;
  createdIds: string[];
  errors: string[];
}

const VALID_NODE_TYPES = Object.keys(NODE_META) as WingNodeType[];

/** 自动布点：在已有节点包围盒右侧或初始位置放新节点，避免重叠 */
function autoPosition(): { x: number; y: number } {
  const { nodes } = useCanvasStore.getState();
  if (nodes.length === 0) return { x: 0, y: 0 };
  const maxX = Math.max(...nodes.map((n) => n.position.x));
  const sameCol = nodes.filter((n) => Math.abs(n.position.x - maxX) < 8);
  const maxY = Math.max(...sameCol.map((n) => n.position.y));
  const tooClose = sameCol.some((n) => n.position.y >= maxY - 8);
  return tooClose
    ? { x: maxX + 340, y: 0 }
    : { x: maxX, y: maxY + 220 };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 把外部（agent 传来的）未知数据归一成 CanvasOp 数组；非法项记入 errors */
export function normalizeOps(
  raw: unknown,
  errors: string[] = [],
): CanvasOp[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray((raw as { ops?: unknown }).ops)
      ? ((raw as { ops: unknown[] }).ops)
      : null;
  if (!list) {
    errors.push("ops 必须是数组（或 { ops: [...] }）");
    return [];
  }
  return list.filter((item, i): item is CanvasOp => {
    if (!isRecord(item) || typeof item.op !== "string") {
      errors.push(`#${i}: 缺少 op 字段`);
      return false;
    }
    return true;
  });
}

/** 校验并逐条应用；返回执行报告（handler 返回给 agent，render 卡片也用它） */
export function applyOps(rawOps: unknown): OpResult {
  const errors: string[] = [];
  const ops = normalizeOps(rawOps, errors);
  const store = useCanvasStore.getState();
  let applied = 0;
  const createdIds: string[] = [];

  for (const op of ops) {
    try {
      switch (op.op) {
        case "add_node": {
          if (!VALID_NODE_TYPES.includes(op.nodeType)) {
            errors.push(
              `add_node: nodeType 必须是 ${VALID_NODE_TYPES.join(" / ")}，收到 "${String(op.nodeType)}"`,
            );
            break;
          }
          if (op.id && store.nodes.some((n) => n.id === op.id)) {
            errors.push(`add_node: 节点 ${op.id} 已存在`);
            break;
          }
          const pos = op.position ?? autoPosition();
          const id = store.addNode({
            id: op.id,
            position: pos,
            data: {
              nodeType: op.nodeType,
              title: (op.title ?? NODE_META[op.nodeType].hint).slice(0, 80),
              body: op.body ?? "",
            },
          });
          createdIds.push(id);
          applied += 1;
          break;
        }
        case "update_node": {
          const exists = store.nodes.some((n) => n.id === op.id);
          if (!exists) {
            errors.push(`update_node: 节点 ${op.id} 不存在`);
            break;
          }
          store.updateNodeData(op.id, {
            ...(op.title !== undefined ? { title: op.title.slice(0, 80) } : {}),
            ...(op.body !== undefined ? { body: op.body.slice(0, 4000) } : {}),
          });
          applied += 1;
          break;
        }
        case "delete_nodes": {
          if (!Array.isArray(op.ids) || op.ids.length === 0) {
            errors.push("delete_nodes: ids 不能为空");
            break;
          }
          const known = op.ids.filter((id) =>
            store.nodes.some((n) => n.id === id),
          );
          if (known.length === 0) {
            errors.push(`delete_nodes: 节点 ${op.ids.join(",")} 均不存在`);
            break;
          }
          store.deleteNodes(known);
          applied += 1;
          break;
        }
        case "connect_nodes": {
          const has = (id: string) => store.nodes.some((n) => n.id === id);
          if (!has(op.fromId) || !has(op.toId)) {
            errors.push(
              `connect_nodes: ${op.fromId} 或 ${op.toId} 不存在`,
            );
            break;
          }
          const dup = store.edges.some(
            (e) => e.source === op.fromId && e.target === op.toId,
          );
          if (!dup) {
            store.connect({ source: op.fromId, target: op.toId });
          }
          applied += 1;
          break;
        }
        case "set_viewport": {
          if (
            typeof op.x !== "number" ||
            typeof op.y !== "number" ||
            !Number.isFinite(op.x + op.y)
          ) {
            errors.push("set_viewport: x/y 必须是数字");
            break;
          }
          store.setViewport({
            x: op.x,
            y: op.y,
            zoom:
              typeof op.zoom === "number" && op.zoom > 0
                ? Math.min(Math.max(op.zoom, 0.2), 2)
                : store.viewport.zoom,
          });
          applied += 1;
          break;
        }
        default:
          errors.push(`未知 op: ${String((op as { op: string }).op)}`);
      }
    } catch (exc) {
      errors.push(`${(op as { op: string }).op} 执行异常: ${String(exc)}`);
    }
  }

  return { applied, createdIds, errors };
}
