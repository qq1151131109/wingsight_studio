"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  Drama,
  LayoutGrid,
  Moon,
  ScrollText,
  Settings,
  Sun,
} from "lucide-react";

/** 订阅 <html> 的 dark class（主题脚本/本组件都可能改它） */
function useThemeIsDark() {
  const subscribe = useCallback((onChange: () => void) => {
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
}

const ITEMS = [
  { id: "canvas", label: "画布", icon: LayoutGrid, enabled: true },
  { id: "script", label: "剧本", icon: ScrollText, enabled: false },
  { id: "assets", label: "资产", icon: Drama, enabled: false },
  { id: "settings", label: "设置", icon: Settings, enabled: false },
] as const;

export default function ActivityBar() {
  const dark = useThemeIsDark();

  const toggleTheme = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("wingsight-theme", next ? "dark" : "light");
    } catch {
      /* 忽略隐私模式下的存储异常 */
    }
  };

  return (
    <aside className="flex w-14 shrink-0 flex-col items-center border-r border-hairline bg-surface-1/60 py-3 backdrop-blur">
      <div
        className="font-editorial mb-4 flex h-8 w-8 select-none items-center justify-center rounded-lg bg-accent text-sm font-semibold text-white"
        title="Wingsight Studio"
      >
        翼
      </div>
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
      <button
        type="button"
        title={dark ? "切到浅色" : "切到深色"}
        onClick={toggleTheme}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
      >
        {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
    </aside>
  );
}
