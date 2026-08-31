"use client";

/**
 * 默认贝塞尔连线的自定义版：选中时在中点浮出删除钮（对标 novanova 删除气泡 /
 * osc DisconnectableEdge 的 X）。注册在 edgeTypes.default 覆盖内置实现——
 * 存量边没有 type 字段，走的正是 default 键，无需迁移数据。
 * 线本体仍是 BaseEdge，颜色与粗细全部由 globals.css 的边样式承担。
 */
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { X } from "lucide-react";
import { useCanvasStore } from "@/lib/canvas/store";

export default function DeletableEdge({
  id,
  selected,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {selected ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            title="删除连线"
            className="nodrag nopan pointer-events-auto absolute flex h-5 w-5 items-center justify-center rounded-full border border-hairline bg-surface-1 text-text-3 shadow-sm transition-colors hover:border-danger hover:bg-danger/10 hover:text-danger"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            onClick={(event) => {
              event.stopPropagation();
              useCanvasStore.getState().commitHistory();
              useCanvasStore.setState((s) => ({
                edges: s.edges.filter((e) => e.id !== id),
              }));
            }}
          >
            <X className="h-3 w-3" />
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
