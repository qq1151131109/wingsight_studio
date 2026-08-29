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

/** 画布节点类型：文本 / 剧本 / 角色 / 图片 / 视频 / 音频 / 合成 / 分镜 / 分镜表 / 分组框 */
export type WingNodeType =
  | "note"
  | "script"
  | "character"
  | "image"
  | "video"
  | "audio"
  | "compose"
  | "storyboard"
  | "shotlist"
  | "group";

/** 分镜表的一行（一个镜头） */
export interface ShotRow {
  rid: string;
  shotSize?: string;
  cameraMove?: string;
  duration?: string;
  action?: string;
  dialogue?: string;
  /** 该镜头的出图结果（镜头级生成回填） */
  imageUrl?: string;
}

export interface WingNodeData {
  nodeType: WingNodeType;
  title: string;
  body: string;
  imageUrl?: string;
  /** video 卡：视频源（生成或上传回填）；imageUrl 可作封面帧 */
  videoUrl?: string;
  /** audio 卡：音频源（上传回填）；compose 卡：合成结果也存这里 */
  audioUrl?: string;
  /** compose 卡：上游视频节点的拼接顺序（未列出的连线源追加在尾部） */
  itemIds?: string[];
  /** image 卡：一次生成的多张候选（imageUrl 恒等于候选[primaryIndex]） */
  imageUrls?: string[];
  primaryIndex?: number;
  /** 历史版本（每次重生成前把当前主图存档；对比/回滚用） */
  versions?: { url: string; at: string }[];
  /** 锁定：不可拖动、不可改标题（卡上工具条切换） */
  locked?: boolean;
  /** 分镜表：镜头行 */
  rows?: ShotRow[];
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
  /** 撤销/重做可用性（响应式，按钮禁用态用；随历史栈变化维护） */
  canUndoNow: boolean;
  canRedoNow: boolean;
  /** 在语义操作前调用：把当前状态压入撤销栈 */
  commitHistory: () => void;
  /** 服务端保存状态（ProjectManager 写，画布上的保存指示器读） */
  saveState: "idle" | "saving" | "saved" | "offline";
  setSaveState: (s: CanvasState["saveState"]) => void;
  /** @引用光环：选中生成卡时高亮它引用的卡片（瞬态，不入撤销栈） */
  haloIds: string[];
  setHaloIds: (ids: string[]) => void;
  /** 拖动对齐辅助线（流坐标；瞬态） */
  alignGuides: { x: number[]; y: number[] };
  setAlignGuides: (g: { x: number[]; y: number[] }) => void;
  /** 内部剪贴板是否有内容（右键"粘贴"菜单的禁用态） */
  clipboardCount: number;
  /** 方向键微调选中节点（连续按键合并为一次撤销单元） */
  nudgeSelection: (dx: number, dy: number) => void;
  clearSelection: () => void;
  /** Z 序：置顶/置底 */
  bringToFront: (ids: string[]) => void;
  sendToBack: (ids: string[]) => void;
  /** 重接线：拖动连线端点换到新节点 */
  reconnectEdge: (edgeId: string, connection: { source: string; target: string }) => void;
  /** 转换节点类型（保留数据与连线） */
  convertNodeType: (id: string, type: WingNodeType) => void;
  /** 折叠/展开分组：折叠时隐藏子卡并把组缩成胶囊（原尺寸存 data.prevSize） */
  toggleGroupCollapse: (id: string) => void;
  /** 拖动结束后重定父级：中心落入其他分组框 → 收编；完全拖出本组 → 提升回画布层 */
  reparentAfterDrag: (ids: string[]) => void;
  /** Alt+拖拽复制（Figma 手势）：拖动开始时原位克隆选区并选中副本，
      之后本组件的拖动帧经 onNodesChange 改道到副本，原件留在原地 */
  beginAltDragClone: (draggedId: string) => void;
  /** 结束 Alt 拖拽手势（清掉原→副本改道表；正常路径拖动结束帧也会清） */
  endAltDrag: () => void;
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

/** 模块级撤销栈与内部剪贴板（跨项目共享，简单优先） */
const history: { past: CanvasSnapshot[]; future: CanvasSnapshot[] } = {
  past: [],
  future: [],
};
let internalClipboard: CanvasSnapshot | null = null;
/** 拖拽会话防重入（一次拖动只 commit 一份"拖动前"快照） */
let dragCommitted = false;
/** Alt 拖拽复制会话：原件 id → 副本 id（拖动期间把原件的 position 帧改道到副本） */
let altDragClone: Map<string, string> | null = null;
/** flash 高亮的自动熄灭计时器 */
let flashTimer: ReturnType<typeof setTimeout> | null = null;
/** 方向键微调的连击窗口（800ms 内算一次撤销单元） */
let lastNudgeAt = 0;

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
  note: { w: 280, h: 170 },
  script: { w: 352, h: 260 },
  character: { w: 256, h: 300 },
  image: { w: 256, h: 260 },
  video: { w: 320, h: 300 },
  audio: { w: 280, h: 190 },
  compose: { w: 320, h: 280 },
  storyboard: { w: 320, h: 220 },
  shotlist: { w: 560, h: 420 },
  group: { w: 480, h: 360 },
};

