"use client";

/**
 * 画布快捷键与粘贴：
 *  - Cmd/Ctrl+Z 撤销、Shift+Cmd/Ctrl+Z 或 Ctrl+Y 重做
 *  - Cmd/Ctrl+C 复制选中节点、Cmd/Ctrl+V 粘贴（偏移落位）
 *  - 系统剪贴板粘贴图片 → 上传 agent → 建 image 卡
 * 输入框/文本编辑中不拦截。
 */

import { useEffect } from "react";
import { useReactFlow } from "@xyflow/react";
import { selectAllNodes, useCanvasStore } from "@/lib/canvas/store";
import { uploadAsset } from "@/lib/projects";

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

export default function CanvasShortcuts() {
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      const store = useCanvasStore.getState();

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (e.ctrlKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        store.redo();
      } else if (mod && e.key.toLowerCase() === "c") {
        store.copySelection();
      } else if (mod && e.key.toLowerCase() === "v") {
        // 内部剪贴板粘贴；系统剪贴板的图片走下方 paste 事件
        store.pasteClipboard();
      } else if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAllNodes();
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e as unknown as KeyboardEvent)) return;
      const files = [...(e.clipboardData?.items ?? [])].filter((i) =>
        i.type.startsWith("image/"),
      );
      if (files.length === 0) return;
      e.preventDefault();
      const file = files[0].getAsFile();
      if (!file) return;
      void (async () => {
        try {
          const url = await uploadAsset(file);
          if (!url) return;
          const center = screenToFlowPosition({
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
          });
          useCanvasStore.getState().addNode({
            position: { x: center.x - 128, y: center.y - 100 },
            data: {
              nodeType: "image",
              title: "粘贴的图片",
              body: "",
              imageUrl: url,
              status: "ready",
            },
          });
        } catch {
          /* 上传失败静默 */
        }
      })();
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("paste", onPaste);
    };
  }, [screenToFlowPosition]);

  return null;
}
