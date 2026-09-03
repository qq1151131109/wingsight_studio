"use client";

/**
 * 图片裁剪弹窗（doc/image-node-ops-spec.md P1-1）：8 向手柄 + 比例预设 +
 * 三分线 + 实时像素尺寸。产物走「原位替换 + 旧图自动入版本档」（与上传替换
 * 同范式）——竞品一律另出 (n+1) 张新卡是因为它们没有版本档可回滚。
 * 裁剪坐标全程用原图像素存储（显示层乘 scale），导出按原分辨率无损裁块。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Crop, Loader2, X } from "lucide-react";
import OverlayModal from "./OverlayModal";
import { uploadAsset } from "@/lib/projects";
import { showToast } from "@/lib/toast";
import { useCanvasStore, type WingNodeData } from "@/lib/canvas/store";

/** 比例预设：null = 自由（novanova crop-dialog 范式） */
const ASPECTS: { label: string; ratio: number | null }[] = [
  { label: "自由", ratio: null },
  { label: "1:1", ratio: 1 },
  { label: "16:9", ratio: 16 / 9 },
  { label: "9:16", ratio: 9 / 16 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "3:4", ratio: 3 / 4 },
];

type Rect = { x: number; y: number; w: number; h: number };
type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move";

const MIN_CROP = 16;

function clampRect(r: Rect, W: number, H: number): Rect {
  let { x, y, w, h } = r;
  w = Math.min(Math.max(w, MIN_CROP), W);
  h = Math.min(Math.max(h, MIN_CROP), H);
  x = Math.min(Math.max(0, x), W - w);
  y = Math.min(Math.max(0, y), H - h);
  return { x, y, w, h };
}

/** 比例锁定下按锚点重算宽高：w 与 h 取满足比例的最大值，再平移回界内 */
function applyRatio(r: Rect, ratio: number, W: number, H: number): Rect {
  let w = r.w;
  let h = Math.round(w / ratio);
  if (h > H) {
    h = H;
    w = Math.round(h * ratio);
  }
  if (w > W) {
    w = W;
    h = Math.round(w * ratio);
  }
  return clampRect({ x: r.x, y: r.y, w, h }, W, H);
}

