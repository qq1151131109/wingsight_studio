"use client";

/**
 * 画布快捷键与粘贴：
 *  - Cmd/Ctrl+Z 撤销、Shift+Cmd/Ctrl+Z 或 Ctrl+Y 重做
 *  - Cmd/Ctrl+C 复制、X 剪切、V 粘贴、D 原地复制、A 全选
 *  - 方向键微调选中卡（1px，Shift 按网格 16px）；Esc 清空选区
 *  - Cmd/Ctrl+0 复位缩放、± 缩放
 *  - 系统剪贴板粘贴图片 → 上传 agent → 建 image 卡
 * 输入框/文本编辑中不拦截。
 */

import { useEffect } from "react";
import { useReactFlow } from "@xyflow/react";
import { selectAllNodes, useCanvasStore } from "@/lib/canvas/store";
import { dispatchFocusEdit } from "@/lib/canvas/events";
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
  const { screenToFlowPosition, zoomIn, zoomOut, zoomTo } = useReactFlow();

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
      } else if (mod && e.key.toLowerCase() === "x") {
        const ids = store.nodes.filter((n) => n.selected).map((n) => n.id);
        if (ids.length > 0) {
          e.preventDefault();
          store.copySelection();
          store.deleteNodes(ids);
        }
      } else if (mod && e.key.toLowerCase() === "v") {
        // 内部剪贴板粘贴；系统剪贴板的图片走下方 paste 事件
        store.pasteClipboard();
      } else if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAllNodes();
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        store.duplicateSelection();
      } else if (mod && (e.key === "0" || e.key === "=" || e.key === "+" || e.key === "-")) {
        e.preventDefault();
        if (e.key === "0") void zoomTo(1, { duration: 250 });
        else if (e.key === "-") void zoomOut({ duration: 150 });
        else void zoomIn({ duration: 150 });
      } else if (e.key.startsWith("Arrow")) {
        const sel = store.nodes.filter((n) => n.selected);
        if (sel.length === 0) return;
        e.preventDefault();
        const step = e.shiftKey ? 16 : 1;
        const d: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const [dx, dy] = d[e.key] ?? [0, 0];
        store.nudgeSelection(dx, dy);
      } else if (e.key === "Escape") {
        if (store.nodes.some((n) => n.selected)) store.clearSelection();
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e as unknown as KeyboardEvent)) return;
      const files = [...(e.clipboardData?.items ?? [])].filter((i) =>
        i.type.startsWith("image/"),
      );
      if (files.length === 0) {
        // 无图时看纯文本：直接建「文本」卡（novanova 模式）。内部剪贴板
        // 非空说明 keydown 已粘贴过节点，这里不重复建卡
        const text = e.clipboardData?.getData("text/plain")?.trim() ?? "";
        if (!text || useCanvasStore.getState().clipboardCount > 0) return;
        e.preventDefault();
        const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
        const center = screenToFlowPosition({
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        });
        const id = useCanvasStore.getState().addNode({
          position: { x: center.x - 140, y: center.y - 85 },
          data: {
            nodeType: "note",
            title: firstLine.trim().slice(0, 24) || "粘贴的文本",
            body: text.slice(0, 4000),
          },
        });
        dispatchFocusEdit(id);
        return;
      }
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
  }, [screenToFlowPosition, zoomIn, zoomOut, zoomTo]);

  return null;
}
