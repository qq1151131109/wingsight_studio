"use client";

/**
 * 素材库（对标 libtv 素材库 / open-ai-canvas asset tray）：
 *  - 自动入库：画布上出现新媒体 URL（生成回填 / 上传）即写入项目素材表
 *    （url 去重幂等；装载项目时已有 URL 只记账不回写，避免整页扫库）
 *  - 面板：类型过滤 + 搜索；点击落画布中心建卡；悬停删除
 *  - 「生成历史」即库内 source=generation 的记录，不再单做一份历史
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { Music, Search, Trash2, X } from "lucide-react";
import { NODE_META, useCanvasStore, type WingNodeData } from "@/lib/canvas/store";
import { FOCUS_NODES_EVENT } from "@/lib/canvas/events";
import {
  deleteAsset,
  listAssets,
  saveAsset,
  type AssetKind,
  type AssetRecord,
} from "@/lib/projects";

/** 媒体节点 → 入库描述（无媒体 URL 的卡不入库） */
function mediaOf(node: {
  id: string;
  data: WingNodeData;
}): { kind: AssetKind; url: string } | null {
  const d = node.data;
  if (d.nodeType === "image" && d.imageUrl) return { kind: "image", url: d.imageUrl };
  if (d.nodeType === "video" && d.videoUrl) return { kind: "video", url: d.videoUrl };
  if (d.nodeType === "audio" && d.audioUrl) return { kind: "audio", url: d.audioUrl };
  return null;
}

/** 自动入库（常驻挂载；离线/无项目时静默跳过） */
export function AssetAutoRecorder() {
  const nodes = useCanvasStore((s) => s.nodes);
  const projectId = useCanvasStore((s) => s.projectId);
  const seen = useRef<Set<string>>(new Set());

  // 装载/切换项目：把已有媒体记进账（不回写），换项目后从零记账
  useEffect(() => {
    seen.current = new Set(
      useCanvasStore
        .getState()
        .nodes.map((n) => mediaOf(n)?.url)
        .filter((u): u is string => Boolean(u)),
    );
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    for (const n of nodes) {
      const m = mediaOf(n);
      if (!m || seen.current.has(m.url)) continue;
      seen.current.add(m.url);
      void saveAsset(projectId, {
        kind: m.kind,
        title: n.data.title || NODE_META[n.data.nodeType].label,
        url: m.url,
        source: n.data.status === "ready" ? "generation" : "upload",
      });
    }
  }, [nodes, projectId]);

  return null;
}

const KIND_LABEL: Record<AssetKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

export default function AssetTray({ onClose }: { onClose: () => void }) {
  const [assets, setAssets] = useState<AssetRecord[] | null>(null);
  const [kind, setKind] = useState<AssetKind | "all">("all");
  const [q, setQ] = useState("");
  const projectId = useCanvasStore((s) => s.projectId);
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    void listAssets(projectId)
      .then((list) => {
        if (alive) setAssets(list);
      })
      .catch(() => {
        if (alive) setAssets([]);
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (assets ?? []).filter(
      (a) =>
        (kind === "all" || a.kind === kind) &&
        (!k || a.title.toLowerCase().includes(k)),
    );
  }, [assets, kind, q]);

  /** 落画布中心建卡（复用工具条 addAtCenter 的定位方式） */
  const addToCanvas = (a: AssetRecord) => {
    const rect = document.querySelector(".react-flow")?.getBoundingClientRect();
    const center = screenToFlowPosition({
      x: (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2,
      y: (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2,
    });
    const data: WingNodeData = {
      nodeType: a.kind,
      title: a.title,
      body: "",
      ...(a.kind === "image" ? { imageUrl: a.url, status: "ready" as const } : {}),
      ...(a.kind === "video" ? { videoUrl: a.url, status: "ready" as const } : {}),
      ...(a.kind === "audio" ? { audioUrl: a.url } : {}),
    };
    const id = useCanvasStore.getState().addNode({
      position: { x: Math.round(center.x - 128), y: Math.round(center.y - 90) },
      data,
    });
    useCanvasStore.getState().selectNodes([id]);
    window.dispatchEvent(
      new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: [id] } }),
    );
    onClose();
  };

  return (
    <div className="absolute left-2 top-14 z-20 flex max-h-[62vh] w-64 flex-col rounded-lg border border-hairline bg-surface-1 p-2 shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-text">素材库</h3>
        <button
          type="button"
          title="关闭（Esc）"
          className="nodrag rounded p-0.5 text-text-4 hover:text-text"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        {(["all", "image", "video", "audio"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={`rounded-md px-1.5 py-0.5 text-[10px] transition-colors ${
              kind === k
                ? "bg-accent-dim text-text"
                : "text-text-3 hover:bg-surface-2 hover:text-text"
            }`}
            onClick={() => setKind(k)}
          >
            {k === "all" ? "全部" : KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface-2 px-1.5">
        <Search className="h-3 w-3 shrink-0 text-text-4" />
        <input
          value={q}
          placeholder="搜索素材…"
          className="w-full bg-transparent text-[11px] text-text outline-none placeholder:text-text-4"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="nowheel mt-1.5 flex flex-1 flex-col gap-1 overflow-y-auto">
        {assets === null ? (
          <p className="py-4 text-center text-[11px] text-text-4">读取中…</p>
        ) : shown.length === 0 ? (
          <p className="py-4 text-center text-[11px] text-text-4">
            {assets.length === 0
              ? "素材库为空：生成 / 上传的媒体会自动入库"
              : "无匹配素材"}
          </p>
        ) : (
          shown.map((a) => (
            <div
              key={a.id}
              className="group relative flex cursor-pointer items-center gap-1.5 rounded-md border border-hairline bg-surface-2 px-1.5 py-1 transition-colors hover:border-accent"
              title={`${a.title}（${KIND_LABEL[a.kind]}）— 点击放入画布`}
              onClick={() => addToCanvas(a)}
            >
              <span className="h-8 w-11 shrink-0 overflow-hidden rounded bg-black/10">
                {a.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.url} alt="" className="h-full w-full object-cover" />
                ) : a.kind === "video" ? (
                  <video src={a.url} muted preload="metadata" className="h-full w-full object-cover" />
                ) : (
                  <span className="grid h-full w-full place-items-center text-text-3">
                    <Music className="h-3.5 w-3.5" />
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] text-text">
                  {a.title || "（无标题）"}
                </span>
                <span className="block text-[9px] text-text-4">
                  {a.source === "generation" ? "生成" : "上传"} ·{" "}
                  {(a.created_at || "").slice(0, 10)}
                </span>
              </span>
              <button
                type="button"
                title="从素材库删除（不影响画布卡片）"
                className="shrink-0 rounded p-0.5 text-text-4 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!projectId) return;
                  setAssets((list) =>
                    (list ?? []).filter((x) => x.id !== a.id),
                  );
                  void deleteAsset(projectId, a.id);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
