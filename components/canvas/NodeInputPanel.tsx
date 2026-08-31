"use client";

/**
 * 节点输入面板（libtv 范式）：选中单张卡时，卡正下方浮出独立的大输入区——
 * 与卡片分离、更宽更松，@ 引用 + 描述 → 生成/撰写（GENERATE_EVENT → agent）。
 * 类型 → 生成种类映射：note/script→写正文、character/image→出图、video→出视频；
 * audio/compose/storyboard 暂无直接生成，不弹面板。多选时让位给 SelectionToolbar。
 * 支持把画布上的媒体拖进面板 = 快捷加引用（ADD_REF_EVENT）。
 *
 * 跟手性（关键）：位置不走 React 渲染——拖动时节点每帧进 store，若面板订阅
 * nodes 数组会整树每帧重渲染，调度延迟导致面板拖不跟手。改为：
 * React 只随「选区/类型」结构变化重渲染；位置由 zustand subscribe 回调
 * 直接写 DOM style（每帧一次算术 + 写样式，无重渲染），与节点本体同帧落位。
 */

import { useLayoutEffect, useRef, useState } from "react";
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
  // 选区以原始串订阅（数组/节点对象在拖动中每帧换引用，订阅它们会每帧重渲染）
  const selIds = useCanvasStore((s) =>
    s.nodes
      .filter((n) => n.selected)
      .map((n) => n.id)
      .join(","),
  );
  const singleId = selIds && !selIds.includes(",") ? selIds : null;
  const nodeType = useCanvasStore((s) =>
    singleId ? s.nodes.find((n) => n.id === singleId)?.data.nodeType : undefined,
  );
  const kind = singleId && nodeType ? KIND_BY_TYPE[nodeType] : null;
  if (!singleId || !kind) return null;
  return <PanelBody key={singleId} nodeId={singleId} kind={kind} />;
}

function PanelBody({ nodeId, kind }: { nodeId: string; kind: string }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [dropActive, setDropActive] = useState(false);

  // 位置直写：每帧 store 变更 → 算坐标 → 改 style，不过 React（跟手的关键）。
  // useLayoutEffect：挂载首帧绘制前先落位，避免闪到 0,0。
  // 宽度与卡片解耦（对标竞品 composer 的舒展比例：约 36% 视口、480~800），
  // 面板居中于卡宽并向视口内夹紧，贴卡不越屏
  useLayoutEffect(() => {
    const write = () => {
      const el = boxRef.current;
      if (!el) return;
      const s = useCanvasStore.getState();
      const box = selectionBoxes(s.nodes, [nodeId])[0];
      if (!box) return;
      const width = Math.max(480, Math.min(800, window.innerWidth * 0.36));
      const center = s.viewport.x + (box.x + box.w / 2) * s.viewport.zoom;
      const left = Math.min(
        Math.max(center, width / 2 + 8),
        window.innerWidth - width / 2 - 8,
      );
      el.style.left = `${left}px`;
      el.style.top = `${s.viewport.y + (box.y + box.h) * s.viewport.zoom + 12}px`;
      el.style.width = `${width}px`;
    };
    write();
    return useCanvasStore.subscribe(write);
  }, [nodeId]);

  return (
    <div
      ref={boxRef}
      className={`ws-detail absolute z-10 -translate-x-1/2 ${dropActive ? "ws-ref-drop-active" : ""}`}
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
        <PromptBar key={nodeId} nodeId={nodeId} kind={kind as "image" | "video" | "text" | "shotlist"} variant="floating" />
      </div>
    </div>
  );
}
