"use client";

/**
 * 视频截取片段弹窗（doc/image-node-ops-spec.md §12，open-ai-canvas
 * canvas-video-segment 简化版）：双滑杆定入出点 + 选段试播，确认后经
 * agent /video/trim（ffmpeg 精确重编码）落新视频卡并连线源卡。
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Scissors, X } from "lucide-react";
import OverlayModal from "./OverlayModal";
import { NODE_FOOTPRINT, absolutePosition, useCanvasStore } from "@/lib/canvas/store";
import { apiFetch } from "@/lib/auth";
import { showToast } from "@/lib/toast";

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

export default function TrimDialog({
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const [dur, setDur] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const previewStopRef = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.min(Math.max(t, 0), dur);
  };

  /** 选段试播：从起点播到终点自动停 */
  const playSegment = () => {
    const v = videoRef.current;
    if (!v || previewing) return;
    setPreviewing(true);
    previewStopRef.current = false;
    v.currentTime = start;
    void v.play().catch(() => undefined);
    const stop = () => {
      if (previewStopRef.current) return;
      previewStopRef.current = true;
      v.pause();
      v.removeEventListener("timeupdate", tick);
      setPreviewing(false);
    };
    const tick = () => {
      if (v.currentTime >= end) stop();
    };
    v.addEventListener("timeupdate", tick);
    v.addEventListener("pause", stop, { once: true });
  };

  const confirm = async () => {
    if (busy || end - start < 0.2) return;
    setBusy(true);
    try {
      const res = await apiFetch("/agent-service/video/trim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl: url, start, end }),
      });
      if (!res.ok) throw new Error((await res.text()) || `截取失败（${res.status}）`);
      const { clipUrl } = (await res.json()) as { clipUrl: string };
      const st0 = useCanvasStore.getState();
      const source = st0.nodes.find((n) => n.id === nodeId);
      const abs = source ? absolutePosition(st0.nodes, source) : { x: 0, y: 0 };
      const st = useCanvasStore.getState();
      const tid = st.addNode({
        position: { x: abs.x + NODE_FOOTPRINT.video.w + 80, y: abs.y },
        data: {
          nodeType: "video",
          title: `${title || "视频"} · 片段`,
          body: "",
          videoUrl: clipUrl,
          status: "ready",
        },
      });
      void st.connect({ source: nodeId, target: tid });
      st.flashNodes([tid]);
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "截取失败");
      setBusy(false);
    }
  };

  const segLen = Math.max(0, end - start);

  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-6"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex w-[min(52rem,92vw)] flex-col gap-3 rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
              <Scissors className="h-4 w-4" />
              截取片段 · {title || "视频"}
            </h3>
            <p className="mt-0.5 text-[11px] text-text-4">
              拖双滑杆定入出点（精确重编码，非关键帧切点）→ 确认后落新视频卡并连线
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

        <video
          ref={videoRef}
          src={url}
          controls
          muted
          crossOrigin="anonymous"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) {
              setDur(d);
              setEnd(Math.min(d, 10));
            }
          }}
          className="max-h-[46vh] w-full rounded-lg border border-hairline bg-black object-contain"
        />

        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-xs text-text-3">
            <span className="w-10 shrink-0">入点</span>
            <input
              type="range"
              min={0}
              max={dur}
              step={0.1}
              value={start}
              onChange={(e) => {
                const v = Math.min(Number(e.target.value), end - 0.2);
                setStart(v);
                seek(v);
              }}
              className="flex-1 accent-[var(--color-accent)]"
            />
            <span className="w-14 shrink-0 text-right tabular-nums text-text">{fmt(start)}</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-text-3">
            <span className="w-10 shrink-0">出点</span>
            <input
              type="range"
              min={0}
              max={dur}
              step={0.1}
              value={end}
              onChange={(e) => {
                const v = Math.max(Number(e.target.value), start + 0.2);
                setEnd(v);
                seek(v);
              }}
              className="flex-1 accent-[var(--color-accent)]"
            />
            <span className="w-14 shrink-0 text-right tabular-nums text-text">{fmt(end)}</span>
          </label>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-hairline px-2.5 py-1.5 text-xs text-text-3 transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40"
              disabled={busy || segLen < 0.2 || previewing}
              onClick={playSegment}
            >
              试播选段
            </button>
            <span className="text-[11px] text-text-4">
              选段 {fmt(start)} → {fmt(end)}（{segLen.toFixed(1)} 秒）
            </span>
          </div>
          <div className="flex items-center gap-2">
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
              data-track="video.trim.confirm"
              disabled={busy || segLen < 0.2}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              onClick={() => void confirm()}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" /> : <Scissors className="h-3.5 w-3.5" />}
              {busy ? "截取中（重编码）…" : "截取片段"}
            </button>
          </div>
        </div>
      </div>
    </OverlayModal>
  );
}
