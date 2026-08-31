"use client";

/**
 * 标注重绘弹窗（对标 open-ai-canvas mask-edit + viedeo-workflow ImageEditorModal）：
 *  原图上用红色半透明笔刷涂出"想改的区域"，导出合成图作为参考，
 *  连同原图 URL 与改法描述一起发给 agent 做图生图（后端 inpaint 接入后可升级真蒙版）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Brush, Eraser, Undo2, X } from "lucide-react";
import { uploadAsset } from "@/lib/projects";
import { MASK_REDRAW_EVENT, type MaskRedrawDetail } from "@/lib/canvas/events";

const COLORS = ["#ff3b30", "#ffd60a", "#2f7cff"] as const;
const SIZES = [8, 18, 36] as const;

type Stroke = { color: string; size: number; points: { x: number; y: number }[] };

export default function MaskEditDialog({
  nodeId,
  src,
  title,
  onClose,
}: {
  nodeId: string;
  src: string;
  title: string;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const strokes = useRef<Stroke[]>([]);
  const drawing = useRef(false);
  const [color, setColor] = useState<string>(COLORS[0]);
  const [size, setSize] = useState<number>(SIZES[1]);
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [strokeCount, setStrokeCount] = useState(0);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const s of strokes.current) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }, []);

  // 加载原图并按容器宽适配画布
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const maxW = 720;
      const scale = Math.min(1, maxW / img.naturalWidth);
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      imgRef.current = img;
      redraw();
    };
    img.src = src;
  }, [src, redraw]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * e.currentTarget.width,
      y: ((e.clientY - rect.top) / rect.height) * e.currentTarget.height,
    };
  };

  const save = async () => {
    const canvas = canvasRef.current;
    if (!canvas || strokes.current.length === 0 || !prompt.trim()) return;
    setSaving(true);
    try {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92),
      );
      if (!blob) return;
      const annotatedUrl = await uploadAsset(blob, "image/jpeg", `${title}_标注.jpg`);
      if (!annotatedUrl) return;
      window.dispatchEvent(
        new CustomEvent<MaskRedrawDetail>(MASK_REDRAW_EVENT, {
          detail: { nodeId, annotatedUrl, originUrl: src, prompt: prompt.trim() },
        }),
      );
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col gap-2.5 overflow-y-auto rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
            <Brush className="h-4 w-4" />
            标注重绘 · {title || "图片"}
          </h3>
          <button type="button" data-tip="关闭" aria-label="关闭" className="rounded p-0.5 text-text-4 hover:text-text" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-text-4">笔刷</span>
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`h-5 w-5 rounded-full border-2 transition-transform ${
                color === c ? "scale-110 border-text" : "border-transparent"
              }`}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
          <span className="ml-2 text-[10px] text-text-4">粗细</span>
          {SIZES.map((s) => (
            <button
              key={s}
              type="button"
              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                size === s ? "border-accent bg-accent-dim text-text" : "border-hairline text-text-3"
              }`}
              onClick={() => setSize(s)}
            >
              {s}px
            </button>
          ))}
          <button
            type="button"
            data-tip="撤销上一笔" aria-label="撤销上一笔"
            className="ml-auto flex items-center gap-1 rounded border border-hairline px-1.5 py-0.5 text-[10px] text-text-3 hover:text-text"
            onClick={() => {
              strokes.current.pop();
              setStrokeCount(strokes.current.length);
              redraw();
            }}
          >
            <Undo2 className="h-3 w-3" />
            撤销
          </button>
          <button
            type="button"
            data-tip="清空标注" aria-label="清空标注"
            className="flex items-center gap-1 rounded border border-hairline px-1.5 py-0.5 text-[10px] text-text-3 hover:text-text"
            onClick={() => {
              strokes.current = [];
              setStrokeCount(0);
              redraw();
            }}
          >
            <Eraser className="h-3 w-3" />
            清空
          </button>
        </div>

        <canvas
          ref={canvasRef}
          className="nodrag nowheel mx-auto w-full max-w-[720px] cursor-crosshair rounded-lg border border-hairline bg-surface-2"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = true;
            const p = pos(e);
            strokes.current.push({ color, size, points: [p] });
            setStrokeCount(strokes.current.length);
            redraw();
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            strokes.current.at(-1)?.points.push(pos(e));
            redraw();
          }}
          onPointerUp={() => {
            drawing.current = false;
          }}
          onContextMenu={(e) => e.preventDefault()}
        />

        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="标注区域想改成什么？（如：把背景换成雪夜街道，人物保持不变）"
          className="w-full rounded-md border border-hairline bg-surface-2 px-2 py-1.5 text-xs text-text outline-none focus:border-accent placeholder:text-text-4"
        />

        <div className="flex items-center justify-between">
          <span className="text-[10px] text-text-4">
            红笔区域 = 要改的地方；生成时保持画面其余部分不变
          </span>
          <button
            type="button"
            disabled={saving || strokeCount === 0 || !prompt.trim()}
            className="rounded-md border border-accent bg-accent-dim px-3 py-1.5 text-xs text-text transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:border-hairline disabled:bg-surface-2 disabled:text-text-4"
            onClick={() => void save()}
          >
            {saving ? "上传中…" : "保存并让 AI 重绘"}
          </button>
        </div>
      </div>
    </div>
  );
}
