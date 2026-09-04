"use client";

/**
 * 画布导航面板（对标 novanova canvas-navigation-panel）：按类型分组的
 * 卡片清单 + 计数，点击选中并运镜定位；搜索过滤。补足小地图之外的结构化导航。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ListTree, Search, Upload, X } from "lucide-react";
import {
  NODE_META,
  useCanvasStore,
  type WingNodeType,
} from "@/lib/canvas/store";
import { TYPE_ICONS } from "@/lib/canvas/type-icons";
import { FOCUS_NODES_EVENT } from "@/lib/canvas/events";
import { sanitizeCanvas } from "@/lib/canvas/sanitize";
import { reportError } from "@/lib/error-dialog";

export default function OutlinePanel({ onClose }: { onClose: () => void }) {
  const nodes = useCanvasStore((s) => s.nodes);
  const [q, setQ] = useState("");
  // 键盘导航：过滤结果展平后的高亮序号（↑↓ 循环 / Enter 定位），⌘K 呼出
  // 后聚焦搜索框即成命令面板
  const [hi, setHi] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const groups = useMemo(() => {
    const k = q.trim().toLowerCase();
    const filtered = nodes.filter(
      (n) =>
        !k ||
        (n.data.title ?? "").toLowerCase().includes(k) ||
        (n.data.body ?? "").slice(0, 200).toLowerCase().includes(k) ||
        String(NODE_META[n.data.nodeType]?.label ?? "").includes(k),
    );
    const byType = new Map<WingNodeType, typeof filtered>();
    for (const n of filtered) {
      const list = byType.get(n.data.nodeType) ?? [];
      list.push(n);
      byType.set(n.data.nodeType, list);
    }
    return [...byType.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    );
  }, [nodes, q]);

  // 展平序号：跨组连续，Enter 定位当前高亮
  const flatIndex = useMemo(() => {
    const m = new Map<string, number>();
    let i = 0;
    for (const [, list] of groups) for (const n of list) m.set(n.id, i++);
    return m;
  }, [groups]);
  const flatCount = flatIndex.size;

  // 过滤词变化回到首项：渲染期调整自身状态（React adjust-state-during-render
  // 范式，effect 里 setState 会被 React Compiler 打回）
  const [hiQ, setHiQ] = useState(q);
  if (hiQ !== q) {
    setHiQ(q);
    setHi(0);
  }
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-hi="1"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const fileRef = useRef<HTMLInputElement>(null);

  /** 导出画布：结构 JSON（媒体文件仍在服务端 /agent-service/assets/） */
  const exportCanvas = () => {
    const st = useCanvasStore.getState();
    const payload = {
      app: "wingsight-canvas",
      version: 1,
      exportedAt: new Date().toISOString(),
      projectId: st.projectId,
      projectName: st.projectName,
      visualStyle: st.projectStyle,
      viewport: st.viewport,
      nodes: st.nodes.map((n) => {
        const rest = { ...(n as Record<string, unknown>) };
        delete rest.selected;
        delete rest.dragging;
        return rest;
      }),
      edges: st.edges,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `画布-${st.projectName || st.projectId || "未命名"}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /** 导入画布 JSON：校验 + 消毒 + 整体替换（含强制写回服务器） */
  const importCanvas = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text) as {
        app?: string;
        nodes?: unknown[];
        edges?: unknown[];
        visualStyle?: string;
        viewport?: unknown;
      };
      if (data.app !== "wingsight-canvas" || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        reportError("导入失败", "文件不是 wingsight-canvas 导出的画布 JSON");
        return;
      }
      const clean = sanitizeCanvas(data.nodes as never, data.edges as never);
      const st = useCanvasStore.getState();
      st.commitHistory();
      st.replaceCanvas(clean.nodes, clean.edges, st.viewport);
      useCanvasStore.setState({
        projectStyle: String(data.visualStyle ?? ""),
        saveState: "idle",
      });
      reportError(
        "导入完成",
        `载入 ${clean.nodes.length} 张卡片、${clean.edges.length} 条连线` +
          (clean.removedNodes || clean.removedEdges
            ? `（消毒剔除 ${clean.removedNodes} 个坏节点 / ${clean.removedEdges} 条坏连线）`
            : ""),
      );
    } catch (exc) {
      reportError("导入失败", exc instanceof Error ? exc.message : String(exc));
    }
  };

  const locate = (id: string) => {
    useCanvasStore.getState().selectNodes([id]);
    window.dispatchEvent(
      new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: [id] } }),
    );
  };

  return (
    <div className="absolute left-2 top-14 z-20 flex max-h-[62vh] w-60 flex-col rounded-lg border border-hairline bg-surface-1 p-2 shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text">
          <ListTree className="h-3.5 w-3.5" />
          画布导航
        </h3>
        <button
          type="button"
          data-tip="导出画布 JSON（结构备份；媒体文件在服务端 assets）" aria-label="导出画布 JSON（结构备份；媒体文件在服务端 assets）"
          className="nodrag rounded p-0.5 text-text-4 hover:text-text"
          onClick={exportCanvas}
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-tip="导入画布 JSON（整体替换当前画布）" aria-label="导入画布 JSON（整体替换当前画布）"
          className="nodrag rounded p-0.5 text-text-4 hover:text-text"
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void importCanvas(f);
          }}
        />
        <button
          type="button"
          data-tip="关闭（Esc）" aria-label="关闭（Esc）"
          className="nodrag rounded p-0.5 text-text-4 hover:text-text"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1.5 flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface-2 px-1.5">
        <Search className="h-3 w-3 shrink-0 text-text-4" />
        <input
          ref={searchRef}
          value={q}
          placeholder="搜索节点…（↑↓ 选择，Enter 定位）"
          className="w-full bg-transparent text-[11px] text-text outline-none placeholder:text-text-4"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHi((v) => (flatCount ? (v + 1) % flatCount : 0));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setHi((v) => (flatCount ? (v - 1 + flatCount) % flatCount : 0));
            }
            if (e.key === "Enter") {
              e.preventDefault();
              for (const [id, i] of flatIndex)
                if (i === hi) {
                  locate(id);
                  return;
                }
            }
          }}
        />
      </div>
      <div ref={listRef} className="nowheel mt-1.5 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="py-4 text-center text-[11px] text-text-4">
            {nodes.length === 0 ? "画布为空" : "无匹配节点"}
          </p>
        ) : (
          groups.map(([type, list]) => {
            const Icon = TYPE_ICONS[type];
            return (
              <div key={type} className="mb-1.5">
                <p className="flex items-center gap-1 px-1 py-0.5 text-[10px] text-text-4">
                  {Icon ? <Icon className="h-3 w-3" /> : null}
                  {NODE_META[type].label}
                  <span className="ml-auto tabular-nums">{list.length}</span>
                </p>
                {list.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    data-hi={flatIndex.get(n.id) === hi ? "1" : undefined}
                    className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] transition-colors ${
                      flatIndex.get(n.id) === hi
                        ? "bg-accent-dim text-text"
                        : "text-text-2 hover:bg-surface-2 hover:text-text"
                    }`}
                    data-tip="点击定位到画布" aria-label="点击定位到画布"
                    onMouseEnter={() => setHi(flatIndex.get(n.id) ?? 0)}
                    onClick={() => locate(n.id)}
                  >
                    <span
                      className="ws-card-dot shrink-0"
                      style={{ background: NODE_META[type].dot }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {n.data.title || "（无标题）"}
                    </span>
                    {n.selected ? (
                      <span className="shrink-0 text-[9px] text-accent">
                        已选
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