/** 卡片创建/装载时的默认尺寸（resize 前提：包装层有显式宽高，卡片内容撑满）。
 *  宽高缺一个补一个：老卡只有宽没有高，会塌成一条（内容高度） */
function withDefaultSize(n: WingNode): WingNode {
  const fp = NODE_FOOTPRINT[n.data?.nodeType];
  if (!fp || (n.style?.width && n.style?.height)) return n;
  return {
    ...n,
    style: {
      ...n.style,
      ...(n.style?.width ? {} : { width: fp.w }),
      ...(n.style?.height ? {} : { height: fp.h }),
    },
  };
}

/** 节点实际尺寸。xyflow v12 的 resize 回写的是顶层 width/height + measured
 *  （applyNodeChanges 不写 style），style 只是创建时的默认值——
 *  优先级 measured > 顶层 > style > 类型足迹，所有尺寸读取一律走这里 */
export function nodeSize(n: WingNode): { w: number; h: number } {
  const fp = NODE_FOOTPRINT[n.data?.nodeType] ?? NODE_FOOTPRINT.note;
  return {
    w: n.measured?.width ?? n.width ?? (Number(n.style?.width) || fp.w),
    h: n.measured?.height ?? n.height ?? (Number(n.style?.height) || fp.h),
  };
}

/** 节点集合的占位盒（绝对坐标 + 分组偏移差；对齐/分布与多选工具条定位共用） */
export function selectionBoxes(nodes: WingNode[], ids: string[]) {
  return nodes
    .filter((n) => ids.includes(n.id))
    .map((n) => {
      const abs = absolutePosition(nodes, n);
      return {
        id: n.id,
        x: abs.x,
        y: abs.y,
        w: nodeSize(n).w,
        h: nodeSize(n).h,
        dx: n.position.x - abs.x,
        dy: n.position.y - abs.y,
      };
    });
}

/** 粘贴/复制的落位偏移：默认 +32/+32，与现有卡片重叠时螺旋找空位（对标 S-Copilot） */
function findPasteOffset(
  clipNodes: WingNode[],
  existing: WingNode[],
): { x: number; y: number } {
  const box = (n: WingNode) => {
    const size = nodeSize(n);
    return {
      x: n.position.x,
      y: n.position.y,
      w: size.w,
      h: size.h,
    };
  };
  const clips = clipNodes.map(box);
  const occupied = existing.map(box);
  const margin = 8;
  const hit = (dx: number, dy: number) =>
    occupied.some((o) =>
      clips.some(
        (c) =>
          c.x + dx < o.x + o.w + margin &&
          c.x + dx + c.w + margin > o.x &&
          c.y + dy < o.y + o.h + margin &&
          c.y + dy + c.h + margin > o.y,
      ),
    );
  for (const [x, y] of [
    [32, 32],
    [64, 32],
    [32, 64],
    [64, 64],
  ]) {
    if (!hit(x, y)) return { x, y };
  }
  for (let step = 1; step <= 12; step++) {
    const x = 24 + step * 26;
    const y = 16 + step * 18;
    if (!hit(x, y)) return { x, y };
  }
  return { x: 32, y: 32 };
}

