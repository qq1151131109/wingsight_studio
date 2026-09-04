"use client";

/**
 * NxM 网格切图弹窗（doc/image-node-ops-spec.md §10）：九宫格切图的行列
 * 泛化（novanova canvas-node-split-dialog 范式简化版）——原图预览上叠
 * 网格线实时看切法，行/列 1-12 调节，显示将生成张数与单块像素，确认后
 * 交给 splitImageToGrid 执行。切图是纯前端 canvas 裁块 + 上传，无 LLM。
 */
import { useEffect, useState } from "react";
import OverlayModal from "./OverlayModal";
import { X } from "lucide-react";

const MIN_N = 1;
const MAX_N = 12;

export default function SplitGridDialog({
  url,
  title,
  onClose,
  onConfirm,
}: {
  url: string;
  title: string;
  onClose: () => void;
  onConfirm: (rows: number, cols: number) => void;
}) {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setDims({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
  }, [url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const clamp = (v: number) => Math.min(MAX_N, Math.max(MIN_N, v));
  const total = rows * cols;
  const tileW = dims ? Math.round(dims.w / cols) : null;
  const tileH = dims ? Math.round(dims.h / rows) : null;

  const stepper = (
    label: string,
    value: number,
    set: (v: number) => void,
  ) => (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-text-3">{label}</span>
      <div className="flex items-center overflow-hidden rounded-md border border-hairline">
        <button
          type="button"
          className="px-2 py-0.5 text-sm text-text-3 hover:bg-surface-2 hover:text-text disabled:opacity-30"
          disabled={value <= MIN_N}
          onClick={() => set(clamp(value - 1))}
        >
          −
        </button>
        <span className="w-8 text-center text-xs tabular-nums text-text">{value}</span>
        <button
          type="button"
          className="px-2 py-0.5 text-sm text-text-3 hover:bg-surface-2 hover:text-text disabled:opacity-30"
          disabled={value >= MAX_N}
          onClick={() => set(clamp(value + 1))}
        >
          +
        </button>
      </div>
    </div>
  );

  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex w-[min(46rem,92vw)] flex-col gap-3 rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-text">网格切图 · {title || "未命名"}</h3>
            <p className="mt-0.5 text-[11px] text-text-4">
              调节行列实时预览切法，确认后在原图右侧按网格排布生成子图卡（纯前端裁块，不耗额度）
            </p>
          </div>
          <button
            type="button"
            data-tip="关闭" aria-label="关闭"
            className="rounded p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative mx-auto max-h-[52vh] overflow-hidden rounded-lg border border-hairline bg-surface-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={title} className="max-h-[52vh] w-auto object-contain" />
          {/* 网格预览线：绝对定位 div，比例随 rows/cols */}
          <div className="pointer-events-none absolute inset-0">
            {Array.from({ length: rows - 1 }, (_, i) => (
              <div
                key={`h${i}`}
                className="absolute left-0 right-0 border-t border-dashed border-accent/80"
                style={{ top: `${((i + 1) / rows) * 100}%` }}
              />
            ))}
            {Array.from({ length: cols - 1 }, (_, i) => (
              <div
                key={`v${i}`}
                className="absolute bottom-0 top-0 border-l border-dashed border-accent/80"
                style={{ left: `${((i + 1) / cols) * 100}%` }}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-4">
            {stepper("行", rows, setRows)}
            {stepper("列", cols, setCols)}
          </div>
          <p className="text-[11px] text-text-4">
            将生成 <span className="font-semibold text-text">{total}</span> 张子图
            {tileW && tileH ? ` · 单块约 ${tileW}×${tileH}px` : ""}
            {total === 1 ? "（不切分）" : ""}
          </p>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-hairline px-3 py-1.5 text-xs text-text-3 hover:bg-surface-2 hover:text-text"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            data-track="card.split.confirm"
            disabled={total < 2}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            onClick={() => onConfirm(rows, cols)}
          >
            切图
          </button>
        </div>
      </div>
    </OverlayModal>
  );
}
