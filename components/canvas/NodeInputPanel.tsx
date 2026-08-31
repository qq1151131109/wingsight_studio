"use client";

/**
 * 节点输入面板（libtv 范式）：选中单张卡时，卡正下方浮出独立的大输入区——
 * 与卡片分离、更宽更松，@ 引用 + 描述 → 生成/撰写（GENERATE_EVENT → agent）。
 * 类型 → 生成种类映射：note/script→写正文、character/image→出图、video→出视频；
 * audio/compose/storyboard 暂无直接生成，不弹面板。多选时让位给 SelectionToolbar。
 * 支持把画布上的媒体拖进面板 = 快捷加引用（ADD_REF_EVENT）。
 */

import { useState } from "react";
import { useCanvasStore, selectionBoxes } from "@/lib/canvas/store";
import { ADD_REF_EVENT, type AddRefDetail } from "@/lib/canvas/events";
import PromptBar from "./PromptBar";

const KIND_BY_TYPE: Record<
  string,
  "image" | "video" | "text" | "shotlist" | null
> = {
  note: "text",
  script: "text",
  character: "image",
  scene: "image",
  prop: "image",
  costume: "image",
  image: "image",
  video: "video",
  shotlist: "shotlist",
  storyboard: null,
  audio: null,
  compose: null,
  group: null,
};

export default function NodeInputPanel() {
  const nodes = useCanvasStore((s) => s.nodes);
  const vp = useCanvasStore((s) => s.viewport);
  const [dropActive, setDropActive] = useState(false);
  const sel = nodes.filter((n) => n.selected);
  if (sel.length !== 1) return null;
  const node = sel[0];
  const kind = KIND_BY_TYPE[node.data.nodeType];
  if (!kind) return null;
  const [box] = selectionBoxes(nodes, [node.id]);

  // 画布坐标 → 容器坐标；面板居中于卡宽（最小 320，最大 560），贴卡底 12px
  const left = vp.x + (box.x + box.w / 2) * vp.zoom;
  const top = vp.y + (box.y + box.h) * vp.zoom + 12;
  const width = Math.max(320, Math.min(560, box.w * vp.zoom));

  return (
    <div
      className={`ws-detail absolute z-10 -translate-x-1/2 ${dropActive ? "ws-ref-drop-active" : ""}`}
      style={{ left, top, width }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-ws-node-ref")) {
          e.preventDefault();
          setDropActive(true);
        }
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(e) => {
        setDropActive(false);
        const raw = e.dataTransfer.getData("application/x-ws-node-ref");
        if (!raw) return;
        e.preventDefault();
        try {
          const { nodeId } = JSON.parse(raw) as AddRefDetail;
          if (nodeId)
            window.dispatchEvent(
              new CustomEvent(ADD_REF_EVENT, { detail: { nodeId } }),
            );
        } catch {
          /* 非法 payload 忽略 */
        }
      }}
    >
      <div className="rounded-xl border border-hairline bg-surface-1 p-2 shadow-lg">
        {/* key：切卡时强制重挂载，PromptBar 按新卡预填当前提示词 */}
        <PromptBar key={node.id} nodeId={node.id} kind={kind} variant="floating" />
      </div>
    </div>
  );
}
