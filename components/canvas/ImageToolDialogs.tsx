"use client";

/**
 * 图片节点操作弹窗宿主（全局单例，CanvasView 挂载一次）：监听 IMAGE_TOOL_EVENT
 * （右键菜单图片专属段触发），按 tool 开对应弹窗。事件带 nodeId，任何有图卡型
 * 都能触发；弹窗内部自读 store，不依赖触发时的卡片实例存续。
 */

import { useEffect, useState } from "react";
import ImageCropDialog from "./ImageCropDialog";
import ImageTemplateDialog from "./ImageTemplateDialog";
import { IMAGE_TOOL_EVENT, type ImageToolDetail } from "@/lib/canvas/events";

export default function ImageToolDialogs() {
  const [req, setReq] = useState<ImageToolDetail | null>(null);

  useEffect(() => {
    const onTool = (e: Event) => {
      setReq((e as CustomEvent<ImageToolDetail>).detail);
    };
    window.addEventListener(IMAGE_TOOL_EVENT, onTool);
    return () => window.removeEventListener(IMAGE_TOOL_EVENT, onTool);
  }, []);

  if (!req) return null;
  const close = () => setReq(null);
  if (req.tool === "crop") {
    return <ImageCropDialog nodeId={req.nodeId} onClose={close} />;
  }
  return (
    <ImageTemplateDialog nodeId={req.nodeId} tool={req.tool} onClose={close} />
  );
}
