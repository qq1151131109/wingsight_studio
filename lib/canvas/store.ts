"use client";

import { create } from "zustand";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";

/** 画布节点类型：便签 / 剧本 / 角色 / 图片占位 / 分镜 / 分组框 */
export type WingNodeType =
  | "note"
  | "script"
  | "character"
  | "image"
  | "storyboard"
  | "group";

export interface WingNodeData {
  nodeType: WingNodeType;
  title: string;
  body: string;
  imageUrl?: string;
  /** image 卡生命周期：占位(无图无状态) / loading / error / ready */
  status?: "loading" | "error" | "ready";
  errorMessage?: string;
  /** storyboard 卡：镜号（如 01）/ 景别（远景/全景/中景/近景/特写）/ 运镜（如 推、摇、跟）/ 时长（如 3s） */
  shotNumber?: string;
  shotSize?: string;
  cameraMove?: string;
  duration?: string;
  /** storyboard 卡：台词 / 旁白 */
  dialogue?: string;
  [key: string]: unknown;
}

export type WingNode = Node<WingNodeData>;
export type WingEdge = Edge;

/** 对齐模式：水平三档 / 垂直三档 */
export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** 一份可撤销的画布快照（不含 viewport——视图位置不入栈） */
interface CanvasSnapshot {
  nodes: WingNode[];
  edges: WingEdge[];
}

