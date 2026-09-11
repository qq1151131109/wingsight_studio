"use client";

/**
 * 画布左上工具条尾组：一键整理画布 + 小地图 / 网格吸附 / 连线显隐三个
 * 视图开关，图标直出一排（曾收在「画布设置」齿轮弹层里，开关状态还得
 * 展开才知道）。偏好存 localStorage（lib/canvas/prefs.ts）。
 * 组宽固定约 145px 且 shrink-0：窄画布由搜索框收缩让位，本组不越界
 * （sidebar-width-reserve-test ⑦ 断言的「末子项在画布内」）。
 */

import { LayoutGrid, Map as MapIcon, Magnet, Spline } from "lucide-react";
import { useCanvasPref, type CanvasPrefKey } from "@/lib/canvas/prefs";
import { useCanvasStore } from "@/lib/canvas/store";

const TOGGLES: {
  key: CanvasPrefKey;
  label: string;
  tip: string;
  Icon: typeof Magnet;
}[] = [
  {
    key: "minimap",
    label: "显示小地图",
    tip: "显示小地图：右下角画布缩略导航",
    Icon: MapIcon,
  },
  {
    key: "snap",
    label: "网格吸附",
    tip: "网格吸附：拖动卡片按 16px 网格落位",
    Icon: Magnet,
  },
  {
    key: "edges",
    label: "显示连线",
    tip: "显示连线：批量生成时藏线降噪（⇧E）",
    Icon: Spline,
  },
];

export default function CanvasSettings() {
  return (
    <div className="flex h-10 shrink-0 items-center rounded-lg border border-hairline bg-surface-1 p-1 shadow-sm">
      <button
        type="button"
        data-tip="一键整理画布：全部卡片按宫格重排（锁定/组内卡不动），可撤销"
        aria-label="一键整理画布"
        className="flex h-8 w-8 items-center justify-center rounded-[4px] text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
        onClick={() => useCanvasStore.getState().tidyNodes()}
      >
        <LayoutGrid className="h-4 w-4" />
      </button>
      {/* 整理是动作，右侧三个是视图开关：细竖线分组 */}
      <span className="mx-0.5 h-4 w-px shrink-0 bg-hairline" aria-hidden="true" />
      {TOGGLES.map(({ key, label, tip, Icon }) => (
        <PrefToggle key={key} prefKey={key} label={label} tip={tip} Icon={Icon} />
      ))}
    </div>
  );
}

function PrefToggle({
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
      aria-label={label}
      data-tip={tip}
      className={`flex h-8 w-8 items-center justify-center rounded-[4px] transition-colors ${value ? "text-accent hover:bg-surface-2" : "text-text-2 hover:bg-surface-2 hover:text-text"}`}
      onClick={() => setValue(!value)}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
