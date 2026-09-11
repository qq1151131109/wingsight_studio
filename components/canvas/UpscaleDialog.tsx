"use client";

/**
 * 本地放大弹窗（doc/image-node-ops-spec.md §12，open-ai-canvas
 * canvas-node-upscale-dialog 范式）：目标长边 1K/2K/4K 三档 × 高清（平滑
 * 双三次）/双线性/最近邻（像素风适用）三种插值，纯前端 canvas 重采样零
 * 额度。确认后上传成新图片卡（「{标题} · 2K」）并连线源卡——非破坏性，
 * 原图不动。已达目标档明报禁用；AI 超分等有供应商后再加第二通道。
 */
import { useMemo, useState } from "react";
import { ImageUpscale, Loader2, X } from "lucide-react";
import OverlayModal from "./OverlayModal";
import { uploadAsset } from "@/lib/projects";
import { NODE_FOOTPRINT, absolutePosition, useCanvasStore } from "@/lib/canvas/store";
import { showToast } from "@/lib/toast";

const TARGETS = [
  { key: "1K", long: 1024 },
  { key: "2K", long: 2048 },
  { key: "4K", long: 4096 },
] as const;

const FILTERS = [
  { key: "high", label: "高清", quality: "high" as const },
  { key: "bilinear", label: "双线性", quality: "low" as const },
  { key: "nearest", label: "最近邻", quality: "low" as const },
] as const;

export default function UpscaleDialog({
  nodeId,
  url,
  title,
  onClose,
}: {
  nodeId: string;
  url: string;
  title: string;
  onClose: () => void;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [target, setTarget] = useState<(typeof TARGETS)[number] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("high");
  const [busy, setBusy] = useState(false);

  // 加载原图拿真实尺寸
  useMemo(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => setDims({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只按 url 载一次
  }, [url]);

  const curLong = dims ? Math.max(dims.w, dims.h) : 0;
  const pick = (t: (typeof TARGETS)[number]) => setTarget(curLong >= t.long ? null : t);

  const run = async () => {
    if (!dims || !target || busy) return;
    setBusy(true);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.crossOrigin = "anonymous";
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("图片加载失败"));
        i.src = url;
      });
      const scale = target.long / Math.max(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("画布不可用");
      ctx.imageSmoothingEnabled = filter !== "nearest";
      ctx.imageSmoothingQuality = FILTERS.find((f) => f.key === filter)!.quality;
      // 最近邻：先关平滑再画（imageSmoothingEnabled=false 即最近邻采样）
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/png"),
      );
      if (!blob) throw new Error("编码失败");
      const fileUrl = await uploadAsset(blob, "image/png", `${title || "图片"}_${target.key}.png`);
      if (!fileUrl) throw new Error("上传失败");
      const st0 = useCanvasStore.getState();
      const source = st0.nodes.find((n) => n.id === nodeId);
      const abs = source ? absolutePosition(st0.nodes, source) : { x: 0, y: 0 };
      const st = useCanvasStore.getState();
      const tid = st.addNode({
        position: { x: abs.x + NODE_FOOTPRINT.image.w + 80, y: abs.y },
        data: {
          nodeType: "image",
          title: `${title || "图片"} · ${target.key}`,
          body: "",
          imageUrl: fileUrl,
          status: "ready",
        },
      });
      void st.connect({ source: nodeId, target: tid });
      st.flashNodes([tid]);
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "放大失败");
      setBusy(false);
    }
  };

  const fmt = (t: (typeof TARGETS)[number] | null) =>
    t && dims
      ? `${Math.round(dims.w * (t.long / curLong))}×${Math.round(dims.h * (t.long / curLong))}`
      : "";

  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-6 ws-scrim-in"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex w-[min(30rem,92vw)] flex-col gap-3 ws-dialog-in ws-elev-modal rounded-xl bg-surface-1 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
              <ImageUpscale className="h-4 w-4" />
              本地放大 · {title || "图片"}
            </h3>
            <p className="mt-0.5 text-[11px] text-text-4">
              纯前端插值重采样（不耗额度）；AI 超分通道另行接入
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

        <div className="flex flex-col gap-2">
          <span className="text-[11px] text-text-3">
            当前 {dims ? `${dims.w}×${dims.h}` : "读取中…"}（长边 {curLong}）
          </span>
          <div className="flex gap-1.5">
            {TARGETS.map((t) => {
              const reached = curLong >= t.long;
              return (
                <button
                  key={t.key}
                  type="button"
                  className={`flex-1 rounded-md border px-2 py-1.5 text-xs transition-colors ${
                    target?.key === t.key
                      ? "border-accent bg-accent-dim text-text"
                      : "border-hairline text-text-2 hover:border-accent-soft hover:text-text"
                  } ${reached ? "opacity-40" : ""}`}
                  onClick={() => pick(t)}
                  title={reached ? `已达 ${t.key}（长边 ${t.long}），无需放大` : undefined}
                >
                  {t.key}
                  <span className="ml-1 text-[9px] text-text-4">
                    {reached ? "已达" : fmt(t)}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`flex-1 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                  filter === f.key
                    ? "border-accent bg-accent-dim text-text"
                    : "border-hairline text-text-2 hover:border-accent-soft hover:text-text"
                }`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-text-4">
            高清=平滑双三次（照片/绘画）；最近邻=硬边缘（像素风放大小图）
          </p>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-hairline px-3 py-1.5 text-xs text-text-3 hover:bg-surface-2 hover:text-text"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            data-track="card.upscale.confirm"
            disabled={!target || busy}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            onClick={() => void run()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" /> : null}
            {busy ? "处理中…" : `放大到 ${target?.key ?? "—"}`}
          </button>
        </div>
      </div>
    </OverlayModal>
  );
}
