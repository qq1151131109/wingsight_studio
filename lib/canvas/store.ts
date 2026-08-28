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

/** 画布节点类型：便签 / 剧本 / 角色 / 图片占位 */
export type WingNodeType = "note" | "script" | "character" | "image";

export interface WingNodeData {
  nodeType: WingNodeType;
  title: string;
  body: string;
  imageUrl?: string;
  /** image 卡生命周期：占位(无图无状态) / loading / error / ready */
  status?: "loading" | "error" | "ready";
  errorMessage?: string;
  [key: string]: unknown;
}

export type WingNode = Node<WingNodeData>;
export type WingEdge = Edge;

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
}

let idCounter = 0;
export function genNodeId(): string {
  idCounter += 1;
  return `n_${Date.now().toString(36)}_${idCounter}`;
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

      replaceCanvas: (nodes, edges, viewport) =>
        set((state) => ({
          nodes,
          edges,
          viewport,
          hydrated: true,
          // 项目切换后旧数据不再参与持久化键（persist 由 partialize 控制）
          projectId: state.projectId,
        })),

      setNodes: (nodes) => set({ nodes }),

      addNode: (node) => {
        const id = node.id ?? genNodeId();
        // React Flow 靠 node.type 选自定义渲染器；调用方只给 data.nodeType 时自动推导
        const type = node.type ?? node.data?.nodeType ?? "note";
        set((state) => ({
          nodes: [...state.nodes, { ...node, id, type } as WingNode],
        }));
        return id;
      },

      updateNodeData: (id, patch) =>
        set((state) => ({
          nodes: state.nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
          ),
        })),

      deleteNodes: (ids) => {
        const idSet = new Set(ids);
        set((state) => ({
          nodes: state.nodes.filter((n) => !idSet.has(n.id)),
          edges: state.edges.filter(
            (e) => !idSet.has(e.source) && !idSet.has(e.target),
          ),
        }));
      },

      connect: (connection) =>
        set((state) => ({
          edges: addEdge(
            {
              id: `e_${connection.source}_${connection.target}_${Date.now().toString(36)}`,
              source: connection.source,
              target: connection.target,
            },
            state.edges,
          ),
        })),

      onNodesChange: (changes) =>
        set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) })),

      onEdgesChange: (changes) =>
        set((state) => ({ edges: applyEdgeChanges(changes, state.edges) })),

      onConnect: (connection) => get().connect(connection),

      setViewport: (viewport) => set({ viewport }),
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
    const body = n.data.body ? ` “${n.data.body.slice(0, 40)}”` : "";
    const sel = selectedIds.includes(n.id) ? " [选中]" : "";
    lines.push(`- ${n.id} [${meta.label}] ${title}${body}${sel}`);
  }
  for (const e of edges) {
    lines.push(`- 连线 ${e.source} → ${e.target}`);
  }
  let text = lines.join("\n");
  if (text.length > budget) text = text.slice(0, budget) + "\n…（已截断）";
  return text;
}
