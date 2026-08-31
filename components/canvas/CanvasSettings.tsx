"use client";

/**
 * 画布设置弹层：小地图 / 网格吸附 / 连线显隐三个视图开关（对标
 * novanova 的小地图开关 + AIGCCanvasFlow 的吸附/网格开关）。偏好存
 * localStorage（lib/canvas/prefs.ts），锚在画布左上工具条末尾。
 */

import { useEffect, useRef, useState } from "react";
import { LayoutGrid, Map as MapIcon, Magnet, Settings2, Spline } from "lucide-react";
import { useCanvasPref, type CanvasPrefKey } from "@/lib/canvas/prefs";
import { useCanvasStore } from "@/lib/canvas/store";

const ITEMS: {
  key: CanvasPrefKey;
  label: string;
  tip: string;
  Icon: typeof Magnet;
}[] = [
  { key: "minimap", label: "显示小地图", tip: "右下角画布缩略导航", Icon: MapIcon },
  { key: "snap", label: "网格吸附", tip: "拖动卡片按 16px 网格落位", Icon: Magnet },
  { key: "edges", label: "显示连线", tip: "批量生成时藏线降噪，快捷键 ⇧E", Icon: Spline },
];

export default function CanvasSettings() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <div className="flex h-10 items-center rounded-lg border border-hairline bg-surface-1 p-1 shadow-sm">
        <button
          type="button"
          data-tip="画布设置"
          aria-label="画布设置"
          aria-expanded={open}
          className={`flex h-8 w-8 items-center justify-center rounded-md text-text-2 transition-colors hover:bg-surface-2 hover:text-text ${
            open ? "bg-surface-2 text-text" : ""
          }`}
          onClick={() => setOpen((o) => !o)}
        >
          <Settings2 className="h-4 w-4" />
        </button>
      </div>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 w-60 rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
            onClick={() => {
              useCanvasStore.getState().tidyNodes();
              setOpen(false);
            }}
          >
            <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-text-3" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-text-2">一键整理画布</span>
              <span className="block truncate text-[10px] text-text-4">
                全部卡片按宫格重排（锁定/组内卡不动），可撤销
              </span>
            </span>
          </button>
          <div className="mx-1 my-1 border-t border-hairline" />
          {ITEMS.map(({ key, label, tip, Icon }) => (
            <PrefRow key={key} prefKey={key} label={label} tip={tip} Icon={Icon} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PrefRow({
  prefKey,
  label,
  tip,
  Icon,
}: {
  prefKey: CanvasPrefKey;
  label: string;
  tip: string;
  Icon: typeof Magnet;
}) {
  const [value, setValue] = useCanvasPref(prefKey);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
      onClick={() => setValue(!value)}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-text-3" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-text-2">{label}</span>
        <span className="block truncate text-[10px] text-text-4">{tip}</span>
      </span>
      <span
        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
          value ? "bg-accent" : "border border-hairline bg-surface-2"
        }`}
      >
        <span
          className={`absolute top-[2px] h-3 w-3 rounded-full shadow-sm transition-[left] ${
            value ? "left-[14px] bg-surface-1" : "left-[2px] bg-text-4"
          }`}
        />
      </span>
    </button>
  );
}
