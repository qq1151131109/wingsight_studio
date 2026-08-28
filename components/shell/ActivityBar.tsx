"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  Drama,
  FolderPlus,
  House,
  LayoutGrid,
  LogOut,
  Moon,
  ScrollText,
  Settings,
  Sun,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCanvasStore } from "@/lib/canvas/store";
import { createProject, listProjects, type ProjectMeta } from "@/lib/projects";
import { clearToken, getToken } from "@/lib/auth";

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
  const router = useRouter();
  const dark = useThemeIsDark();
  const projectId = useCanvasStore((s) => s.projectId);
  const projectName = useCanvasStore((s) => s.projectName);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  // 登录/登出都是整页跳转，token 在本页生命周期内不变；AuthGate 保证仅在客户端挂载
  const [hasToken] = useState(() => Boolean(getToken()));

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch {
      /* 服务不可达时保持现有列表 */
    }
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    listProjects()
      .then((ps) => {
        if (alive) setProjects(ps);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [projectId]);

  const switchTo = (pid: string) => {
    window.dispatchEvent(
      new CustomEvent("wingsight:switch-project", { detail: { pid } }),
    );
  };

  const newProject = async () => {
    const name = window.prompt("项目名称", "新项目");
    if (!name?.trim()) return;
    try {
      const created = await createProject(name.trim());
      await refreshProjects();
      switchTo(created.id);
    } catch {
      /* 服务不可达 */
    }
  };

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
        className="font-editorial mb-2 flex h-8 w-8 select-none items-center justify-center rounded-lg bg-accent text-sm font-semibold text-white"
        title="Wingsight Studio"
      >
        翼
      </div>
      {/* 首页 + 项目切换器 */}
      <button
        type="button"
        title="项目首页"
        onClick={() => router.push("/")}
        className="mb-1 flex h-8 w-8 items-center justify-center rounded-lg text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
      >
        <House className="h-4 w-4" />
      </button>
      <div className="mb-3 flex w-12 flex-col items-center gap-1">
        <select
          title={projectName || "切换项目"}
          value={projectId ?? ""}
          onChange={(e) => e.target.value && switchTo(e.target.value)}
          className="w-12 cursor-pointer truncate rounded-md border border-hairline bg-surface-2 px-1 py-0.5 text-[10px] text-text-2 outline-none hover:border-hairline-strong"
        >
          {projects.length === 0 && <option value="">{projectName || "…"}</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          title="新建项目"
          onClick={() => void newProject()}
          className="flex h-6 w-8 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
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
      {hasToken ? (
        <button
          type="button"
          title="退出登录"
          onClick={() => {
            clearToken();
            window.location.href = "/login";
          }}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
        >
          <LogOut className="h-4 w-4" />
        </button>
      ) : null}
    </aside>
  );
}
