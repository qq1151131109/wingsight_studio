"use client";

import {
  Drama,
  House,
  LayoutGrid,
  ScrollText,
  Settings,
} from "lucide-react";
import { useRouter } from "next/navigation";

const ITEMS = [
  { id: "canvas", label: "画布", icon: LayoutGrid, enabled: true },
  { id: "script", label: "剧本", icon: ScrollText, enabled: false },
  { id: "assets", label: "资产", icon: Drama, enabled: false },
  { id: "settings", label: "设置", icon: Settings, enabled: false },
] as const;

/** 左侧活动栏：只放画布工作台的上下文工具。
 *  项目级操作（切换 / 新建）统一收在项目首页，账户菜单（身份/改密/退出）
 *  在顶栏右侧（AccountMenu）——这里不放重复入口。 */
export default function ActivityBar() {
  const router = useRouter();

  return (
    <aside className="flex w-14 shrink-0 flex-col items-center border-r border-hairline bg-surface-1/60 py-3 backdrop-blur">
      <div
        className="font-editorial mb-2 flex h-8 w-8 select-none items-center justify-center rounded-lg bg-accent text-sm font-semibold text-white"
        title="Wingsight Studio"
      >
        翼
      </div>
      <button
        type="button"
        title="返回项目首页（切换 / 新建项目）"
        onClick={() => router.push("/")}
        className="mb-1 flex h-8 w-8 items-center justify-center rounded-lg text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
      >
        <House className="h-4 w-4" />
      </button>
      <nav className="flex flex-1 flex-col items-center gap-1">
        {ITEMS.map(({ id, label, icon: Icon, enabled }) => (
          <button
            key={id}
            type="button"
            title={enabled ? label : `${label}（规划中）`}
            disabled={!enabled}
            className={`flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] transition-colors ${
              enabled
                ? "bg-accent-dim text-accent hover:bg-accent-soft"
                : "cursor-not-allowed text-text-4"
            }`}
          >
            <Icon className="h-4.5 w-4.5" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
