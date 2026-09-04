"use client";

/**
 * 标注批注弹窗（viedeo ImageEditorModal 简化移植，2026-09-04）：导演审片
 * 在图上画箭头/写字/圈画给反馈。三层模型全矢量——画笔存折线、箭头存端点、
 * 文字存 DOM 元素，选中可拖动/删端点/删除，撤销栈快照元素表；确认时
 * 「底图+标注」在原生分辨率烘焙成一张新图卡+连线（干净底图不动，标注版
 * 是交付物不是覆盖）。入口：灯箱 actions + 右键图片操作段（IMAGE_TOOL_EVENT）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Loader2, MousePointer2, PenLine, Type, Undo2, Redo2, Trash2, X } from "lucide-react";
import OverlayModal from "./OverlayModal";
import { useCanvasStore, absolutePosition, NODE_FOOTPRINT, type WingNodeData } from "@/lib/canvas/store";
import { uploadAsset } from "@/lib/projects";

type ArrowEl = {
  kind: "arrow";
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
};
type TextEl = {
  kind: "text";
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
  width: number;
};
type StrokeEl = {
  kind: "stroke";
  id: string;
  pts: { x: number; y: number }[];
  color: string;
  width: number;
};
type AnnoEl = ArrowEl | TextEl | StrokeEl;

const COLORS = ["#e5484d", "#f5a524", "#30a46c", "#3e63dd", "#ffffff", "#111111"];
const WIDTHS = [4, 8];
const TEXT_SIZE = 28; // 原图坐标系的字号

let uid = 0;
const nextId = () => `a${++uid}`;

export default function AnnotateDialog({
  nodeId,
  onClose,
}: {
  nodeId: string;
  onClose: () => void;
}) {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId));
  const d = node?.data as WingNodeData | undefined;
  const [tool, setTool] = useState<"select" | "pen" | "arrow" | "text">("arrow");
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(WIDTHS[1]);
  const [els, setEls] = useState<AnnoEl[]>([]);
  const [redoStack, setRedoStack] = useState<AnnoEl[][]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  // 绘制中的箭头/笔画（pointer 事件里 setState，React Compiler 合规）
  const [draftArrow, setDraftArrow] = useState<ArrowEl | null>(null);
  const [draftPts, setDraftPts] = useState<{ x: number; y: number }[] | null>(null);
  // 文字输入：落点（原图坐标）非空时渲染 inline input
  const [textAt, setTextAt] = useState<{ x: number; y: number } | null>(null);

  const imgRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<
    | { type: "stroke"; last: { x: number; y: number }; id: string }
    | { type: "arrow"; id: string; end: "p1" | "p2" | "body"; sx: number; sy: number; o: ArrowEl }
    | { type: "text"; id: string; sx: number; sy: number; ox: number; oy: number }
    | null
  >(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !textAt) onClose();
      if ((e.key === "Delete" || e.key === "Backspace") && selId && !textAt) {
        setEls((cur) => cur.filter((x) => x.id !== selId));
        setSelId(null);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        setEls((cur) => {
          if (cur.length === 0) return cur;
          setRedoStack((r) => [...r, cur]);
          return cur.slice(0, -1);
        });
      }
      if ((e.metaKey || e.ctrlKey) && ((e.key === "z" && e.shiftKey) || e.key === "y")) {
        e.preventDefault();
        setRedoStack((r) => {
          if (r.length === 0) return r;
          setEls(r[r.length - 1]);
          return r.slice(0, -1);
        });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose, selId, textAt]);

  // 展示缩放：图片 fit 进舞台容器（等 onLoad 拿到原生尺寸再定）
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!imgSize || !stageRef.current) return;
    const box = stageRef.current.getBoundingClientRect();
    const s = Math.min((box.width - 24) / imgSize.w, (box.height - 24) / imgSize.h, 1);
    setScale(Math.max(0.05, s));
  }, [imgSize]);

  /** 舞台指针坐标 → 原图坐标 */
  const toImg = (e: React.PointerEvent | React.MouseEvent): { x: number; y: number } => {
    const img = imgRef.current;
    if (!img) return { x: 0, y: 0 };
    const r = img.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const commit = (next: AnnoEl[]) => {
    setRedoStack((r) => [...r, els]);
    setEls(next);
  };

  const onStagePointerDown = (e: React.PointerEvent) => {
    if (busy || textAt) return;
    const p = toImg(e);
    if (tool === "pen") {
      const id = nextId();
      dragRef.current = { type: "stroke", last: p, id };
      setDraftPts([p]);
    } else if (tool === "arrow") {
      setDraftArrow({ kind: "arrow", id: "draft", x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, width });
    } else if (tool === "text") {
      setTextAt(p);
    } else {
      setSelId(null);
    }
  };

  const onStagePointerMove = (e: React.PointerEvent) => {
    const p = toImg(e);
    if (dragRef.current?.type === "stroke") {
      const last = dragRef.current.last;
      if (Math.hypot(p.x - last.x, p.y - last.y) < 3 / scale) return;
      dragRef.current.last = p;
      setDraftPts((cur) => (cur ? [...cur, p] : [p]));
    } else if (dragRef.current?.type === "arrow") {
      const dr = dragRef.current;
      setEls((cur) =>
        cur.map((x) =>
          x.id !== dr.id
            ? x
            : dr.end === "body"
              ? {
                  ...x,
                  x1: dr.o.x1 + (p.x - dr.sx),
                  y1: dr.o.y1 + (p.y - dr.sy),
                  x2: dr.o.x2 + (p.x - dr.sx),
                  y2: dr.o.y2 + (p.y - dr.sy),
                }
              : dr.end === "p1"
                ? { ...x, x1: p.x, y1: p.y }
                : { ...x, x2: p.x, y2: p.y },
        ),
      );
    } else if (dragRef.current?.type === "text") {
      const dr = dragRef.current;
      setEls((cur) =>
        cur.map((x) => (x.id !== dr.id ? x : { ...x, x: dr.ox + (p.x - dr.sx), y: dr.oy + (p.y - dr.sy) })),
      );
    } else if (draftArrow) {
      setDraftArrow((cur) => (cur ? { ...cur, x2: p.x, y2: p.y } : cur));
    }
  };

  const onStagePointerUp = () => {
    if (dragRef.current?.type === "stroke" && (draftPts?.length ?? 0) > 1) {
      commit([...els, { kind: "stroke", id: dragRef.current.id, pts: draftPts!, color, width }]);
    }
    if (draftArrow) {
      const a = draftArrow;
      if (Math.hypot(a.x2 - a.x1, a.y2 - a.y1) > 6) commit([...els, { ...a, id: nextId() }]);
    }
    dragRef.current = null;
    setDraftPts(null);
    setDraftArrow(null);
  };

  // 元素命中（选择工具点按）：文字按包围盒、箭头按端点（8px 容差）或线段距离
  const hitTest = (p: { x: number; y: number }): AnnoEl | null => {
    const tol = 10 / scale;
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      if (el.kind === "text") {
        const w = el.text.length * TEXT_SIZE * 0.6;
        if (p.x >= el.x - tol && p.x <= el.x + w + tol && p.y >= el.y - TEXT_SIZE - tol && p.y <= el.y + tol)
          return el;
      } else if (el.kind === "arrow") {
        if (Math.hypot(p.x - el.x1, p.y - el.y1) < tol * 1.5) return el;
        if (Math.hypot(p.x - el.x2, p.y - el.y2) < tol * 1.5) return el;
        const len = Math.hypot(el.x2 - el.x1, el.y2 - el.y1) || 1;
        const t = ((p.x - el.x1) * (el.x2 - el.x1) + (p.y - el.y1) * (el.y2 - el.y1)) / (len * len);
        if (t >= 0 && t <= 1) {
          const cx = el.x1 + t * (el.x2 - el.x1);
          const cy = el.y1 + t * (el.y2 - el.y1);
          if (Math.hypot(p.x - cx, p.y - cy) < tol) return el;
        }
      }
    }
    return null;
  };

  /** 烘焙：底图 + 笔画 + 箭头 + 文字 → 原生分辨率 blob → 新图卡 */
  const bake = async (): Promise<Blob | null> => {
    if (!imgRef.current || !imgSize) return null;
    const canvas = document.createElement("canvas");
    canvas.width = imgSize.w;
    canvas.height = imgSize.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(imgRef.current, 0, 0, canvas.width, canvas.height);
    const arrow = (x1: number, y1: number, x2: number, y2: number, c: string, w: number) => {
      ctx.strokeStyle = c;
      ctx.fillStyle = c;
      ctx.lineWidth = w;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(12, w * 3);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
      ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    };
    for (const el of els) {
      if (el.kind === "stroke") {
        ctx.strokeStyle = el.color;
        ctx.lineWidth = el.width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        el.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
      } else if (el.kind === "arrow") {
        arrow(el.x1, el.y1, el.x2, el.y2, el.color, el.width);
      } else {
        ctx.font = `bold ${TEXT_SIZE}px "Microsoft YaHei", "PingFang SC", sans-serif`;
        ctx.fillStyle = el.color;
        ctx.textBaseline = "alphabetic";
        // 描边垫底保证任何底色上可读
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 4;
        ctx.strokeText(el.text, el.x, el.y);
        ctx.fillText(el.text, el.x, el.y);
      }
    }
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
  };

  const confirm = () => {
    if (busy || !node || !d?.imageUrl || els.length === 0) return;
    setBusy(true);
    void (async () => {
      try {
        const blob = await bake();
        if (!blob) throw new Error("烘焙失败");
        const url = await uploadAsset(blob, "image/png", "annotate.png");
        if (!url) throw new Error("上传失败");
        const st = useCanvasStore.getState();
        const src = st.nodes.find((n) => n.id === nodeId);
        if (!src) return;
        const abs = absolutePosition(st.nodes, src);
        const nw = src.measured?.width ?? NODE_FOOTPRINT.image.w;
        const newId = st.addNode({
          position: { x: abs.x + nw + 80, y: abs.y },
          data: {
            nodeType: "image",
            title: `${d.title || "图片"} · 标注`,
            body: `标注 ${els.length} 处（画笔/箭头/文字）`,
            imageUrl: url,
            status: "ready",
          },
        });
        st.connect({ source: nodeId, target: newId });
        st.flashNodes([newId]);
        onClose();
      } finally {
        setBusy(false);
      }
    })();
  };

  const toolBtn = (t: typeof tool, label: string, Icon: typeof PenLine) => (
    <button
      key={t}
      type="button"
      data-tip={label} aria-label={label}
      className={`rounded-md border p-1.5 transition-colors ${
        tool === t ? "border-accent bg-accent-dim text-text" : "border-hairline text-text-3 hover:text-text"
      }`}
      onClick={() => setTool(t)}
    >
      <Icon className="h-4 w-4" />
    </button>
  );

  const strokes = useMemo(() => els.filter((x): x is StrokeEl => x.kind === "stroke"), [els]);
  const drafting = draftArrow || draftPts;

  if (!d?.imageUrl) return null;

  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex flex-col bg-black/70 p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex min-h-0 flex-1 flex-col gap-2 rounded-xl border border-hairline bg-surface-1 p-3 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-text">标注 · {d.title || "未命名"}</h3>
          <span className="text-[10px] text-text-4">箭头/文字/圈画反馈，确认生成标注版新卡（原图不动）</span>
          <div className="ml-auto flex items-center gap-1.5">
            {toolBtn("select", "选择/移动", MousePointer2)}
            {toolBtn("pen", "画笔", PenLine)}
            {toolBtn("arrow", "箭头", ArrowUpRight)}
            {toolBtn("text", "文字", Type)}
            <span className="mx-1 h-4 w-px bg-hairline" />
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`颜色 ${c}`}
                className={`h-4 w-4 rounded-full border-2 transition-transform hover:scale-110 ${
                  color === c ? "border-accent" : "border-hairline"
                }`}
                style={{ backgroundColor: c }}
                onClick={() => setColor(c)}
              />
            ))}
            {WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                aria-label={`线宽 ${w}`}
                className={`rounded-md border px-1.5 py-0.5 text-[10px] transition-colors ${
                  width === w ? "border-accent bg-accent-dim text-text" : "border-hairline text-text-3"
                }`}
                onClick={() => setWidth(w)}
              >
                {w === WIDTHS[0] ? "细" : "粗"}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-hairline" />
            <button
              type="button" data-tip="撤销（⌘Z）" aria-label="撤销"
              className="rounded-md border border-hairline p-1.5 text-text-3 transition-colors hover:text-text disabled:opacity-30"
              disabled={els.length === 0}
              onClick={() =>
                setEls((cur) => {
                  if (!cur.length) return cur;
                  setRedoStack((r) => [...r, cur]);
                  return cur.slice(0, -1);
                })
              }
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button" data-tip="重做（⇧⌘Z）" aria-label="重做"
              className="rounded-md border border-hairline p-1.5 text-text-3 transition-colors hover:text-text disabled:opacity-30"
              disabled={redoStack.length === 0}
              onClick={() =>
                setRedoStack((r) => {
                  if (!r.length) return r;
                  setEls(r[r.length - 1]);
                  return r.slice(0, -1);
                })
              }
            >
              <Redo2 className="h-4 w-4" />
            </button>
            <button
              type="button" data-tip="删除选中（Del）" aria-label="删除选中"
              className="rounded-md border border-hairline p-1.5 text-text-3 transition-colors hover:text-danger disabled:opacity-30"
              disabled={!selId}
              onClick={() => {
                setEls((cur) => cur.filter((x) => x.id !== selId));
                setSelId(null);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              type="button" data-tip="关闭（Esc）" aria-label="关闭"
              className="rounded-md p-1.5 text-text-3 hover:text-text"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 画布舞台：nowheel 滚轮不穿给画布；工具光标区分 */}
        <div
          ref={stageRef}
          className="nowheel relative min-h-0 flex-1 overflow-hidden rounded-lg"
          style={{ background: "var(--color-surface-2)" }}
          onPointerDown={(e) => {
            if (tool !== "select") {
              e.currentTarget.setPointerCapture(e.pointerId);
              onStagePointerDown(e);
            } else {
              const hit = hitTest(toImg(e));
              setSelId(hit?.id ?? null);
              if (hit?.kind === "arrow") {
                const p = toImg(e);
                const nearP1 = Math.hypot(p.x - hit.x1, p.y - hit.y1) < Math.hypot(p.x - hit.x2, p.y - hit.y2);
                dragRef.current = { type: "arrow", id: hit.id, end: nearP1 ? "p1" : "p2", sx: p.x, sy: p.y, o: hit };
                e.currentTarget.setPointerCapture(e.pointerId);
              } else if (hit?.kind === "text") {
                const p = toImg(e);
                dragRef.current = { type: "text", id: hit.id, sx: p.x, sy: p.y, ox: hit.x, oy: hit.y };
                e.currentTarget.setPointerCapture(e.pointerId);
              }
            }
          }}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
        >
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ width: imgSize ? imgSize.w * scale : undefined }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={d.imageUrl}
              alt=""
              draggable={false}
              className="block select-none"
              style={{ width: "100%", cursor: tool === "select" ? "default" : "crosshair" }}
              onLoad={(e) => {
                const el = e.currentTarget;
                if (el.naturalWidth && el.naturalHeight)
                  setImgSize({ w: el.naturalWidth, h: el.naturalHeight });
              }}
            />
            {/* 笔画：SVG 矢量叠层（与烘焙同源坐标） */}
            <svg
              className="pointer-events-none absolute inset-0"
              width={imgSize?.w ?? 0}
              height={imgSize?.h ?? 0}
              viewBox={`0 0 ${imgSize?.w ?? 0} ${imgSize?.h ?? 0}`}
              style={{ width: "100%", height: "100%", overflow: "visible" }}
            >
              {[...strokes, ...(draftPts && draftPts.length > 1 ? [{ kind: "stroke" as const, id: "draft", pts: draftPts, color, width }] : [])].map(
                (s) => (
                  <polyline
                    key={s.id}
                    points={s.pts.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={s.width}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ),
              )}
              {els
                .filter((x): x is ArrowEl => x.kind === "arrow")
                .concat(draftArrow ? [draftArrow] : [])
                .map((a) => {
                  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
                  const head = Math.max(12, a.width * 3);
                  return (
                    <g key={a.id} stroke={a.color} fill={a.color}>
                      <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} strokeWidth={a.width} strokeLinecap="round" />
                      <polygon
                        points={[
                          `${a.x2},${a.y2}`,
                          `${a.x2 - head * Math.cos(ang - Math.PI / 6)},${a.y2 - head * Math.sin(ang - Math.PI / 6)}`,
                          `${a.x2 - head * Math.cos(ang + Math.PI / 6)},${a.y2 - head * Math.sin(ang + Math.PI / 6)}`,
                        ].join(" ")}
                      />
                    </g>
                  );
                })}
            </svg>
            {/* 文字：DOM 元素（双击已提交的不再编辑，新文字走 inline input） */}
            {els.map((el) =>
              el.kind === "text" ? (
                <span
                  key={el.id}
                  className={`absolute whitespace-pre select-none ${selId === el.id ? "outline-2 outline-dashed outline-accent" : ""}`}
                  style={{
                    left: el.x * scale,
                    top: (el.y - TEXT_SIZE) * scale,
                    color: el.color,
                    fontSize: TEXT_SIZE * scale,
                    fontWeight: 700,
                    textShadow: "0 0 3px rgba(255,255,255,0.85), 0 0 3px rgba(255,255,255,0.85)",
                    lineHeight: 1.1,
                  }}
                >
                  {el.text}
                </span>
              ) : null,
            )}
            {textAt ? (
              <input
                autoFocus
                className="absolute border-none bg-transparent font-bold outline outline-2 outline-accent"
                style={{
                  left: textAt.x * scale,
                  top: (textAt.y - TEXT_SIZE) * scale,
                  color,
                  fontSize: TEXT_SIZE * scale,
                  lineHeight: 1.1,
                }}
                placeholder="输入后 Enter"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = e.currentTarget.value.trim();
                    if (v)
                      commit([
                        ...els,
                        { kind: "text", id: nextId(), x: textAt.x, y: textAt.y, text: v, color, width },
                      ]);
                    setTextAt(null);
                  }
                  if (e.key === "Escape") setTextAt(null);
                }}
                onBlur={() => {
                  setTextAt(null);
                }}
              />
            ) : null}
          </div>
          {els.length === 0 && !drafting ? (
            <p className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-[11px] text-white/70">
              选工具后在图上拖画/点击落字；选择工具可拖动、改端点、删除
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2">
          <p className="text-[10px] text-text-4">全矢量标注 · 确认后烘焙成新图卡（原生分辨率），原图不动</p>
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
              className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-1 transition-opacity hover:opacity-90 disabled:opacity-50"
              data-track="image.annotate"
              disabled={busy || els.length === 0}
              onClick={confirm}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              生成标注卡
            </button>
          </div>
        </div>
      </div>
    </OverlayModal>
  );
}
