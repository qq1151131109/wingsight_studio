"use client";

/**
 * 图片节点操作弹窗宿主（全局单例，CanvasView 挂载一次）：监听 IMAGE_TOOL_EVENT
 * （右键菜单图片专属段触发），按 tool 开对应弹窗。事件带 nodeId，任何有图卡型
 * 都能触发；弹窗内部自读 store，不依赖触发时的卡片实例存续。
 */

import { useEffect, useState } from "react";
import ImageCropDialog from "./ImageCropDialog";
import ImageTemplateDialog from "./ImageTemplateDialog";
import CameraAngleDialog from "./CameraAngleDialog";
import LightingDialog from "./LightingDialog";
import AnnotateDialog from "./AnnotateDialog";
import { IMAGE_TOOL_EVENT, type ImageToolDetail } from "@/lib/canvas/events";
import { launchPanorama } from "./panoramaLaunch";

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
  // 全景环视不弹确认窗（用户裁决：说明文字+可选补充要求不值一次点击），
  // 事件收到就地启动：预校验模型 → 建卡连线 → 发生成事件
  if (req.tool === "panorama") {
    void launchPanorama(req.nodeId);
    return null;
  }
  const close = () => setReq(null);
  if (req.tool === "crop") {
    return <ImageCropDialog nodeId={req.nodeId} onClose={close} />;
  }
  if (req.tool === "annotate") {
    return <AnnotateDialog nodeId={req.nodeId} onClose={close} />;
  }
  // 机位与打光是全交互弹窗（球控/预设/多维拼词，open-storyboard 移植版）；
  // 三视图/质感/全景维持轻量 chips 弹窗
  if (req.tool === "multiview") {
    return <CameraAngleDialog nodeId={req.nodeId} onClose={close} />;
  }
  if (req.tool === "lighting") {
    return <LightingDialog nodeId={req.nodeId} onClose={close} />;
  }
  return (
    <ImageTemplateDialog nodeId={req.nodeId} tool={req.tool} onClose={close} />
  );
}
