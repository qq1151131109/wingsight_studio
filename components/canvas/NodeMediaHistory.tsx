"use client";

/**
 * 版本历史弹窗（对标 open-ai-canvas version-compare + ai-moive 历史抽屉）：
 *  - 列出当前主图 + 历史版本（重生成前自动存档），一键"设为当前"回滚
 *  - A/B 滑杆对比（移植 compare-node 的 clipPath 双图叠加方案）
 */

import { useRef, useState } from "react";
import { GitCompareArrows, X } from "lucide-react";
import type { WingNodeData } from "@/lib/canvas/store";
import { useCanvasStore } from "@/lib/canvas/store";
import { assetThumbUrl } from "@/lib/asset-thumb";

type Version = { url: string; at: string };

function Thumb({
  url,
  label,
  onClick,
  active,
}: {
  url: string;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative shrink-0 overflow-hidden rounded-lg border transition-colors ${
        active ? "border-accent" : "border-hairline hover:border-accent-soft"
      }`}
      data-tip={`${label} — 点击查看大图 · 双击设为当前`} aria-label={`${label} — 点击查看大图 · 双击设为当前`}
    >
      {isVideoUrl(url) ? (
        <video src={url} muted preload="metadata" className="h-24 w-36 bg-black object-cover" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={assetThumbUrl(url)} alt={label} className="h-24 w-36 object-cover" />
      )}
      <span className="absolute left-1 top-1 rounded bg-black/55 px-1 py-0.5 text-[9px] text-white">
        {label}
      </span>
    </button>
  );
}

function isVideoUrl(url: string) {
  return /\.(mp4|webm|mov)(\?|$)/i.test(url);
}

/** A/B 滑杆对比（clipPath 裁上层图露下层图） */
function ABCompare({ a, b }: { a: string; b: string }) {
  const [split, setSplit] = useState(50);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const moveTo = (clientX: number) => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setSplit(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)));
  };
  return (
    <div
      ref={hostRef}
      className="relative h-full w-full cursor-ew-resize select-none overflow-hidden rounded-lg bg-black"
      onPointerDown={(e) => {
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        moveTo(e.clientX);
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) moveTo(e.clientX);
      }}
      onPointerUp={(e) => {
        draggingRef.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    >
      <img src={b} alt="B" className="absolute inset-0 h-full w-full object-contain" draggable={false} />
      <img
        src={a}
        alt="A"
        className="absolute inset-0 h-full w-full object-contain"
        draggable={false}
        style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
      />
      <div
        className="pointer-events-none absolute inset-y-0 w-px bg-white/90 shadow-[0_0_0_1px_rgba(0,0,0,.35)]"
        style={{ left: `${split}%` }}
      />
      <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">
        A
      </span>
      <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">
        B
      </span>
    </div>
  );
}

export default function VersionHistoryModal({
  nodeId,
  data,
  onClose,
}: {
  nodeId: string;
  data: WingNodeData;
  onClose: () => void;
}) {
  const primary = data.imageUrl ?? data.videoUrl ?? "";
  const versions = data.versions ?? [];
  const isVideo = Boolean(data.videoUrl);
  const [selected, setSelected] = useState<Version | null>(null);
  const entries: Version[] = [
    ...versions,
    ...(primary ? [{ url: primary, at: "当前" }] : []),
  ].reverse();

  const restore = (v: Version) => {
    const st = useCanvasStore.getState();
    st.commitHistory();
    const cur: Version = { url: primary, at: new Date().toISOString().slice(0, 16).replace("T", " ") };
    const rest = (data.versions ?? []).filter((x) => x.url !== v.url);
    st.updateNodeData(nodeId, {
      ...(isVideo ? { videoUrl: v.url } : { imageUrl: v.url }),
      versions: [...rest, cur],
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col gap-3 rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
            <GitCompareArrows className="h-4 w-4" />
            版本历史 · {data.title || "未命名"}
          </h3>
          <button type="button" data-tip="关闭" aria-label="关闭" className="rounded p-0.5 text-text-4 hover:text-text" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {selected ? (
          <div className="flex h-72 flex-col gap-2">
            <ABCompare a={selected.url} b={primary} />
            <div className="flex items-center justify-between text-[11px] text-text-3">
              <span>
                A：{selected.at === "当前" ? "当前版本" : `历史 ${selected.at}`}
                <button className="ml-2 text-accent hover:underline" onClick={() => setSelected(null)}>
                  退出对比
                </button>
              </span>
              <span>B：当前版本</span>
            </div>
          </div>
        ) : (
          <div className="nowheel flex gap-2 overflow-x-auto pb-1">
            {entries.map((v, i) => (
              <div key={`${v.url}_${i}`} className="flex flex-col items-start gap-1">
                <Thumb
                  url={v.url}
                  label={v.at === "当前" ? "当前" : `V${entries.length - i}`}
                  active={v.at === "当前"}
                  onClick={() => setSelected(v)}
                />
                {v.at !== "当前" ? (
                  <button
                    type="button"
                    className="self-center rounded-md border border-hairline px-2 py-0.5 text-[10px] text-text-2 hover:border-accent hover:text-text"
                    onClick={() => restore(v)}
                  >
                    设为当前
                  </button>
                ) : (
                  <span className="self-center text-[10px] text-text-4">当前版本</span>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="text-[10px] text-text-4">
          {selected ? "左右拖动滑杆对比两个版本" : "点击版本进入 A/B 对比；重生成时旧结果自动存档"}
        </p>
      </div>
    </div>
  );
}
