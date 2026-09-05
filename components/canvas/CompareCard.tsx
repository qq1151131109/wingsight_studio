"use client";

/**
 * A/B 对比卡（doc/image-node-ops-spec.md §12，open-ai-canvas compare-node
 * 范式）：连接两张带图卡到本卡，图 B 叠在图 A 上层，拖动中央手柄按比例
 * 裁切上层图——左右滑动直接对比（原图 vs 重生成、候选 A vs 候选 B）。
 * 上游实时读 store（边即数据，不拷贝图片）；滑杆位置只存组件态（竞品同款
 * 取舍：对比是过程动作，落库无意义）。双上游按连线顺序取前两条。
 */
import { useCallback, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { Columns2 } from "lucide-react";
import { useCanvasStore, type WingNodeData } from "@/lib/canvas/store";
import { focusCardView } from "./nodes";

export default function CompareCard({
  data,
  id,
  selected,
}: {
  data: WingNodeData;
  id: string;
  selected: boolean;
}) {
  const rf = useReactFlow();
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(50); // B 图可见宽度百分比
  const dragging = useRef(false);

  // 上游带图卡：入边顺序取前两张（A 铺底、B 上层）
  const [a, b] = useCanvasStore((s) => {
    const ups: { url: string; title: string }[] = [];
    for (const e of s.edges) {
      if (e.target !== id || ups.length >= 2) continue;
      const n = s.nodes.find((x) => x.id === e.source);
      const url = n?.data.imageUrl as string | undefined;
      if (n && url) ups.push({ url, title: String(n.data.title ?? "") });
    }
    return [ups[0], ups[1]] as const;
  });

  const update = useCanvasStore((s) => s.updateNodeData);

  /** 指针位置 → 滑杆百分比（相对媒体区宽度） */
  const moveHandle = useCallback((clientX: number) => {
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setPos(Math.min(100, Math.max(0, pct)));
  }, []);

  const missing = !a || !b;

  return (
    <div
      className={`ws-card flex h-full w-full flex-col overflow-hidden rounded-xl border bg-surface-1 shadow-sm ${
        selected ? "border-accent ring-1 ring-accent" : "border-hairline"
      }`}
    >
      {/* 标题行 */}
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 pt-2">
        <Columns2 className="h-3.5 w-3.5 shrink-0 text-text-4" />
        <input
          defaultValue={String(data.title ?? "")}
          placeholder="对比卡"
          className="min-w-0 flex-1 truncate bg-transparent text-xs font-medium text-text outline-none placeholder:text-text-4"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== String(data.title ?? "")) update(id, { title: v });
            else e.target.value = String(data.title ?? "");
          }}
        />
      </div>

      {/* 媒体区：A 铺底 + B 上层裁切 */}
      <div
        ref={boxRef}
        className="nodrag nowheel relative mt-1.5 min-h-0 flex-1 cursor-ew-resize select-none overflow-hidden rounded-lg border border-hairline bg-surface-2"
        title={missing ? "连接两张带图卡到本卡（后连的显示在右侧）" : "拖动对比"}
        onDoubleClick={(e) => {
          e.stopPropagation();
          focusCardView(rf, id);
        }}
        onPointerDown={(e) => {
          if (missing) return;
          e.stopPropagation();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          dragging.current = true;
          moveHandle(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging.current) moveHandle(e.clientX);
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        }}
      >
        {missing ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-3 text-center">
            <Columns2 className="h-5 w-5 text-text-4" />
            <p className="text-[11px] text-text-3">连接两张带图卡到本卡</p>
            <p className="text-[10px] text-text-4">拖动画面左右滑动对比（先连的在左）</p>
          </div>
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={a.url} alt={a.title} draggable={false} className="absolute inset-0 h-full w-full object-contain" />
            {b ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={b.url}
                  alt={b.title}
                  draggable={false}
                  className="absolute inset-0 h-full w-full object-contain"
                  style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
                />
                {/* 分割手柄 */}
                <div
                  className="absolute inset-y-0 z-10 w-0.5 bg-white/90 shadow-[0_0_4px_rgba(0,0,0,0.6)]"
                  style={{ left: `${pos}%` }}
                >
                  <span className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-black/50" />
                </div>
                <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1 py-0.5 text-[9px] text-white">
                  {a.title.slice(0, 10) || "A"}
                </span>
                <span className="absolute bottom-1 right-1 rounded bg-black/55 px-1 py-0.5 text-[9px] text-white">
                  {b.title.slice(0, 10) || "B"}
                </span>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
