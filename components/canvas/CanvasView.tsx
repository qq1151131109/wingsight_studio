"use client";

import { useCallback } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react";
import {
  Drama,
  Image as ImageIcon,
  ScrollText,
  StickyNote,
  Maximize,
} from "lucide-react";
import { NODE_META, useCanvasStore, type WingNodeType } from "@/lib/canvas/store";
import { nodeTypes } from "./nodes";

function AddNodeToolbar() {
  const addNode = useCanvasStore((s) => s.addNode);
  const items: { type: WingNodeType; icon: React.ReactNode }[] = [
    { type: "note", icon: <StickyNote className="h-4 w-4" /> },
    { type: "script", icon: <ScrollText className="h-4 w-4" /> },
    { type: "character", icon: <Drama className="h-4 w-4" /> },
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

  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      addNode({
        position: { x: event.clientX - 280, y: event.clientY - 60 },
        data: { nodeType: "note", title: "新便签", body: "" },
      });
    },
    [addNode],
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
      </ReactFlow>
    </div>
  );
}
