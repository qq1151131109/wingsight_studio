"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
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
import { NODE_META, useCanvasStore, type WingNodeType } from "@/lib/canvas/store";
import { nodeTypes } from "./nodes";
import CanvasShortcuts from "./CanvasShortcuts";

/** 视口相等判断（按值比较，防程序化 setViewport 与 store 回写互触发） */
const vpEq = (a: Viewport, b: Viewport) =>
  a.x === b.x && a.y === b.y && a.zoom === b.zoom;

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
  const { setViewport: setRfViewport } = useReactFlow();
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
  const { screenToFlowPosition } = useReactFlow();
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
    </div>
  );
}