/** 全选（快捷键与右键菜单共用；不走 action 以免挤占撤销栈） */
export function selectAllNodes() {
  useCanvasStore.setState((s) => ({
    nodes: s.nodes.map((n) => ({ ...n, selected: true })),
  }));
}

/** 拖动对齐吸附阈值（流坐标 px） */
const SNAP_THRESHOLD = 6;

/** 单轴吸附：节点的前缘/中心/后缘 vs 参考线，取最小偏差 */
function axisSnap(
  pos: number,
  size: number,
  refs: number[],
): { delta: number; line: number } | null {
  let best: { delta: number; line: number } | null = null;
  for (const p of [pos, pos + size / 2, pos + size]) {
    for (const r of refs) {
      const d = r - p;
      if (
        Math.abs(d) <= SNAP_THRESHOLD &&
        (!best || Math.abs(d) < Math.abs(best.delta))
      ) {
        best = { delta: d, line: r };
      }
    }
  }
  return best;
}

export const useCanvasStore = create<CanvasState>()(
  (set, get) => ({
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      projectId: null,
      projectName: "",
      hydrated: false,
      canUndoNow: false,
      canRedoNow: false,
      saveState: "idle",
      haloIds: [],
      alignGuides: { x: [], y: [] },
      clipboardCount: 0,

      setSaveState: (saveState) => set({ saveState }),
      setHaloIds: (ids) => set({ haloIds: ids }),
      setAlignGuides: (g) => set({ alignGuides: g }),

      setProject: (id, name) =>
        set({ projectId: id, projectName: name, hydrated: false }),

      replaceCanvas: (nodes, edges, viewport) => {
        // 项目切换/装载：撤销栈跨项目无意义；旧项目补默认宽度（resize 依赖）
        history.past = [];
        history.future = [];
        set((state) => ({
          nodes: nodes.map(withDefaultSize),
          edges,
          viewport,
          hydrated: true,
          projectId: state.projectId,
          canUndoNow: false,
          canRedoNow: false,
          saveState: "idle",
          haloIds: [],
          alignGuides: { x: [], y: [] },
        }));
      },

      setNodes: (nodes) => set({ nodes }),

      commitHistory: () => {
        const snap = snapshot(get());
        history.past.push(snap);
        if (history.past.length > HISTORY_LIMIT) history.past.shift();
        history.future = [];
        set({ canUndoNow: true, canRedoNow: false });
      },

      undo: () => {
        const prev = history.past.pop();
        if (!prev) return false;
        history.future.push(snapshot(get()));
        set({
          nodes: prev.nodes,
          edges: prev.edges,
          canUndoNow: history.past.length > 0,
          canRedoNow: true,
        });
        return true;
      },

      redo: () => {
        const next = history.future.pop();
        if (!next) return false;
        history.past.push(snapshot(get()));
        set({
          nodes: next.nodes,
          edges: next.edges,
          canUndoNow: true,
          canRedoNow: history.future.length > 0,
        });
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
        set({ clipboardCount: selected.length });
        return selected.length;
      },

      pasteClipboard: () => {
        if (!internalClipboard) return [];
        get().commitHistory();
        // 与现有卡片重叠时螺旋找空位，避免贴在原卡上
        const offset = findPasteOffset(
          internalClipboard.nodes,
          get().nodes,
        );
        // 先建全量 id 映射再粘贴：选区内含"分组+子卡"时，子卡副本 parentId
        // 改指向组副本（同 beginAltDragClone 的处理）
        const idMap = new Map(
          internalClipboard.nodes.map((n) => [n.id, genNodeId()] as const),
        );
        const newNodes = internalClipboard.nodes.map((n) => {
          const parentId =
            n.parentId && idMap.has(n.parentId)
              ? idMap.get(n.parentId)
              : n.parentId;
          return {
            ...structuredClone(n),
            id: idMap.get(n.id)!,
            parentId,
            selected: true,
            position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
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
          nodes: [...state.nodes, withDefaultSize({ ...node, id, type } as WingNode)],
        }));
        return id;
      },

      updateNodeData: (id, patch) => {
        get().commitHistory();
        let readyFlip = false;
        set((state) => ({
          nodes: state.nodes.map((n) => {
            if (n.id !== id) return n;
            // 生成完成（loading→ready）闪一下，把注意力拉回这张卡
            if (patch.status === "ready" && n.data.status === "loading") {
              readyFlip = true;
            }
            return { ...n, data: { ...n.data, ...patch } };
          }),
        }));
        if (readyFlip) get().flashNodes([id]);
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
                    // 不设 extent:"parent"：夹死会让子卡拖不出框；
                    // 拖出/拖入语义由 reparentAfterDrag 在拖动结束时判定
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
        // 拖拽/缩放会话只在开始帧提交一次快照（松手前的中间帧不入栈）
        const hasDrag = changes.some(
          (c) => c.type === "position" && c.dragging === true,
        );
        const hasResize = changes.some(
          (c) => c.type === "dimensions" && c.resizing === true,
        );
        const gestureEnded = changes.some(
          (c) =>
            (c.type === "position" && c.dragging === false) ||
            (c.type === "dimensions" && c.resizing === false),
        );
        if ((hasDrag || hasResize) && !dragCommitted) {
          get().commitHistory();
          dragCommitted = true;
        }

        // Alt 拖拽复制期间：原件的拖动/缩放帧改道到副本。注意顺序——RF 在拖动
        // 结束帧（dragging:false）仍会带原件 id 和最终落点位置，必须先改道、
        // 后清表，否则原件会被瞬间拽到落点
        let applied = altDragClone
          ? changes.map((c) =>
              (c.type === "position" || c.type === "dimensions") &&
              altDragClone!.has(c.id)
                ? ({ ...c, id: altDragClone!.get(c.id)! } as NodeChange<WingNode>)
                : c,
            )
          : changes;

        if (gestureEnded) {
          dragCommitted = false;
          // Alt 拖拽手势结束：本批已改道完毕，停用改道表
          if (altDragClone) altDragClone = null;
        }

        // 拖动对齐辅助线：单节点（顶层）拖动时吸附其他顶层卡的边/中心
        let guides: { x: number[]; y: number[] } | null = null;
        if (hasDrag) {
          const drags = applied.filter(
            (
              c,
            ): c is Extract<NodeChange<WingNode>, { type: "position" }> & {
              position: { x: number; y: number };
            } => c.type === "position" && c.dragging === true && !!c.position,
          );
          const state = get();
          const self =
            drags.length === 1
              ? state.nodes.find((n) => n.id === drags[0].id)
              : undefined;
          if (self && !self.parentId) {
            const others = state.nodes.filter(
              (n) => n.id !== self.id && !n.parentId,
            );
            const refsX: number[] = [];
            const refsY: number[] = [];
            for (const o of selectionBoxes(
              state.nodes,
              others.map((o) => o.id),
            )) {
              refsX.push(o.x, o.x + o.w / 2, o.x + o.w);
              refsY.push(o.y, o.y + o.h / 2, o.y + o.h);
            }
            const w = nodeSize(self).w;
            const h = nodeSize(self).h;
            const sx = axisSnap(drags[0].position.x, w, refsX);
            const sy = axisSnap(drags[0].position.y, h, refsY);
            guides = { x: sx ? [sx.line] : [], y: sy ? [sy.line] : [] };
            if (sx || sy) {
              applied = applied.map((c) => {
                if (c.type !== "position" || c.id !== self.id) return c;
                const p = (c as { position?: { x: number; y: number } }).position;
                if (!p) return c;
                return {
                  ...c,
                  position: {
                    x: p.x + (sx?.delta ?? 0),
                    y: p.y + (sy?.delta ?? 0),
                  },
                };
              });
            }
          } else {
            guides = { x: [], y: [] };
          }
        }
        if (gestureEnded) guides = { x: [], y: [] };

        set((state) => ({
          nodes: applyNodeChanges(applied, state.nodes),
          ...(guides ? { alignGuides: guides } : {}),
        }));
        // 拖动结束：判定拖入其他分组（收编）/ 拖出本组（提升）
        if (gestureEnded) {
          const endedIds = applied
            .filter(
              (c): c is Extract<NodeChange<WingNode>, { type: "position" }> =>
                c.type === "position" && c.dragging === false,
            )
            .map((c) => c.id)
            .filter((x): x is string => Boolean(x));
          if (endedIds.length > 0) get().reparentAfterDrag(endedIds);
        }
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

      beginAltDragClone: (draggedId) => {
        const state = get();
        const dragged = state.nodes.find((n) => n.id === draggedId);
        if (!dragged) return;
        // 拖动卡在选区内 → 克隆整个选区（含内部连线）；否则只克隆这张卡
        const ids = new Set(
          dragged.selected
            ? state.nodes.filter((n) => n.selected).map((n) => n.id)
            : [draggedId],
        );
        const originals = state.nodes.filter((x) => ids.has(x.id));
        // 先建全量 id 映射再克隆：父分组也在选区内时，子卡副本的 parentId
        // 要改指向组副本（否则拖走的是空组、子卡散落提升出原组）
        const idMap = new Map(originals.map((n) => [n.id, genNodeId()] as const));
        const copies: WingNode[] = originals.map((n) => {
          const cloned = structuredClone(n);
          const parentId =
            cloned.parentId && idMap.has(cloned.parentId)
              ? idMap.get(cloned.parentId)
              : cloned.parentId;
          // 副本原位生成，随后的拖动帧带着它们走；parentId 一并处理（组内克隆仍回组内）
          return {
            ...cloned,
            id: idMap.get(cloned.id)!,
            parentId,
            selected: true,
            dragging: true,
          };
        });
        const newEdges = state.edges
          .filter((e) => ids.has(e.source) && ids.has(e.target))
          .map((e) => ({
            ...structuredClone(e),
            id: `e_${genNodeId()}`,
            source: idMap.get(e.source) ?? e.source,
            target: idMap.get(e.target) ?? e.target,
          }));
        altDragClone = idMap;
        // 克隆+移动合并为一次撤销：克隆前提交快照，并拦掉拖动首帧的重复提交
        get().commitHistory();
        dragCommitted = true;
        set((s) => ({
          nodes: [
            ...s.nodes.map((n) => ({ ...n, selected: false, dragging: false })),
            ...copies,
          ],
          edges: [...s.edges, ...newEdges],
        }));
      },

      endAltDrag: () => {
        altDragClone = null;
      },

      nudgeSelection: (dx, dy) => {
        const state = get();
        if (!state.nodes.some((n) => n.selected)) return;
        // 800ms 内的连续按键合并为一次撤销单元
        const now = Date.now();
        if (now - lastNudgeAt > 800) get().commitHistory();
        lastNudgeAt = now;
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.selected
              ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
              : n,
          ),
        }));
      },

      clearSelection: () =>
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.selected ? { ...n, selected: false } : n,
          ),
        })),

      bringToFront: (ids) => {
        const state = get();
        const targets = state.nodes.filter((n) => ids.includes(n.id));
        if (targets.length === 0) return;
        const maxZ = Math.max(0, ...state.nodes.map((n) => n.zIndex ?? 0));
        get().commitHistory();
        const order = new Map(
          targets.map((t, i) => [t.id, maxZ + 1 + i] as const),
        );
        set((s) => ({
          nodes: s.nodes.map((n) =>
            order.has(n.id) ? { ...n, zIndex: order.get(n.id) } : n,
          ),
        }));
      },

      sendToBack: (ids) => {
        const state = get();
        const targets = state.nodes.filter((n) => ids.includes(n.id));
        if (targets.length === 0) return;
        const minZ = Math.min(0, ...state.nodes.map((n) => n.zIndex ?? 0));
        get().commitHistory();
        const order = new Map(
          targets.map((t, i) => [t.id, minZ - (targets.length - i)] as const),
        );
        set((s) => ({
          nodes: s.nodes.map((n) =>
            order.has(n.id) ? { ...n, zIndex: order.get(n.id) } : n,
          ),
        }));
      },

      reconnectEdge: (edgeId, connection) => {
        get().commitHistory();
        set((s) => ({
          edges: s.edges.map((e) =>
            e.id === edgeId
              ? { ...e, source: connection.source, target: connection.target }
              : e,
          ),
        }));
      },

      convertNodeType: (id, type) => {
        get().commitHistory();
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === id
              ? { ...n, type, data: { ...n.data, nodeType: type } }
              : n,
          ),
        }));
      },

      toggleGroupCollapse: (id) => {
        const state = get();
        const group = state.nodes.find(
          (n) => n.id === id && n.data.nodeType === "group",
        );
        if (!group) return;
        const collapsing = !group.data.collapsed;
        const prev = group.data.prevSize as { w: number; h: number } | undefined;
        get().commitHistory();
        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id === id) {
              if (collapsing) {
                return {
                  ...n,
                  style: { width: 172, height: 40 },
                  data: {
                    ...n.data,
                    collapsed: true,
                    prevSize: {
                      w: nodeSize(group).w,
                      h: nodeSize(group).h,
                    },
                  },
                };
              }
              return {
                ...n,
                style: {
                  width: prev?.w ?? nodeSize(group).w,
                  height: prev?.h ?? nodeSize(group).h,
                },
                data: { ...n.data, collapsed: false, prevSize: undefined },
              };
            }
            if (n.parentId === id) {
              return { ...n, hidden: collapsing, selected: collapsing ? false : n.selected };
            }
            return n;
          }),
        }));
      },

      reparentAfterDrag: (ids) => {
        const state = get();
        const groups = state.nodes.filter((n) => n.data.nodeType === "group");
        let changed = false;
        const next = state.nodes.map((n) => ({ ...n }));
        const byId = new Map(next.map((n) => [n.id, n] as const));
        for (const id of ids) {
          const n = byId.get(id);
          if (!n || n.data.nodeType === "group") continue;
          const parent = n.parentId ? byId.get(n.parentId) : undefined;
          const absX = n.position.x + (parent?.position.x ?? 0);
          const absY = n.position.y + (parent?.position.y ?? 0);
          const w = nodeSize(n).w;
          const h = nodeSize(n).h;
          // 中心落入其他分组框 → 收编（Figma 式 frame 包含语义）
          const cx = absX + w / 2;
          const cy = absY + h / 2;
          const target = groups.find((g) => {
            if (g.id === n.parentId) return false;
            const gw = nodeSize(g).w;
            const gh = nodeSize(g).h;
            return (
              cx >= g.position.x &&
              cx <= g.position.x + gw &&
              cy >= g.position.y &&
              cy <= g.position.y + gh
            );
          });
          if (target && !target.data.collapsed) {
            n.parentId = target.id;
            n.extent = undefined;
            n.position = { x: absX - target.position.x, y: absY - target.position.y };
            changed = true;
            continue;
          }
          // 完全拖出本组（留 24px 容差）→ 提升回画布层
          if (parent) {
            const pw = nodeSize(parent).w;
            const ph = nodeSize(parent).h;
            const margin = 24;
            const out =
              n.position.x + w < -margin ||
              n.position.x > pw + margin ||
              n.position.y + h < -margin ||
              n.position.y > ph + margin;
            if (out) {
              n.parentId = undefined;
              n.extent = undefined;
              n.position = { x: absX, y: absY };
              changed = true;
            }
          }
        }
        if (changed) set({ nodes: next });
      },

    }));

/** 节点类型的展示元数据（徽标名 / 徽标色） */
export const NODE_META: Record<
  WingNodeType,
  { label: string; dot: string; hint: string }
> = {
  note: { label: "文本", dot: "var(--color-warm)", hint: "自由文本" },
  script: { label: "剧本", dot: "var(--color-accent)", hint: "故事大纲或分场剧本" },
  character: { label: "角色", dot: "var(--color-good)", hint: "角色设定卡" },
  image: { label: "图片", dot: "var(--color-warn)", hint: "设定图 / 参考图占位" },
  video: { label: "视频", dot: "var(--color-cool)", hint: "镜头视频 / 动态预览" },
  audio: { label: "音频", dot: "var(--color-danger)", hint: "配音 / 音效 / BGM" },
  compose: { label: "合成", dot: "var(--color-text-3)", hint: "按序拼接上游视频成片" },
  storyboard: { label: "分镜", dot: "var(--color-accent-2)", hint: "镜头画面描述" },
  shotlist: { label: "分镜表", dot: "var(--color-warn)", hint: "整场戏的镜头清单" },
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
        ? `（含 ${nodes.filter((c) => c.parentId === n.id).length} 卡${n.data.collapsed ? " · 已折叠" : ""}）`
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
