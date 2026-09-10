"use client";

/**
 * 输入条落卡（2026-09-08 @ 体系补缺）：聊天上传的资料、素材库拖拽的媒体
 * 统一在这里变成画布卡——建卡后即可 @ 引用、连线、跨会话/跨视图复用。
 * 位置默认走「内容下方」锚点：用户还在聊天/面板里，不抢视口焦点，
 * 滚下去才见；面板拖入可传锚点（就近落卡）。
 */
import {
  absolutePosition,
  findFreePosition,
  NODE_FOOTPRINT,
  nodeSize,
  noteFootprintFor,
  useCanvasStore,
  type WingNode,
  type WingNodeData,
} from "./store";

/** 画布内容底部下方锚点（不叠在既有卡上，也不把视口拽走） */
export function belowContentAnchor(nodes: WingNode[]): { x: number; y: number } {
  let maxBottom = 0;
  let minLeft = 0;
  for (const n of nodes) {
    if (n.hidden) continue;
    const abs = absolutePosition(nodes, n);
    maxBottom = Math.max(maxBottom, abs.y + nodeSize(n).h);
    minLeft = Math.min(minLeft, abs.x);
  }
  return { x: minLeft, y: maxBottom + 48 };
}

/** 在锚点找空位建卡；无项目（离线/未激活）返回 null，调用方静默跳过。
 *  size 缺省用类型足迹；传了就按它落位（长文档走文档尺寸，见 noteFootprintFor）
 *  opts.history="skip" 给系统写入（对账落卡等）用——不进撤销栈 */
export function addCardAt(
  anchor: { x: number; y: number },
  data: WingNodeData,
  size?: { w: number; h: number },
  opts?: { history?: "commit" | "skip" },
): string | null {
  const st = useCanvasStore.getState();
  if (!st.projectId) return null;
  const fp = size ?? NODE_FOOTPRINT[data.nodeType] ?? NODE_FOOTPRINT.note;
  const pos = findFreePosition(st.nodes, anchor, { w: fp.w, h: fp.h });
  return st.addNode(
    {
      position: pos,
      data,
      ...(size ? { style: { width: size.w, height: size.h } } : {}),
    },
    opts,
  );
}

/** 聊天上传的文档（doc/pdf/rtf/文本）→ 资料卡：正文=提取全文，标题=文件名。
 *  长文按分档给文档尺寸——全文要塞得进卡（此前 280×170 便签框装 150KB 剧本） */
export function addDocCard(name: string, text: string): string | null {
  const title = name.replace(/\.[^.]+$/, "").trim().slice(0, 60) || "资料";
  return addCardAt(
    belowContentAnchor(useCanvasStore.getState().nodes),
    {
      nodeType: "note",
      title,
      body: text,
    },
    noteFootprintFor(text),
  );
}

/** 媒体（聊天上传成功 / 素材库拖入）→ image/video/audio 卡 */
export function addMediaCard(
  kind: "image" | "video" | "audio",
  url: string,
  title: string,
  anchor?: { x: number; y: number },
): string | null {
  const base = { title: title.trim() || "素材", body: "" };
  const data: WingNodeData =
    kind === "image"
      ? { ...base, nodeType: "image", imageUrl: url, status: "ready" }
      : kind === "video"
        ? { ...base, nodeType: "video", videoUrl: url, status: "ready" }
        : { ...base, nodeType: "audio", audioUrl: url };
  return addCardAt(anchor ?? belowContentAnchor(useCanvasStore.getState().nodes), data);
}

/** 素材库拖拽载荷（AssetTray 写、输入条读）：库项 → 建媒体卡 → 引用 */
export const ASSET_DRAG_MIME = "application/x-ws-asset-ref";

export type AssetDragPayload = {
  kind: "image" | "video" | "audio";
  url: string;
  title: string;
};

export function parseAssetDrag(raw: string): AssetDragPayload | null {
  try {
    const d = JSON.parse(raw) as Partial<AssetDragPayload>;
    if (!d || typeof d.url !== "string" || !d.url) return null;
    const kind = d.kind === "video" || d.kind === "audio" ? d.kind : "image";
    return { kind, url: d.url, title: typeof d.title === "string" ? d.title : "" };
  } catch {
    return null;
  }
}