export default function ImageCropDialog({
  nodeId,
  onClose,
}: {
  nodeId: string;
  onClose: () => void;
}) {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId));
  const d = node?.data as WingNodeData | undefined;
  const src = d?.imageUrl ?? "";

  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ w: 0, h: 0 }); // 显示尺寸（scale = view / nat）
  const [crop, setCrop] = useState<Rect | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ handle: Handle; startX: number; startY: number; rect: Rect } | null>(
    null,
  );

  const onImgLoad = useCallback(() => {
    const img = imgRef.current;
    const box = boxRef.current;
    if (!img || !box) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return;
    // 显示宽随弹窗（上限 ~1100px / 66vh），高等比缩
    const scale = Math.min((box.clientWidth - 2) / w, 1, 620 / h);
    const vw = Math.round(w * scale);
    const vh = Math.round(h * scale);
    setNat({ w, h });
    setView({ w: vw, h: vh });
    // 初始框 = 居中 80%
    let c: Rect = {
      x: Math.round(w * 0.1),
      y: Math.round(h * 0.1),
      w: Math.round(w * 0.8),
      h: Math.round(h * 0.8),
    };
    if (ratio) c = applyRatio(c, ratio, w, h);
    setCrop(c);
  }, [ratio]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  const toImgXY = useCallback(
    (e: React.PointerEvent) => {
      const img = imgRef.current;
      if (!img || !view.w) return null;
      const rect = img.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * nat.w,
        y: ((e.clientY - rect.top) / rect.height) * nat.h,
      };
    },
    [nat, view],
  );

  // 手柄统一走 data-handle 属性 + 稳定回调（React Compiler 的 refs 规则
  // 禁止渲染期调函数造闭包再在其中读 ref）
  const onHandleDown = useCallback(
    (e: React.PointerEvent) => {
      const handle = (e.currentTarget as HTMLElement).dataset
        .handle as Handle | undefined;
      if (!handle || !crop) return;
      e.stopPropagation();
      e.preventDefault();
      const p = toImgXY(e);
      if (!p) return;
      drag.current = { handle, startX: p.x, startY: p.y, rect: { ...crop } };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [crop, toImgXY],
  );

  const onDragMove = (e: React.PointerEvent) => {
    const dr = drag.current;
    if (!dr || !crop) return;
    const p = toImgXY(e);
    if (!p) return;
    const dx = p.x - dr.startX;
    const dy = p.y - dr.startY;
    const base = dr.rect;
    let r: Rect;
    if (dr.handle === "move") {
      r = { ...base, x: base.x + dx, y: base.y + dy };
    } else {
      let { x, y, w, h } = base;
      const east = dr.handle.includes("e");
      const west = dr.handle.includes("w");
      const north = dr.handle.startsWith("n");
      const south = dr.handle.startsWith("s");
      if (east) w = base.w + dx;
      if (west) {
        w = base.w - dx;
        x = base.x + dx;
      }
      if (south) h = base.h + dy;
      if (north) {
        h = base.h - dy;
        y = base.y + dy;
      }
      r = clampRect({ x, y, w, h }, nat.w, nat.h);
      if (ratio) r = applyRatio(r, ratio, nat.w, nat.h);
    }
    setCrop(clampRect(r, nat.w, nat.h));
  };

  const endDrag = () => {
    drag.current = null;
  };

  const pickAspect = (r: number | null) => {
    setRatio(r);
    if (r && crop) setCrop(applyRatio(crop, r, nat.w, nat.h));
  };

  const confirm = async () => {
    const img = imgRef.current;
    if (!img || !crop || busy) return;
    setBusy(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(crop.w);
      canvas.height = Math.round(crop.h);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(
        img,
        crop.x,
        crop.y,
        crop.w,
        crop.h,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/png"),
      );
      if (!blob) return;
      const url = await uploadAsset(blob, "image/png", `${d?.title || "图片"}_裁剪.png`);
      if (!url) return; // uploadAsset 已 toast 明报
      const st = useCanvasStore.getState();
      st.commitHistory();
      st.updateNodeData(nodeId, {
        imageUrl: url,
        status: "ready",
        errorMessage: undefined,
        // 旧图入版本档（prompt 归因它当时的提示词，与上传替换同式）
        ...(d?.imageUrl
          ? {
              versions: [
                ...(d.versions ?? []),
                {
                  url: d.imageUrl,
                  at: new Date().toISOString().slice(5, 16).replace("T", " "),
                  prompt: String(d.genPrompt ?? "").trim() || undefined,
                },
              ].slice(-12),
            }
          : {}),
      });
      onClose();
    } catch (exc) {
      showToast(`裁剪失败${exc instanceof Error && exc.message ? `：${exc.message}` : ""}`);
    } finally {
      setBusy(false);
    }
  };

  const s = nat.w && view.w ? view.w / nat.w : 1;
  const px = crop
    ? `${Math.round(crop.w)} × ${Math.round(crop.h)}`
    : "—";

  return (
    <OverlayModal
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex max-h-[92vh] w-[min(94vw,1280px)] flex-col gap-3 rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
            <Crop className="h-4 w-4" />
            裁剪图片 · {d?.title || "未命名"}
          </h3>
          <button
            type="button"
            data-tip="关闭" aria-label="关闭"
            className="rounded p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {ASPECTS.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                ratio === a.ratio
                  ? "border-accent bg-accent-dim text-text"
                  : "border-hairline text-text-3 hover:text-text"
              }`}
              onClick={() => pickAspect(a.ratio)}
            >
              {a.label}
            </button>
          ))}
          <span className="ml-auto font-mono text-[11px] text-text-3">{px}</span>
        </div>

        <div
          ref={boxRef}
          className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg bg-surface-2 p-2"
        >
          {!src ? (
            <p className="text-xs text-text-4">卡片没有图片</p>
          ) : (
            <div
              className="relative shrink-0 select-none"
              style={{ width: view.w || undefined, height: view.h || undefined }}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={src}
                alt={d?.title ?? ""}
                draggable={false}
                className="block max-w-none rounded"
                style={{ width: view.w || undefined, height: view.h || undefined }}
                onLoad={onImgLoad}
              />
              {crop ? (
                <div
                  className="absolute cursor-move"
                  data-handle="move"
                  style={{
                    left: crop.x * s,
                    top: crop.y * s,
                    width: crop.w * s,
                    height: crop.h * s,
                    boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                  }}
                  onPointerDown={onHandleDown}
                >
                  {/* 三分参考线 */}
                  <div className="pointer-events-none absolute inset-0">
                    {[1, 2].map((i) => (
                      <div
                        key={`v${i}`}
                        className="absolute top-0 bottom-0 w-px bg-white/30"
                        style={{ left: `${(i * 100) / 3}%` }}
                      />
                    ))}
                    {[1, 2].map((i) => (
                      <div
                        key={`h${i}`}
                        className="absolute left-0 right-0 h-px bg-white/30"
                        style={{ top: `${(i * 100) / 3}%` }}
                      />
                    ))}
                  </div>
                  {/* 8 向手柄 */}
                  {(
                    [
                      ["nw", "-top-1 -left-1 cursor-nwse-resize"],
                      ["n", "-top-1 left-1/2 -translate-x-1/2 cursor-ns-resize"],
                      ["ne", "-top-1 -right-1 cursor-nesw-resize"],
                      ["e", "top-1/2 -right-1 -translate-y-1/2 cursor-ew-resize"],
                      ["se", "-bottom-1 -right-1 cursor-nwse-resize"],
                      ["s", "-bottom-1 left-1/2 -translate-x-1/2 cursor-ns-resize"],
                      ["sw", "-bottom-1 -left-1 cursor-nesw-resize"],
                      ["w", "top-1/2 -left-1 -translate-y-1/2 cursor-ew-resize"],
                    ] as [Handle, string][]
                  ).map(([h, cls]) => (
                    <div
                      key={h}
                      data-handle={h}
                      className={`absolute h-3 w-3 rounded-sm border border-white bg-accent ${cls}`}
                      onPointerDown={onHandleDown}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2">
          <p className="text-[10px] text-text-4">
            裁剪后原位替换，旧图自动存入版本历史可随时恢复
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-hairline px-3 py-1.5 text-xs text-text-2 transition-colors hover:bg-surface-2"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="button"
              data-track="image.crop"
              className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-1 transition-opacity hover:opacity-90 disabled:opacity-50"
              disabled={busy || !crop || crop.w < MIN_CROP || crop.h < MIN_CROP}
              onClick={() => void confirm()}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              裁剪
            </button>
          </div>
        </div>
      </div>
    </OverlayModal>
  );
}