interface CanvasState {
  nodes: WingNode[];
  edges: WingEdge[];
  viewport: Viewport;
  /** 当前项目（服务端持久化）；null = 尚未初始化 */
  projectId: string | null;
  projectName: string;
  /** 初始装载完成前不同步到服务端 */
  hydrated: boolean;
  setProject: (id: string, name: string) => void;
  replaceCanvas: (
    nodes: WingNode[],
    edges: WingEdge[],
    viewport: Viewport,
  ) => void;
  setNodes: (nodes: WingNode[]) => void;
  addNode: (node: Omit<WingNode, "id"> & { id?: string }) => string;
  updateNodeData: (id: string, patch: Partial<WingNodeData>) => void;
  deleteNodes: (ids: string[]) => void;
  connect: (connection: Connection | { source: string; target: string }) => void;
  onNodesChange: (changes: NodeChange<WingNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<WingEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  setViewport: (viewport: Viewport) => void;
  /** 选中指定节点（单选语义：清掉其余选中；选中不入撤销栈） */
  selectNodes: (ids: string[]) => void;
  /** agent 建卡后的瞬时高亮（不入撤销栈、不持久化，超时自动熄灭） */
  flashIds: string[];
  flashNodes: (ids: string[]) => void;
  /** 多选对齐（按选择包围盒的左/中/右/顶/中/底）与等距分布 */
  alignNodes: (ids: string[], mode: AlignMode) => void;
  distributeNodes: (ids: string[], axis: "h" | "v") => void;
  /** 原地复制一份选中节点（Cmd+D） */
  duplicateSelection: () => string[];
  /** 打组：把 ids 收进新建分组框（parentId+extent，坐标转相对），返回组 id */
  groupNodes: (ids: string[], title?: string) => string | null;
  /** 解组：解散分组框删除组节点，子节点回画布层（坐标转绝对），返回子节点数 */
  ungroupNode: (id: string) => number;
  /** 撤销/重做（快照栈，上限 50） */
  undo: () => boolean;
  redo: () => boolean;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** 在语义操作前调用：把当前状态压入撤销栈 */
  commitHistory: () => void;
  /** 复制/粘贴（内部剪贴板：选中节点 + 连线 + 原点，粘贴时整体偏移） */
  copySelection: () => number;
  pasteClipboard: () => string[];
}

let idCounter = 0;
export function genNodeId(): string {
  idCounter += 1;
  return `n_${Date.now().toString(36)}_${idCounter}`;
}

const HISTORY_LIMIT = 50;
const PASTE_OFFSET = 32;

/** 模块级撤销栈与内部剪贴板（跨项目共享，简单优先） */
const history: { past: CanvasSnapshot[]; future: CanvasSnapshot[] } = {
  past: [],
  future: [],
};
let internalClipboard: CanvasSnapshot | null = null;
/** 拖拽会话防重入（一次拖动只 commit 一份"拖动前"快照） */
let dragCommitted = false;
/** flash 高亮的自动熄灭计时器 */
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function snapshot(state: CanvasState): CanvasSnapshot {
  return {
    nodes: structuredClone(state.nodes),
    edges: structuredClone(state.edges),
  };
}

/** 节点绝对画布坐标（沿 parentId 链累加；分组子节点坐标是相对父组的） */
export function absolutePosition(
  nodes: WingNode[],
  node: WingNode,
): { x: number; y: number } {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  let x = node.position.x;
  let y = node.position.y;
  let cur: WingNode | undefined = node;
  while (cur?.parentId) {
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    cur = parent;
  }
  return { x, y };
}

/** 估算卡片占位（打组算包围盒用；与渲染宽度近似即可） */
export const NODE_FOOTPRINT: Record<string, { w: number; h: number }> = {
  note: { w: 256, h: 150 },
  script: { w: 352, h: 260 },
  character: { w: 256, h: 150 },
  image: { w: 256, h: 260 },
  storyboard: { w: 320, h: 220 },
  group: { w: 480, h: 360 },
};

/** 节点集合的占位盒（绝对坐标 + 分组偏移差；对齐/分布与多选工具条定位共用） */
export function selectionBoxes(nodes: WingNode[], ids: string[]) {
  return nodes
    .filter((n) => ids.includes(n.id))
    .map((n) => {
      const abs = absolutePosition(nodes, n);
      const fp = NODE_FOOTPRINT[n.data.nodeType] ?? NODE_FOOTPRINT.note;
      return {
        id: n.id,
        x: abs.x,
        y: abs.y,
        w: fp.w,
        h: fp.h,
        dx: n.position.x - abs.x,
        dy: n.position.y - abs.y,
      };
    });
}

/** 全选（快捷键与右键菜单共用；不走 action 以免挤占撤销栈） */
export function selectAllNodes() {
  useCanvasStore.setState((s) => ({
    nodes: s.nodes.map((n) => ({ ...n, selected: true })),
  }));
}

export const useCanvasStore = create<CanvasState>()(
  (set, get) => ({
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      projectId: null,
      projectName: "",
      hydrated: false,

      setProject: (id, name) =>
        set({ projectId: id, projectName: name, hydrated: false }),

      replaceCanvas: (nodes, edges, viewport) => {
        // 项目切换/装载：撤销栈跨项目无意义
        history.past = [];
        history.future = [];
        set((state) => ({
          nodes,
          edges,
          viewport,
          hydrated: true,
          projectId: state.projectId,
        }));
      },

      setNodes: (nodes) => set({ nodes }),

      commitHistory: () => {
        const snap = snapshot(get());
        history.past.push(snap);
        if (history.past.length > HISTORY_LIMIT) history.past.shift();
        history.future = [];
      },

      undo: () => {
        const prev = history.past.pop();
        if (!prev) return false;
        history.future.push(snapshot(get()));
        set({ nodes: prev.nodes, edges: prev.edges });
        return true;
      },

      redo: () => {
        const next = history.future.pop();
        if (!next) return false;
        history.past.push(snapshot(get()));
        set({ nodes: next.nodes, edges: next.edges });
        return true;
      },

      canUndo: () => history.past.length > 0,
      canRedo: () => history.future.length > 0,

      copySelection: () => {
        const { nodes } = get();
        const selected = nodes.filter((n) => n.selected);
        if (selected.length === 0) return 0;
        const ids = new Set(selected.map((n) => n.id));
        internalClipboard = {
          nodes: structuredClone(selected),
          edges: structuredClone(get().edges.filter(
            (e) => ids.has(e.source) && ids.has(e.target),
          )),
        };
        return selected.length;
      },

      pasteClipboard: () => {
        if (!internalClipboard) return [];
        get().commitHistory();
        const idMap = new Map<string, string>();
        const newNodes = internalClipboard.nodes.map((n) => {
          const id = genNodeId();
          idMap.set(n.id, id);
          return {
            ...structuredClone(n),
            id,
            selected: true,
            position: { x: n.position.x + PASTE_OFFSET, y: n.position.y + PASTE_OFFSET },
          } as WingNode;
        });
        const newEdges = internalClipboard.edges.map((e) => ({
          ...structuredClone(e),
          id: `e_${genNodeId()}`,
          source: idMap.get(e.source) ?? e.source,
          target: idMap.get(e.target) ?? e.target,
        }));
        set((state) => ({
          nodes: [
            ...state.nodes.map((n) => ({ ...n, selected: false })),
            ...newNodes,
          ],
          edges: [...state.edges, ...newEdges],
        }));
        return newNodes.map((n) => n.id);
      },

      addNode: (node) => {
        const id = node.id ?? genNodeId();
        // React Flow 靠 node.type 选自定义渲染器；调用方只给 data.nodeType 时自动推导
        const type = node.type ?? node.data?.nodeType ?? "note";
        get().commitHistory();
        set((state) => ({
          nodes: [...state.nodes, { ...node, id, type } as WingNode],
        }));
        return id;
      },

      updateNodeData: (id, patch) => {
        get().commitHistory();
        set((state) => ({
          nodes: state.nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
          ),
        }));
      },

      deleteNodes: (ids) => {
        const idSet = new Set(ids);
        get().commitHistory();
        set((state) => {
          // 删除分组框时提升存活子节点到画布层（坐标转绝对），避免孤儿 parentId
          const promoted = state.nodes.flatMap((g) => {
            if (!idSet.has(g.id) || g.data.nodeType !== "group") return [];
            return state.nodes
              .filter((c) => c.parentId === g.id && !idSet.has(c.id))
              .map((c) => ({
                ...structuredClone(c),
                parentId: undefined,
                extent: undefined,
                position: { x: g.position.x + c.position.x, y: g.position.y + c.position.y },
              })) as WingNode[];
          });
          const promotedIds = new Set(promoted.map((p) => p.id));
          return {
            nodes: [
              ...state.nodes.filter((n) => !idSet.has(n.id) && !promotedIds.has(n.id)),
              ...promoted,
            ],
            edges: state.edges.filter(
              (e) => !idSet.has(e.source) && !idSet.has(e.target),
            ),
          };
        });
      },

      groupNodes: (ids, title) => {
        const state = get();
        const targets = state.nodes.filter((n) => ids.includes(n.id));
        if (targets.length === 0) return null;
        // 绝对坐标算包围盒（混入已分组节点时按绝对坐标展开）
        const absById = new Map(
          targets.map((t) => [t.id, absolutePosition(state.nodes, t)] as const),
        );
        const boxes = targets.map((n) => {
          const abs = absById.get(n.id)!;
          const fp = NODE_FOOTPRINT[n.data.nodeType] ?? NODE_FOOTPRINT.note;
          return { x: abs.x, y: abs.y, w: fp.w, h: fp.h };
        });
        const minX = Math.min(...boxes.map((b) => b.x));
        const minY = Math.min(...boxes.map((b) => b.y));
        const maxX = Math.max(...boxes.map((b) => b.x + b.w));
        const maxY = Math.max(...boxes.map((b) => b.y + b.h));
        const pad = 36;
        const groupId = genNodeId();
        const groupNode: WingNode = {
          id: groupId,
          type: "group",
          position: { x: minX - pad, y: minY - pad - 22 },
          style: { width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 + 22 },
          data: { nodeType: "group", title: title ?? "分组", body: "" },
        };
        const targetIds = new Set(targets.map((t) => t.id));
        get().commitHistory();
        set((s) => ({
          nodes: [
            ...s.nodes.map((n) =>
              targetIds.has(n.id)
                ? ({
                    ...structuredClone(n),
                    parentId: groupId,
                    extent: "parent",
                    position: {
                      x: (absById.get(n.id)?.x ?? n.position.x) - groupNode.position.x,
                      y: (absById.get(n.id)?.y ?? n.position.y) - groupNode.position.y,
                    },
                  } as WingNode)
                : n,
            ),
            groupNode,
          ],
        }));
        return groupId;
      },

      ungroupNode: (id) => {
        const state = get();
        const group = state.nodes.find(
          (n) => n.id === id && n.data.nodeType === "group",
        );
        if (!group) return 0;
        const children = state.nodes.filter((n) => n.parentId === id);
        if (children.length === 0) return 0;
        get().commitHistory();
        set((s) => ({
          nodes: s.nodes.flatMap((n) => {
            if (n.id === id) return [];
            if (n.parentId !== id) return [n];
            return [{
              ...structuredClone(n),
              parentId: undefined,
              extent: undefined,
              position: { x: group.position.x + n.position.x, y: group.position.y + n.position.y },
            } as WingNode];
          }),
        }));
        return children.length;
      },

      connect: (connection) => {
        get().commitHistory();
        set((state) => ({
          edges: addEdge(
            {
              id: `e_${connection.source}_${connection.target}_${Date.now().toString(36)}`,
              source: connection.source,
              target: connection.target,
            },
            state.edges,
          ),
        }));
      },

      onNodesChange: (changes) => {
        // 拖拽会话只在开始帧提交一次快照（松手前的中间帧不入栈）
        const hasDrag = changes.some(
          (c) => c.type === "position" && c.dragging === true,
        );
        const dragEnded = changes.some(
          (c) => c.type === "position" && c.dragging === false,
        );
        if (hasDrag && !dragCommitted) {
          get().commitHistory();
          dragCommitted = true;
        }
        if (dragEnded) dragCommitted = false;
        set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) }));
      },

      onEdgesChange: (changes) =>
        set((state) => ({ edges: applyEdgeChanges(changes, state.edges) })),

      onConnect: (connection) => get().connect(connection),

      setViewport: (viewport) => set({ viewport }),

      selectNodes: (ids) => {
        const idSet = new Set(ids);
        set((s) => ({
          nodes: s.nodes.map((n) => ({ ...n, selected: idSet.has(n.id) })),
        }));
      },

      flashIds: [],
      flashNodes: (ids) => {
        set({ flashIds: ids });
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => set({ flashIds: [] }), 3200);
      },

      alignNodes: (ids, mode) => {
        const state = get();
        const targets = state.nodes.filter((n) => ids.includes(n.id));
        if (targets.length < 2) return;
        const boxes = selectionBoxes(state.nodes, targets.map((t) => t.id));
        const minX = Math.min(...boxes.map((b) => b.x));
        const maxX = Math.max(...boxes.map((b) => b.x + b.w));
        const minY = Math.min(...boxes.map((b) => b.y));
        const maxY = Math.max(...boxes.map((b) => b.y + b.h));
        const isH = mode === "left" || mode === "hcenter" || mode === "right";
        const targetX = (b: (typeof boxes)[number]) =>
          mode === "left" ? minX : mode === "right" ? maxX - b.w : (minX + maxX) / 2 - b.w / 2;
        const targetY = (b: (typeof boxes)[number]) =>
          mode === "top" ? minY : mode === "bottom" ? maxY - b.h : (minY + maxY) / 2 - b.h / 2;
        get().commitHistory();
        set((s) => ({
          nodes: s.nodes.map((n) => {
            const b = boxes.find((x) => x.id === n.id);
            if (!b) return n;
            // 分组子节点坐标是相对父组的：绝对目标值减回父组偏移（dx/dy 记录了 pos-abs 差）
            return {
              ...n,
              position: {
                x: isH ? targetX(b) - b.dx : n.position.x,
                y: !isH ? targetY(b) - b.dy : n.position.y,
              },
            };
          }),
        }));
      },

      distributeNodes: (ids, axis) => {
        const state = get();
        const targets = state.nodes.filter((n) => ids.includes(n.id));
        if (targets.length < 3) return;
        const boxes = selectionBoxes(state.nodes, targets.map((t) => t.id));
        const key = axis === "h" ? "x" : "y";
        const sorted = [...boxes].sort((a, b) => a[key] - b[key]);
        const lead = sorted[0];
        const tail = sorted[sorted.length - 1];
        const leadC = lead[key] + lead.w / 2;
        const step = (tail[key] + tail.w / 2 - leadC) / (sorted.length - 1);
        const byId = new Map(sorted.map((b, i) => [b.id, i] as const));
        get().commitHistory();
        set((s) => ({
          nodes: s.nodes.map((n) => {
            const i = byId.get(n.id);
            if (i === undefined) return n;
            const b = sorted[i];
            if (axis === "h") {
              const center = leadC + step * i;
              return { ...n, position: { x: center - b.w / 2 - b.dx, y: n.position.y } };
            }
            const center = leadC + step * i;
            return { ...n, position: { x: n.position.x, y: center - b.h / 2 - b.dy } };
          }),
        }));
      },

      duplicateSelection: () => {
        if (get().copySelection() === 0) return [];
        return get().pasteClipboard();
      },

    }));

