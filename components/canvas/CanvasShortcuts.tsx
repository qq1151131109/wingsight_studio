"use client";

/**
 * 画布快捷键与粘贴：
 *  - Cmd/Ctrl+Z 撤销、Shift+Cmd/Ctrl+Z 或 Ctrl+Y 重做
 *  - Cmd/Ctrl+C 复制、X 剪切、V 粘贴、D 原地复制、A 全选
 *  - ⌘G 成组、⇧⌘G 解组、⌘L 连线（选中两张卡）、⇧F 整理画布
 *  - Tab 新建节点（视口中央弹「添加节点」选择器）
 *  - ⌘Enter 生成选中卡（出图类，空提示词=按卡上标题与正文重生成）
 *  - 方向键微调选中卡（1px，Shift 按网格 16px）；Esc 清空选区
 *  - ⌘0 适应画布（fit）、⇧⌘0 复位 100%、⌘± 缩放（对齐竞品 ⌘0=适应语义）
 *  - Shift+E 显示/隐藏画布连线（视图偏好，见 lib/canvas/prefs.ts）
 *  - 系统剪贴板粘贴图片 → 上传 agent → 建 image 卡
 * 输入框/文本编辑中不拦截。
 */

import { useEffect } from "react";
import { useReactFlow } from "@xyflow/react";
import { selectAllNodes, useCanvasStore } from "@/lib/canvas/store";
import { dispatchFocusEdit, OPEN_ADD_MENU_EVENT } from "@/lib/canvas/events";
import { getCanvasPref, setCanvasPref } from "@/lib/canvas/prefs";
import { uploadAsset } from "@/lib/projects";
import { GENERATE_EVENT, type GenerateDetail } from "./PromptBar";

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
  const { screenToFlowPosition, zoomIn, zoomOut, zoomTo, fitView } =
    useReactFlow();

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
      } else if (mod && e.key.toLowerCase() === "g" && !e.shiftKey) {
        // 成组（SelectionToolbar「成组」同款）：≥2 张选中卡收进分组框
        const ids = store.nodes.filter((n) => n.selected).map((n) => n.id);
        if (ids.length >= 2) {
          e.preventDefault();
          store.groupNodes(ids);
        }
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "g") {
        // 解组：解散选中的分组框（子卡回画布层）
        const groups = store.nodes.filter(
          (n) => n.selected && n.data.nodeType === "group",
        );
        if (groups.length > 0) {
          e.preventDefault();
          for (const g of groups) store.ungroupNode(g.id);
        }
      } else if (mod && e.key.toLowerCase() === "l") {
        // 连线：选中恰好两张卡（非分组框）→ 连 source→target（数组序）
        const two = store.nodes.filter(
          (n) => n.selected && n.data.nodeType !== "group",
        );
        if (two.length === 2) {
          e.preventDefault();
          const [a, b] = two;
          const exists = store.edges.some(
            (ed) =>
              (ed.source === a.id && ed.target === b.id) ||
              (ed.source === b.id && ed.target === a.id),
          );
          if (!exists) store.connect({ source: a.id, target: b.id });
        }
      } else if (e.shiftKey && !mod && e.key.toLowerCase() === "f") {
        // 整理画布（对标竞品 ⇧F）：有选区整理选区，无选区整理全画布
        e.preventDefault();
        const selIds = store.nodes
          .filter((n) => n.selected)
          .map((n) => n.id);
        store.tidyNodes(selIds.length > 0 ? selIds : undefined);
      } else if (mod && e.key === "Enter") {
        // 生成选中卡（出图类，恰好单选才动作——多选目标不明确）：
        // 空提示词 = 按卡上标题与正文重生成，与输入条 Ctrl/⌘+Enter
        // 同一条 GENERATE_EVENT 管线（含画风闸）。
        // capture 阶段先行 + stopPropagation：xyflow 节点 a11y 会把聚焦卡上
        // 的 Enter 当作"带 multi 键的点击"切换选中（multiSelectionKeyCode
        // 含 Meta），必须拦在它前面，否则选区已被清空、目标丢失
        const selNodes = store.nodes.filter((n) => n.selected);
        const target =
          selNodes.length === 1 &&
          ["image", "character", "costume", "scene", "prop"].includes(
            String(selNodes[0].data.nodeType),
          )
            ? selNodes[0]
            : undefined;
        if (target) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent<GenerateDetail>(GENERATE_EVENT, {
              detail: {
                nodeId: target.id,
                kind: "image",
                prompt: "",
                refIds: (target.data.refIds as string[] | undefined) ?? [],
              },
            }),
          );
        }
      } else if (e.key === "Tab") {
        // 新建节点：视口中央弹「添加节点」选择器（与双击空白同菜单）
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(OPEN_ADD_MENU_EVENT));
      } else if (mod && e.shiftKey && e.code === "Digit0") {
        e.preventDefault();
        void zoomTo(1, { duration: 250 });
      } else if (mod && e.code === "Digit0") {
        // 适应画布（对齐竞品 ⌘0=fit 语义；100% 复位让给 ⇧⌘0）
        e.preventDefault();
        void fitView({ duration: 300, padding: 0.15 });
      } else if (mod && (e.key === "=" || e.key === "+" || e.key === "-")) {
        e.preventDefault();
        if (e.key === "-") void zoomOut({ duration: 150 });
        else void zoomIn({ duration: 150 });
      } else if (e.shiftKey && !mod && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setCanvasPref("edges", !getCanvasPref("edges"));
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

    // capture 阶段：快捷键先于 xyflow 节点级键盘 a11y / 卡片内 Enter 行为，
    // 否则选区相关的键（⌘Enter）读到的是被 a11y 改过的状态
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("paste", onPaste);
    };
  }, [screenToFlowPosition, zoomIn, zoomOut, zoomTo, fitView]);

  return null;
}
