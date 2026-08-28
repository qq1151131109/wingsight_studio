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
  NODE_META,
  useCanvasStore,
  type WingNode,
  type WingNodeType,
} from "@/lib/canvas/store";
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
  const items: { type: WingNodeType; icon: React.ReactNode }[] = [
    { type: "note", icon: <StickyNote className="h-4 w-4" /> },
    { type: "script", icon: <ScrollText className="h-4 w-4" /> },
    { type: "character", icon: <Drama className="h-4 w-4" /> },
    { type: "storyboard", icon: <Clapperboard className="h-4 w-4" /> },
    { type: "image", icon: <ImageIcon className="h-4 w-4" /> },
  ];
  return (
    <div className="flex items-center gap-1 rounded-lg border border-hairline bg-surface-1 p-1 shadow-sm">
      {items.map(({ type, icon }) => (
        <button
          key={type}
          type="button"
          title={`添加${NODE_META[type].label}（${NODE_META[type].hint}）`}
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          onClick={() =>
            addNode({
              position: {
                x: Math.round((Math.random() - 0.3) * 400),
                y: Math.round((Math.random() - 0.3) * 300),
              },
              data: {
                nodeType: type,
                title: NODE_META[type].hint,
                body: "",
              },
            })
          }
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
      addNode({
        position: { x: event.clientX - 280, y: event.clientY - 60 },
        data: { nodeType: "note", title: "新便签", body: "" },
      });
    },
    [addNode],
  );

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
    if (!ctxMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCtx();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctxMenu, closeCtx]);

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