/** 节点类型的展示元数据（徽标名 / 徽标色） */
export const NODE_META: Record<
  WingNodeType,
  { label: string; dot: string; hint: string }
> = {
  note: { label: "便签", dot: "var(--color-warm)", hint: "随手的想法与备注" },
  script: { label: "剧本", dot: "var(--color-accent)", hint: "故事大纲或分场剧本" },
  character: { label: "角色", dot: "var(--color-good)", hint: "角色设定卡" },
  image: { label: "图片", dot: "var(--color-warn)", hint: "设定图 / 参考图占位" },
  storyboard: { label: "分镜", dot: "var(--color-accent-2)", hint: "镜头画面描述" },
  group: { label: "分组", dot: "var(--color-text-3)", hint: "收纳相关卡片" },
};

/** 画布摘要（给 agent 的读通道，压缩到预算内） */
export function summarizeCanvas(
  nodes: WingNode[],
  edges: WingEdge[],
  selectedIds: string[],
  budget = 2000,
): string {
  if (nodes.length === 0) return "（画布为空）";
  const lines: string[] = [];
  lines.push(`节点 ${nodes.length} 个，连线 ${edges.length} 条：`);
  for (const n of nodes) {
    const meta = NODE_META[n.data.nodeType];
    const title = n.data.title.slice(0, 30) || "（无标题）";
    const shotFields =
      n.data.nodeType === "storyboard"
        ? [
            n.data.shotNumber ? `#${n.data.shotNumber}` : "",
            n.data.shotSize ?? "",
            n.data.cameraMove ?? "",
            n.data.duration ?? "",
          ].filter(Boolean)
        : [];
    const shot = shotFields.length > 0 ? `（${shotFields.join("·")}）` : "";
    const kids =
      n.data.nodeType === "group"
        ? `（含 ${nodes.filter((c) => c.parentId === n.id).length} 卡）`
        : "";
    const body = n.data.body ? ` “${n.data.body.slice(0, 40)}”` : "";
    const sel = selectedIds.includes(n.id) ? " [选中]" : "";
    lines.push(`- ${n.id} [${meta.label}] ${title}${shot}${kids}${body}${sel}`);
  }
  for (const e of edges) {
    lines.push(`- 连线 ${e.source} → ${e.target}`);
  }
  let text = lines.join("\n");
  if (text.length > budget) text = text.slice(0, budget) + "\n…（已截断）";
  return text;
}
