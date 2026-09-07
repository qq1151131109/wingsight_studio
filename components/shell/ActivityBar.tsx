"use client";

import {
  Drama,
  House,
  ImagePlus,
  LayoutGrid,
  ScrollText,
  Settings,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCanvasStore } from "@/lib/canvas/store";

const ITEMS = [
  { id: "canvas", label: "画布", icon: LayoutGrid, enabled: true },
  { id: "free-image", label: "生图", icon: ImagePlus, enabled: true },
  { id: "script", label: "剧本", icon: ScrollText, enabled: false },
  { id: "assets", label: "资产", icon: Drama, enabled: false },
  { id: "settings", label: "设置", icon: Settings, enabled: false },
] as const;

/** 左侧活动栏：画布工作台的上下文工具。
 *  画布/生图是项目域的两个视图（互导带当前项目）；项目级操作（切换/新建）
 *  统一收在项目首页，账户菜单在顶栏（AccountMenu）——这里不放重复入口。 */
export default function ActivityBar() {
  const router = useRouter();
  const pathname = usePathname();
  const projectId = useCanvasStore((s) => s.projectId);
  const activeId =
    typeof pathname === "string" && pathname.includes("/image-studio")
      ? "free-image"
      : "canvas";

  const onItem = (id: string) => {
    if (!projectId) return;
    if (id === "free-image") router.push(`/project/${projectId}/image-studio`);
    else if (id === "canvas") router.push(`/project/${projectId}`);
  };

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
        data-tip="返回项目首页（切换 / 新建项目）" aria-label="返回项目首页（切换 / 新建项目）"
        onClick={() => router.push("/")}
        className="mb-1 flex h-8 w-8 items-center justify-center rounded-lg text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
      >
        <House className="h-4 w-4" />
      </button>
      <nav className="flex flex-1 flex-col items-center gap-1">
        {ITEMS.map(({ id, label, icon: Icon, enabled }) => {
          const active = enabled && id === activeId;
          return (
            <button
              key={id}
              type="button"
              data-tip={
                id === "free-image"
                  ? "自由生图：不受画风与资产约束，想生成什么直接说"
                  : enabled
                    ? label
                    : `${label}（规划中）`
              } aria-label={id === "free-image" ? "自由生图" : enabled ? label : `${label}（规划中）`}
              disabled={!enabled}
              data-track={id === "free-image" ? "activity.free-image" : undefined}
              onClick={() => onItem(id)}
              className={`flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] transition-colors ${
                active
                  ? "bg-accent-dim text-accent"
                  : enabled
                    ? "text-text-3 hover:bg-surface-2 hover:text-text"
                    : "cursor-not-allowed text-text-4"
              }`}
            >
              <Icon className="h-4.5 w-4.5" />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
