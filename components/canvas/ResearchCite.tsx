"use client";

/**
 * 调研卷宗的 S 编号引用（卡上版）：悬停浮来源卡、点击开原文。
 * 弹层必须 portal 到 body——卡内滚动容器与 `.ws-card` 的 overflow:hidden
 * 会把卡内 absolute 弹层裁掉（「卡内弹层必须 portal」铁律），fixed +
 * getBoundingClientRect 定位、横向钳制不出屏。ResearchReader 里的非 portal
 * 版本在弹窗内够用，两处不强行合一。
 */

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ResearchSource } from "@/lib/research";

export function RefChip({
  sid,
  source,
}: {
  sid: string;
  source: ResearchSource | undefined;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const open = (v: boolean) => {
    if (!v) {
      setPos(null);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // w-64（256px）弹层居中于 chip，左右各留 8px 钳制；top 锚 chip 上缘 8px
    setPos({
      left: Math.min(Math.max(r.left + r.width / 2, 136), window.innerWidth - 136),
      top: Math.max(r.top - 8, 72),
    });
  };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="mx-0.5 inline-flex h-[16px] min-w-[22px] items-center justify-center rounded border border-hairline bg-surface-2 px-1 align-super text-[9px] font-medium tabular-nums text-text-3 transition-colors hover:border-accent hover:text-accent"
        onMouseEnter={() => open(true)}
        onMouseLeave={() => open(false)}
        onClick={(e) => {
          e.stopPropagation();
          if (source) window.open(source.url, "_blank", "noopener");
        }}
        data-tip={source ? `${sid} ${source.title.slice(0, 30)}` : `${sid}（来源清单未收录）`}
        aria-label={`来源 ${sid}`}
      >
        {sid.replace("S", "")}
      </button>
      {pos && source
        ? createPortal(
            <span className="pointer-events-none fixed z-50 block w-64 -translate-x-1/2 -translate-y-full rounded-lg border border-hairline bg-surface-1 p-2 text-left shadow-xl">
              <span className="line-clamp-2 block text-[10px] font-medium text-text">
                {source.title}
              </span>
              <span className="mt-0.5 block text-[9px] text-text-4">
                {sid} · {source.category}
                {source.fetchStatus === "snippet" ? " · 摘要级" : ""} · {source.domain}
              </span>
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

export function Cite({
  refs,
  sources,
}: {
  refs: string[];
  sources: ResearchSource[];
}) {
  if (!refs.length) return null;
  const map = new Map(sources.map((s) => [s.sid, s]));
  return (
    <span className="ml-1 inline-flex gap-0.5">
      {refs.map((r) => (
        <RefChip key={r} sid={r} source={map.get(r)} />
      ))}
    </span>
  );
}
