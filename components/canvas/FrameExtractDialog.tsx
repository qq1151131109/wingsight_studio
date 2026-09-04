"use client";

/**
 * 视频抽帧建卡弹窗（doc/image-node-ops-spec.md §11，open-ai-canvas
 * canvas-video-frame 范式简化版）：拖进度条找画面 →「标记此帧」（最多 8 处，
 * 带缩略预览可删）→ 确认后逐帧原生分辨率捕获、上传、在视频卡右侧成排建
 * 图片卡并连线。纯前端捕获 + 现有上传通道，无 LLM。
 */
import { useCallback, useRef, useState } from "react";
import { Film, Loader2, Plus, X } from "lucide-react";
import OverlayModal from "./OverlayModal";
import { uploadAsset } from "@/lib/projects";
import { showToast } from "@/lib/toast";
import { NODE_FOOTPRINT, absolutePosition, useCanvasStore } from "@/lib/canvas/store";

const MAX_MARKS = 8;
const PER_ROW = 4;

export default function FrameExtractDialog({
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [marks, setMarks] = useState<{ t: number; thumb: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");

  const fmt = (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  /** 当前帧捕获为 dataURL（thumb 缩略 / 全尺寸捕获共用一条路径） */
  const capture = useCallback(async (maxW: number): Promise<string> => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) throw new Error("视频未就绪");
    const scale = Math.min(1, maxW / v.videoWidth);
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("画布不可用");
    ctx.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.9);
  }, []);

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return Promise.reject(new Error("视频未就绪"));
    return new Promise<void>((resolve) => {
      const done = () => {
        v.removeEventListener("seeked", done);
        resolve();
      };
      v.addEventListener("seeked", done);
      v.currentTime = t;
    });
  }, []);

  const addMark = async () => {
    const v = videoRef.current;
    if (!v || marks.length >= MAX_MARKS) return;
    const t = v.currentTime;
    if (marks.some((m) => Math.abs(m.t - t) < 0.1)) return;
    const thumb = await capture(160);
    setMarks((prev) => [...prev, { t, thumb }].sort((a, b) => a.t - b.t));
  };

  const confirm = async () => {
    if (marks.length === 0 || busy) return;
    setBusy(true);
    const created: string[] = [];
    try {
      const st0 = useCanvasStore.getState();
      const source = st0.nodes.find((n) => n.id === nodeId);
      const abs = source ? absolutePosition(st0.nodes, source) : { x: 0, y: 0 };
      const vw = NODE_FOOTPRINT.video.w;
      const tileW = NODE_FOOTPRINT.image.w;
      const tileH = 220;
      for (let i = 0; i < marks.length; i++) {
        setProgress(`捕获第 ${i + 1}/${marks.length} 帧…`);
        await seekTo(marks[i].t);
        const dataUrl = await capture(2880);
        const blob = await (await fetch(dataUrl)).blob();
        const fileUrl = await uploadAsset(blob, "image/jpeg", `${title || "视频"}_帧${i + 1}.jpg`);
        if (!fileUrl) throw new Error(`第 ${i + 1} 帧上传失败`);
        const st = useCanvasStore.getState();
        const col = i % PER_ROW;
        const row = Math.floor(i / PER_ROW);
        const tid = st.addNode({
          position: {
            x: abs.x + vw + 80 + col * (tileW + 16),
            y: abs.y + row * (tileH + 16),
          },
          data: {
            nodeType: "image",
            title: `${title || "视频"} · 帧${i + 1}`,
            body: "",
            imageUrl: fileUrl,
            status: "ready",
          },
        });
        void st.connect({ source: nodeId, target: tid });
        created.push(tid);
      }
      if (created.length > 0) {
        useCanvasStore.getState().flashNodes(created);
      }
      onClose();
    } catch (e) {
      setProgress("");
      setBusy(false);
      // 失败就地显示，不静默吞掉半途帧
      showToast(
        `抽帧失败${e instanceof Error && e.message ? `：${e.message}` : ""}`,
      );
    }
  };

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
              <Film className="h-4 w-4" />
              抽帧建卡 · {title || "视频"}
            </h3>
            <p className="mt-0.5 text-[11px] text-text-4">
              拖动进度找画面 → 标记此帧（≤{MAX_MARKS} 处）→ 确认后原生分辨率建图片卡并连线
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
          className="max-h-[46vh] w-full rounded-lg border border-hairline bg-black object-contain"
        />
        <canvas ref={canvasRef} className="hidden" />

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-track="video.frame.mark"
            disabled={busy || marks.length >= MAX_MARKS}
            className="flex items-center gap-1 rounded-md border border-accent bg-accent-dim px-2.5 py-1.5 text-xs text-text transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void addMark()}
          >
            <Plus className="h-3.5 w-3.5" />
            标记当前帧
          </button>
          {marks.length > 0 ? (
            <div className="flex flex-1 flex-wrap items-center gap-1.5">
              {marks.map((m, i) => (
                <span
                  key={`${m.t}-${i}`}
                  className="group relative inline-flex items-center overflow-hidden rounded border border-hairline"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={m.thumb} alt={`帧${i + 1}`} className="h-9 w-16 object-cover" />
                  <span className="absolute bottom-0 left-0 bg-black/60 px-0.5 text-[9px] text-white">
                    {fmt(m.t)}
                  </span>
                  <button
                    type="button"
                    aria-label={`删除标记 ${fmt(m.t)}`}
                    className="absolute right-0 top-0 hidden bg-black/60 p-0.5 text-white group-hover:block"
                    onClick={() => setMarks((prev) => prev.filter((x) => x !== m))}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-text-4">还没有标记</p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2">
          <span className="text-[10px] text-text-4">{progress}</span>
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
              data-track="video.frame.confirm"
              disabled={busy || marks.length === 0}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              onClick={() => void confirm()}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" /> : null}
              {busy ? progress || "抽帧中…" : `建 ${marks.length} 张帧卡`}
            </button>
          </div>
        </div>
      </div>
    </OverlayModal>
  );
}
