"use client";

/** 全屏图片灯箱：滚轮/双指缩放、拖拽平移、左右翻页、Esc 关闭；
 *  底部操作条：下载 / 复制图片 / 复制链接 / 新标签打开（对标竞品
 *  novanova 详情弹窗、juben FileViewer）。图片卡放大与 PromptBar
 *  引用 chip 预览共用。 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Copy,
  Download,
  ExternalLink,
  Link2,
  Loader2,
  X,
} from "lucide-react";
import OverlayModal from "./OverlayModal";
import {
  copyImageToClipboard,
  copyImageUrl,
  downloadMedia,
} from "@/lib/download";

export type LightboxImage = { src: string; title?: string; meta?: unknown };

/** 上下文动作：开灯箱方按当前图 meta 注入操作钮（如图卡的标注重绘/九宫格/
 *  设为主图/恢复版本——"看图干活"的动作在大图里做，缩略图悬浮条只留快捷键）。
 *  返回 null = 当前图无动作（如 PromptBar 引用预览、他卡图片）。 */
export function Lightbox({
  images,
  index,
  onIndex,
  onClose,
  actions,
}: {
  images: LightboxImage[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  actions?: (
    item: LightboxImage,
    api: { close: () => void },
  ) => React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pct, setPct] = useState(100);
  const cssScaleRef = useRef(1);
  const imgScaleRef = useRef(1);
  const imgPosRef = useRef({ x: 0, y: 0 });
  const tgtScaleRef = useRef(1);
  const tgtPosRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState("");

  const applyTransform = useCallback(() => {
    const img = imageRef.current;
    if (!img) return;
    const s = imgScaleRef.current;
    const p = imgPosRef.current;
    img.style.transform = `scale(${s}) translate(${p.x / s}px, ${p.y / s}px)`;
  }, []);

  const resetView = useCallback(() => {
    imgScaleRef.current = 1;
    imgPosRef.current = { x: 0, y: 0 };
    tgtScaleRef.current = 1;
    tgtPosRef.current = { x: 0, y: 0 };
    applyTransform();
  }, [applyTransform]);

  const displayScale = useCallback(
    () => Math.round(cssScaleRef.current * imgScaleRef.current * 100),
    [],
  );

  /** 点击坐标是否落在图片内容上（object-contain 的留白不算） */
  const pointOnImage = useCallback((cx: number, cy: number): boolean => {
    const img = imageRef.current;
    if (!img?.naturalWidth || !img.naturalHeight) return false;
    const rect = img.getBoundingClientRect();
    const imgRatio = img.naturalWidth / img.naturalHeight;
    const boxRatio = rect.width / rect.height;
    let w: number;
    let h: number;
    let ox: number;
    let oy: number;
    if (imgRatio > boxRatio) {
      w = rect.width;
      h = rect.width / imgRatio;
      ox = 0;
      oy = (rect.height - h) / 2;
    } else {
      h = rect.height;
      w = rect.height * imgRatio;
      oy = 0;
      ox = (rect.width - w) / 2;
    }
    const x = cx - rect.left;
    const y = cy - rect.top;
    return x >= ox && x <= ox + w && y >= oy && y <= oy + h;
  }, []);

  // 滚轮缩放（rAF 平滑逼近目标值）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const isMac = /mac/i.test(navigator.userAgent);
    const onWheel = (e: WheelEvent) => {
      if (!pointOnImage(e.clientX, e.clientY)) return;
      e.preventDefault();
      if (!rafRef.current) {
        tgtScaleRef.current = imgScaleRef.current;
        tgtPosRef.current = imgPosRef.current;
      }
      const dm = e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002;
      let ns = tgtScaleRef.current * Math.pow(2, -e.deltaY * dm * (e.ctrlKey && isMac ? 10 : 1));
      ns = Math.max(0.1, Math.min(10, ns));
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      const k = ns / tgtScaleRef.current;
      tgtScaleRef.current = ns;
      tgtPosRef.current = {
        x: mx * (1 - k) + tgtPosRef.current.x * k,
        y: my * (1 - k) + tgtPosRef.current.y * k,
      };
      if (!rafRef.current) {
        const loop = () => {
          const ts = tgtScaleRef.current;
          const tp = tgtPosRef.current;
          imgScaleRef.current += (ts - imgScaleRef.current) * 0.3;
          imgPosRef.current = {
            x: imgPosRef.current.x + (tp.x - imgPosRef.current.x) * 0.3,
            y: imgPosRef.current.y + (tp.y - imgPosRef.current.y) * 0.3,
          };
          applyTransform();
          const settled =
            Math.abs(imgScaleRef.current - ts) < 0.001 &&
            Math.abs(imgPosRef.current.x - tp.x) < 0.1 &&
            Math.abs(imgPosRef.current.y - tp.y) < 0.1;
          if (settled) {
            imgScaleRef.current = ts;
            imgPosRef.current = tp;
            applyTransform();
            rafRef.current = null;
          } else {
            rafRef.current = requestAnimationFrame(loop);
          }
        };
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [pointOnImage, applyTransform]);

  // 翻页统一走 go：切换时顺带清掉上一张的尺寸读数与操作反馈
  const go = useCallback(
    (i: number) => {
      setDims(null);
      setFlash("");
      onIndex(i);
    },
    [onIndex],
  );

  // 百分比读数与键盘翻页/关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) go(index - 1);
      if (e.key === "ArrowRight" && index < images.length - 1) go(index + 1);
    };
    window.addEventListener("keydown", onKey);
    const t = setInterval(() => setPct(displayScale()), 250);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearInterval(t);
    };
  }, [onClose, go, index, images.length, displayScale]);
  // 切换图片时复位视图（index 由父组件控制，翻页动作统一走 go）
  useEffect(() => {
    resetView();
    movedRef.current = false;
  }, [index, resetView]);
  // 操作反馈文案自动消退
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(""), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  /** 操作条动作统一跑：busy 防重入，成功/失败都闪一条反馈 */
  const runAction = useCallback(
    async (key: string, done: string, fn: () => Promise<void>) => {
      if (busy) return;
      setBusy(key);
      try {
        await fn();
        setFlash(done);
      } catch (e) {
        setFlash(`${done}失败${e instanceof Error && e.message ? `：${e.message}` : ""}`);
      } finally {
        setBusy("");
      }
    },
    [busy],
  );

  const cur = images[index];
  const actionBtn =
    "rounded-full p-1.5 text-white/80 hover:bg-white/20 hover:text-white disabled:opacity-40";
  return (
    <OverlayModal
      ref={containerRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8"
      onMouseMove={(e) => {
        if (!dragging) return;
        movedRef.current = true;
        const p = { x: e.clientX - dragStartRef.current.x, y: e.clientY - dragStartRef.current.y };
        imgPosRef.current = p;
        tgtPosRef.current = p;
        applyTransform();
      }}
      onMouseUp={() => setDragging(false)}
      onClick={() => {
        if (!movedRef.current) onClose();
        movedRef.current = false;
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imageRef}
        src={cur?.src}
        alt={cur?.title}
        onLoad={() => {
          const img = imageRef.current;
          if (!img?.naturalWidth || !img.offsetWidth || !img.offsetHeight) return;
          setDims({ w: img.naturalWidth, h: img.naturalHeight });
          const ratio = img.naturalWidth / img.naturalHeight;
          const boxRatio = img.offsetWidth / img.offsetHeight;
          cssScaleRef.current =
            (ratio > boxRatio ? img.offsetWidth : img.offsetHeight * ratio) /
            img.naturalWidth;
          resetView();
        }}
        onMouseDown={(e) => {
          if (e.button !== 0 || !pointOnImage(e.clientX, e.clientY)) return;
          e.preventDefault();
          setDragging(true);
          dragStartRef.current = {
            x: e.clientX - imgPosRef.current.x,
            y: e.clientY - imgPosRef.current.y,
          };
        }}
        className={`max-h-full max-w-full rounded-lg object-contain shadow-2xl will-change-transform ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />
      {images.length > 1 ? (
        <>
          <button
            type="button"
            data-tip="上一张" aria-label="上一张"
            disabled={index === 0}
            className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 disabled:opacity-30"
            onClick={(e) => {
              e.stopPropagation();
              go(index - 1);
            }}
          >
            ‹
          </button>
          <button
            type="button"
            data-tip="下一张" aria-label="下一张"
            disabled={index === images.length - 1}
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 disabled:opacity-30"
            onClick={(e) => {
              e.stopPropagation();
              go(index + 1);
            }}
          >
            ›
          </button>
          <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs text-white/80">
            {index + 1} / {images.length}
          </span>
        </>
      ) : null}
      <div className="absolute bottom-4 left-4 flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1 text-xs text-white/80">
        <span className="tabular-nums">{pct}%</span>
        {dims ? (
          <>
            <span className="text-white/40">·</span>
            <span className="tabular-nums">{dims.w}×{dims.h}</span>
          </>
        ) : null}
        <button
          type="button"
          className="text-white/70 underline-offset-2 hover:text-white hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            resetView();
          }}
        >
          重置
        </button>
        <span className="text-white/40">滚轮缩放 · 拖拽平移</span>
      </div>
      {/* 操作条（对标竞品详情弹窗）：上下文动作 + 下载/复制图片/复制链接/
           新标签打开，与关闭聚在右上角同一视觉区 */}
      <div className="absolute right-4 top-4 flex items-center gap-2">
        {actions ? (() => {
          const node = actions(cur, { close: onClose });
          return node ? (
            <div className="flex items-center gap-0.5 rounded-full bg-black/50 px-1.5 py-0.5">
              {node}
            </div>
          ) : null;
        })() : null}
        <div className="flex items-center gap-0.5 rounded-full bg-black/50 px-1.5 py-0.5">
          {flash ? <span className="mr-1 px-1 text-xs text-white/90">{flash}</span> : null}
          <button
            type="button"
            data-tip="下载" aria-label="下载"
            disabled={busy === "dl"}
            className={actionBtn}
            data-track="lightbox.download"
            onClick={(e) => {
              e.stopPropagation();
              runAction("dl", "已下载", () =>
                downloadMedia(cur.src, cur.title || "image"),
              );
            }}
          >
            {busy === "dl" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            data-tip="复制图片" aria-label="复制图片"
            disabled={busy === "cp"}
            className={actionBtn}
            data-track="lightbox.copy-image"
            onClick={(e) => {
              e.stopPropagation();
              runAction("cp", "图片已复制", () => copyImageToClipboard(cur.src));
            }}
          >
            {busy === "cp" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            data-tip="复制链接" aria-label="复制链接"
            disabled={busy === "lk"}
            className={actionBtn}
            data-track="lightbox.copy-url"
            onClick={(e) => {
              e.stopPropagation();
              runAction("lk", "链接已复制", () => copyImageUrl(cur.src));
            }}
          >
            <Link2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            data-tip="新标签打开" aria-label="新标签打开"
            className={actionBtn}
            data-track="lightbox.open-tab"
            onClick={(e) => {
              e.stopPropagation();
              window.open(cur.src, "_blank", "noopener");
            }}
          >
            <ExternalLink className="h-4 w-4" />
          </button>
        </div>
        <button
          type="button"
          className="rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          onClick={onClose}
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      {cur?.title ? (
        <span className="absolute left-4 top-4 max-w-72 truncate rounded-full bg-black/50 px-3 py-1 text-xs text-white/80">
          {cur.title}
        </span>
      ) : null}
    </OverlayModal>
  );
}
