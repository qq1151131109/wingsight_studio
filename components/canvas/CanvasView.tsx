"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type OnConnectEnd,
  type OnMoveEnd,
  type Viewport,
} from "@xyflow/react";
import {
  Clapperboard,
  Drama,
  Image as ImageIcon,
  ScrollText,
  StickyNote,
  Maximize,
} from "lucide-react";
import {
  selectAllNodes,
  selectionBoxes,
  NODE_META,
  useCanvasStore,
  type WingNode,
  type WingNodeType,
} from "@/lib/canvas/store";
import { FOCUS_NODES_EVENT, type FocusNodesDetail } from "@/lib/canvas/events";
import { uploadAsset } from "@/lib/projects";
import { nodeTypes } from "./nodes";
import CanvasShortcuts from "./CanvasShortcuts";

/** 视口相等判断（按值比较，防程序化 setViewport 与 store 回写互触发） */
const vpEq = (a: Viewport, b: Viewport) =>
  a.x === b.x && a.y === b.y && a.zoom === b.zoom;

/** 右键菜单（空白 / 节点 / 多选 / 连线 四态） */
type CtxMenu =
  | { kind: "pane"; x: number; y: number; fx: number; fy: number }
  | { kind: "node"; x: number; y: number; id: string }
  | { kind: "selection"; x: number; y: number; ids: string[] }
  | { kind: "edge"; x: number; y: number; id: string };

function CtxItem({
  label,
  dot,
  danger,
  onClick,
}: {
  label: string;
  dot?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-2 ${
        danger ? "text-danger" : "text-text-2 hover:text-text"
      }`}
      onClick={onClick}
    >
      {dot ? (
        <span className="ws-card-dot" style={{ background: dot }} />
      ) : null}
      {label}
    </button>
  );
}

/** 拖拽导入：图片→上传建 image 卡；.txt/.md→文本卡（md 当剧本、txt 当便签） */
async function importDroppedFiles(
  files: File[],
  at: { x: number; y: number },
) {
  const store = useCanvasStore.getState();
  let i = 0;
  for (const f of files) {
    const position = {
      x: at.x + (i % 4) * 288,
      y: at.y + Math.floor(i / 4) * 300,
    };
    const name = f.name.replace(/\.[^.]+$/, "").slice(0, 40);
    if (f.type.startsWith("image/")) {
      try {
        const url = await uploadAsset(f);
        if (!url) continue;
        store.addNode({
          position,
          data: {
            nodeType: "image",
            title: name || "导入图片",
            body: "",
            imageUrl: url,
            status: "ready",
          },
        });
        i += 1;
      } catch {
        /* 上传失败跳过该文件 */
      }
    } else if (/\.(txt|md|markdown)$/i.test(f.name)) {
      try {
        const text = (await f.text()).slice(0, 8000);
        const isMd = /\.md$|\.markdown$/i.test(f.name);
        store.addNode({
          position,
          data: {
            nodeType: isMd ? "script" : "note",
            title: name || "导入文本",
            body: text,
          },
        });
        i += 1;
      } catch {
        /* 读取失败跳过该文件 */
      }
    }
  }
}

function AddNodeToolbar() {
  const addNode = useCanvasStore((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();
  const items: { type: WingNodeType; icon: React.ReactNode }[] = [
    { type: "note", icon: <StickyNote className="h-4 w-4" /> },
    { type: "script", icon: <ScrollText className="h-4 w-4" /> },
    { type: "character", icon: <Drama className="h-4 w-4" /> },
    { type: "storyboard", icon: <Clapperboard className="h-4 w-4" /> },
    { type: "image", icon: <ImageIcon className="h-4 w-4" /> },
  ];
  // 建卡落在画布可视区中心（而非随机坐标）
  const addAtCenter = (type: WingNodeType) => {
    const rect = document.querySelector(".react-flow")?.getBoundingClientRect();
    const center = screenToFlowPosition({
      x: (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2,
      y: (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2,
    });
    addNode({
      position: { x: Math.round(center.x - 128), y: Math.round(center.y - 90) },
      data: { nodeType: type, title: NODE_META[type].hint, body: "" },
    });
  };
  return (
    <div className="flex items-center gap-1 rounded-lg border border-hairline bg-surface-1 p-1 shadow-sm">
      {items.map(({ type, icon }) => (
        <button
          key={type}
          type="button"
          title={`添加${NODE_META[type].label}（${NODE_META[type].hint}）`}
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          onClick={() => addAtCenter(type)}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}

function FitViewButton() {
  const { fitView } = useReactFlow();
  return (
    <button
      type="button"
      title="适应视图"
      className="flex h-8 w-8 items-center justify-center rounded-md border border-hairline bg-surface-1 text-text-2 shadow-sm transition-colors hover:bg-surface-2 hover:text-text"
      onClick={() => fitView({ duration: 300, padding: 0.15 })}
    >
      <Maximize className="h-4 w-4" />
    </button>
  );
}

/** 多选浮动工具条：跟随选区包围盒顶部居中（对标 novanova / 影策的 selection toolbar） */
const ALIGN_MENU: {
  label: string;
  min: number;
  run: (ids: string[]) => void;
}[] = [
  { label: "左对齐", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "left") },
  { label: "水平居中", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "hcenter") },
  { label: "右对齐", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "right") },
  { label: "顶对齐", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "top") },
  { label: "垂直居中", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "vcenter") },
  { label: "底对齐", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "bottom") },
  { label: "水平等距", min: 3, run: (ids) => useCanvasStore.getState().distributeNodes(ids, "h") },
  { label: "垂直等距", min: 3, run: (ids) => useCanvasStore.getState().distributeNodes(ids, "v") },
];

function SelBtn({
  danger,
  onClick,
  children,
}: {
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`nodrag rounded-md px-2 py-1 text-xs transition-colors ${
        danger ? "text-danger hover:bg-danger/10" : "text-text-2 hover:bg-surface-2 hover:text-text"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SelectionToolbar() {
  const nodes = useCanvasStore((s) => s.nodes);
  // 订阅视口：平移缩放后重算锚点（画布坐标 → 容器坐标 = vp + flow*zoom）
  const vp = useCanvasStore((s) => s.viewport);
  const [alignOpen, setAlignOpen] = useState(false);
  const sel = nodes.filter((n) => n.selected);
  if (sel.length < 2) return null;
  const ids = sel.map((n) => n.id);
  const boxes = selectionBoxes(nodes, ids);
  const minX = Math.min(...boxes.map((b) => b.x));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const minY = Math.min(...boxes.map((b) => b.y));
  const anchor = {
    x: vp.x + ((minX + maxX) / 2) * vp.zoom,
    y: vp.y + minY * vp.zoom,
  };
  return (
    <div
      className="absolute z-10 flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg"
      style={{ left: anchor.x, top: anchor.y - 10 }}
    >
      <span className="px-1.5 text-[10px] text-text-4">已选 {sel.length}</span>
      <SelBtn onClick={() => useCanvasStore.getState().copySelection()}>复制</SelBtn>
      <div className="relative">
        <SelBtn onClick={() => setAlignOpen((o) => !o)}>对齐 ▾</SelBtn>
        {alignOpen ? (
          <>
            <div className="fixed inset-0 z-0" onClick={() => setAlignOpen(false)} />
            <div className="absolute left-0 top-full z-10 mt-1 flex w-24 flex-col rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
              {ALIGN_MENU.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  disabled={sel.length < a.min}
                  className="rounded-md px-2 py-1 text-left text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:text-text-4 disabled:hover:bg-transparent"
                  onClick={() => {
                    setAlignOpen(false);
                    a.run(ids);
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <SelBtn onClick={() => useCanvasStore.getState().groupNodes(ids)}>成组</SelBtn>
      <SelBtn danger onClick={() => useCanvasStore.getState().deleteNodes(ids)}>
        删除
      </SelBtn>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
      <div className="max-w-sm text-center">
        <h2 className="font-editorial text-xl font-medium text-text-2">
          空白画布
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-text-3">
          双击画布添加便签，从左上角工具条加入剧本、角色卡，
          <br />
          或者直接在右侧让助手帮你搭起故事板。
        </p>
      </div>
    </div>
  );
}

export default function CanvasView() {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const onNodesChange = useCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange);
  const onConnect = useCanvasStore((s) => s.onConnect);
  const addNode = useCanvasStore((s) => s.addNode);
  const viewport = useCanvasStore((s) => s.viewport);

  // 视口双向同步：agent 的 set_viewport / 项目装载 → 画布动画跟随；
  // 用户平移缩放 → 回写 store（供持久化与 agent 感知）。
  // ref 按值比较防回环：程序化 setViewport 结束也会触发 onMoveEnd。
  const { screenToFlowPosition, setViewport: setRfViewport, fitView } =
    useReactFlow();
  const lastSyncedVp = useRef<Viewport>(viewport);
  useEffect(() => {
    if (vpEq(viewport, lastSyncedVp.current)) return;
    lastSyncedVp.current = viewport;
    void setRfViewport(viewport, { duration: 300 });
  }, [viewport, setRfViewport]);
  const onMoveEnd = useCallback<OnMoveEnd>((_event, vp) => {
    if (vpEq(vp, lastSyncedVp.current)) return;
    lastSyncedVp.current = vp;
    useCanvasStore.getState().setViewport(vp);
  }, []);

  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      // 用 screenToFlowPosition 换算落点（原先按 clientX 硬编码偏移，平移/缩放后会飘）
      const flow = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      addNode({
        position: { x: flow.x - 110, y: flow.y - 40 },
        data: { nodeType: "note", title: "新便签", body: "" },
      });
    },
    [addNode, screenToFlowPosition],
  );

  // agent 建卡 / "+" 建下游卡 → 视口聚焦到新节点（平移+缩放到可见）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onFocusNodes = (e: Event) => {
      const ids = (e as CustomEvent<FocusNodesDetail>).detail?.ids ?? [];
      if (ids.length === 0) return;
      // 等新节点渲染进 React Flow 后再运镜
      timer = setTimeout(() => {
        void fitView({
          nodes: ids.map((id) => ({ id })),
          duration: 450,
          padding: 0.25,
          maxZoom: 1,
        });
      }, 60);
    };
    window.addEventListener(FOCUS_NODES_EVENT, onFocusNodes);
    return () => {
      window.removeEventListener(FOCUS_NODES_EVENT, onFocusNodes);
      if (timer) clearTimeout(timer);
    };
  }, [fitView]);

  // 连线拖到空白处 → 弹建卡菜单（选中类型后建卡并自动连线）
  const [pendingLink, setPendingLink] = useState<{
    x: number;
    y: number;
    sourceId: string;
  } | null>(null);
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      if (connectionState.isValid) return; // 有效连线交给 onConnect
      const sourceId = connectionState.fromNode?.id;
      if (!sourceId) return;
      const pos =
        "clientX" in event
          ? { x: event.clientX, y: event.clientY }
          : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      setPendingLink({ ...pos, sourceId });
    },
    [],
  );
  const createAt = useCallback(
    (type: WingNodeType) => {
      if (!pendingLink) return;
      const flow = screenToFlowPosition({
        x: pendingLink.x,
        y: pendingLink.y,
      });
      const id = addNode({
        position: { x: flow.x - 110, y: flow.y - 40 },
        data: { nodeType: type, title: NODE_META[type].hint, body: "" },
      });
      useCanvasStore.getState().connect({
        source: pendingLink.sourceId,
        target: id,
      });
      setPendingLink(null);
    },
    [pendingLink, addNode, screenToFlowPosition],
  );

  const linkMenuTypes: WingNodeType[] = [
    "note",
    "character",
    "storyboard",
    "image",
  ];

  // ---------- 右键菜单（空白 / 节点 / 多选 / 连线） ----------
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const closeCtx = useCallback(() => setCtxMenu(null), []);

  useEffect(() => {
    if (!ctxMenu && !pendingLink) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      closeCtx();
      setPendingLink(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctxMenu, closeCtx, pendingLink]);

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent<Element> | MouseEvent) => {
      event.preventDefault();
      const flow = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      setCtxMenu({
        kind: "pane",
        x: event.clientX,
        y: event.clientY,
        fx: flow.x,
        fy: flow.y,
      });
    },
    [screenToFlowPosition],
  );

  const onNodeContextMenu = useCallback<NodeMouseHandler<WingNode>>(
    (event, node) => {
      event.preventDefault();
      const selected = nodes.filter((n) => n.selected);
      if (node.selected && selected.length > 1) {
        setCtxMenu({
          kind: "selection",
          x: event.clientX,
          y: event.clientY,
          ids: selected.map((n) => n.id),
        });
        return;
      }
      setCtxMenu({ kind: "node", x: event.clientX, y: event.clientY, id: node.id });
    },
    [nodes],
  );

  const onSelectionContextMenu = useCallback(
    (event: React.MouseEvent<Element>, selNodes: WingNode[]) => {
      event.preventDefault();
      setCtxMenu({
        kind: "selection",
        x: event.clientX,
        y: event.clientY,
        ids: selNodes.map((n) => n.id),
      });
    },
    [],
  );

  const onEdgeContextMenu = useCallback<EdgeMouseHandler>(
    (event, edge) => {
      event.preventDefault();
      setCtxMenu({ kind: "edge", x: event.clientX, y: event.clientY, id: edge.id });
    },
    [],
  );

  const addAtCtx = useCallback(
    (type: WingNodeType) => {
      if (ctxMenu?.kind !== "pane") return;
      addNode({
        position: { x: ctxMenu.fx - 110, y: ctxMenu.fy - 40 },
        data: { nodeType: type, title: NODE_META[type].hint, body: "" },
      });
      setCtxMenu(null);
    },
    [ctxMenu, addNode],
  );

  /** 复制指定节点：右键的节点可能不在选区内，先选中再复制 */
  const copyNodes = useCallback((ids: string[]) => {
    useCanvasStore.setState((s) => ({
      nodes: s.nodes.map((n) => ({ ...n, selected: ids.includes(n.id) })),
    }));
    useCanvasStore.getState().copySelection();
  }, []);

  const deleteEdge = useCallback((id: string) => {
    useCanvasStore.getState().commitHistory();
    useCanvasStore.setState((s) => ({
      edges: s.edges.filter((e) => e.id !== id),
    }));
  }, []);

  // ---------- 拖拽文件导入 ----------
  const onDragOver = useCallback((event: React.DragEvent) => {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      if (!event.dataTransfer.files?.length) return;
      event.preventDefault();
      const flow = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      void importDroppedFiles([...event.dataTransfer.files], flow);
    },
    [screenToFlowPosition],
  );

  return (
    <div className="relative h-full w-full">
      {nodes.length === 0 ? <EmptyState /> : null}
      <SelectionToolbar />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onMoveEnd={onMoveEnd}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onSelectionContextMenu={onSelectionContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDoubleClick={onDoubleClick}
        defaultViewport={{ x: 40, y: 40, zoom: 0.9 }}
        fitView={nodes.length > 0}
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        maxZoom={2}
        deleteKeyCode={["Backspace", "Delete"]}
        multiSelectionKeyCode={["Shift", "Meta"]}
        selectionOnDrag
        panOnScroll
        zoomOnDoubleClick={false}
        snapToGrid
        snapGrid={[16, 16]}
        className="bg-transparent"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.4}
          color="var(--color-hairline)"
        />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          nodeColor={(n) => NODE_META[(n.data as { nodeType: WingNodeType }).nodeType]?.dot ?? "var(--color-warm)"}
          nodeStrokeColor="var(--color-hairline)"
        />
        <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5">
          <AddNodeToolbar />
          <FitViewButton />
        </div>
        <CanvasShortcuts />
      </ReactFlow>
      {pendingLink ? (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setPendingLink(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setPendingLink(null);
            }}
          />
          <div
            className="fixed z-30 flex flex-col rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg"
            style={{ left: pendingLink.x + 8, top: pendingLink.y + 8 }}
          >
            <p className="px-2 py-1 text-[10px] text-text-4">建卡并连线</p>
            {linkMenuTypes.map((t) => (
              <button
                key={t}
                type="button"
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-2 hover:bg-surface-2 hover:text-text"
                onClick={() => createAt(t)}
              >
                <span
                  className="ws-card-dot"
                  style={{ background: NODE_META[t].dot }}
                />
                {NODE_META[t].label}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {ctxMenu ? (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={closeCtx}
            onContextMenu={(e) => {
              e.preventDefault();
              closeCtx();
            }}
          />
          <div
            className="fixed z-30 flex flex-col rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg"
            style={{
              left: Math.min(ctxMenu.x + 8, window.innerWidth - 180),
              top: Math.min(ctxMenu.y + 8, window.innerHeight - 300),
            }}
          >
            {ctxMenu.kind === "pane" ? (
              <>
                <p className="px-2 py-1 text-[10px] text-text-4">在此处添加</p>
                {(
                  ["note", "script", "character", "storyboard", "image"] as WingNodeType[]
                ).map((t) => (
                  <CtxItem
                    key={t}
                    label={NODE_META[t].label}
                    dot={NODE_META[t].dot}
                    onClick={() => addAtCtx(t)}
                  />
                ))}
                <CtxItem
                  label="粘贴"
                  onClick={() => {
                    useCanvasStore.getState().pasteClipboard();
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="全选"
                  onClick={() => {
                    selectAllNodes();
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="适应视图"
                  onClick={() => {
                    void fitView({ duration: 300, padding: 0.15 });
                    closeCtx();
                  }}
                />
              </>
            ) : ctxMenu.kind === "node" ? (
              <>
                <CtxItem
                  label="复制"
                  onClick={() => {
                    copyNodes([ctxMenu.id]);
                    closeCtx();
                  }}
                />
                {nodes.find((n) => n.id === ctxMenu.id)?.data.nodeType ===
                "group" ? (
                  <CtxItem
                    label="解散分组"
                    onClick={() => {
                      useCanvasStore.getState().ungroupNode(ctxMenu.id);
                      closeCtx();
                    }}
                  />
                ) : null}
                <CtxItem
                  label="删除"
                  danger
                  onClick={() => {
                    useCanvasStore.getState().deleteNodes([ctxMenu.id]);
                    closeCtx();
                  }}
                />
              </>
            ) : ctxMenu.kind === "selection" ? (
              <>
                <CtxItem
                  label={`复制 ${ctxMenu.ids.length} 张`}
                  onClick={() => {
                    copyNodes(ctxMenu.ids);
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="打成一组"
                  onClick={() => {
                    useCanvasStore.getState().groupNodes(ctxMenu.ids);
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="删除"
                  danger
                  onClick={() => {
                    useCanvasStore.getState().deleteNodes(ctxMenu.ids);
                    closeCtx();
                  }}
                />
              </>
            ) : (
              <CtxItem
                label="删除连线"
                danger
                onClick={() => {
                  deleteEdge(ctxMenu.id);
                  closeCtx();
                }}
              />
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
