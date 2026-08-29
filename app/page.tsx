"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FolderPlus,
  LayoutGrid,
  Loader2,
  MoreHorizontal,
  Pencil,
  Search,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import AuthGate from "@/components/shell/AuthGate";
import ConfirmDialog from "@/components/shell/ConfirmDialog";
import WelcomeModal from "@/components/shell/WelcomeModal";
import {
  WorkspaceErrorState,
  WorkspaceLoadingState,
  WorkspaceState,
} from "@/components/shell/WorkspaceState";
import CollaboratorsDialog from "@/components/home/CollaboratorsDialog";
import { getAuthSession } from "@/lib/auth-session";
import {
  createProject,
  deleteProject,
  listProjects,
  renameProject,
  type ProjectMeta,
} from "@/lib/projects";

/**
 * 首页 · 项目仪表盘（信息架构照搬 juben ProjectsPage，适配本项目的领域）。
 * 项目卡片网格 + 搜索/排序 + 建删改名 + 协作者管理；点击进入画布工作台。
 */

type SortKey = "recent_edit" | "name_asc";

// 中文按拼音、内嵌数字自然序（juben 同款 collator 配置）
const nameCollator = new Intl.Collator("zh-Hans-CN", {
  numeric: true,
  sensitivity: "base",
});

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = Date.now();
  const diff = now - d.getTime();
  const min = 60_000;
  if (diff < min) return "刚刚";
  if (diff < 60 * min) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))} 小时前`;
  return d.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

function HomeInner() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("recent_edit");
  const [creating, setCreating] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [menuPid, setMenuPid] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ProjectMeta | null>(null);
  const [collabFor, setCollabFor] = useState<ProjectMeta | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setProjects(await listProjects());
      setError("");
    } catch {
      setError("项目列表加载失败（服务未连接？）");
      setProjects([]);
    }
  }, []);

  // 初始加载（内联 IIFE：setState 全部在 await 之后）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await listProjects();
        if (alive) {
          setProjects(list);
          setError("");
        }
      } catch {
        if (alive) {
          setError("项目列表加载失败（服务未连接？）");
          setProjects([]);
        }
      }
    })();
    void getAuthSession().then((s) => {
      if (alive) setIsAdmin(s.role === "admin");
    });
    return () => {
      alive = false;
    };
  }, []);

  const shown = useMemo(() => {
    if (!projects) return [];
    let list = projects;
    const kw = q.trim().toLowerCase();
    if (kw) list = list.filter((p) => p.name.toLowerCase().includes(kw));
    return [...list].sort((a, b) =>
      sort === "name_asc"
        ? nameCollator.compare(a.name, b.name)
        : (b.updated_at || "").localeCompare(a.updated_at || ""),
    );
  }, [projects, q, sort]);

  const create = async () => {
    const name = window.prompt("项目名称", "新项目");
    if (!name?.trim()) return;
    setCreating(true);
    try {
      const p = await createProject(name.trim());
      router.push(`/project/${p.id}`);
    } catch {
      setError("新建项目失败");
    } finally {
      setCreating(false);
    }
  };

  const rename = async (p: ProjectMeta) => {
    const name = window.prompt("重命名项目", p.name);
    if (!name?.trim() || name.trim() === p.name) return;
    if (await renameProject(p.id, name.trim())) void refresh();
    else setError("重命名失败");
    setMenuPid(null);
  };

  const remove = async () => {
    if (!deleting) return;
    if (await deleteProject(deleting.id)) void refresh();
    else setError("删除失败");
    setDeleting(null);
  };

  return (
    <div className="h-dvh overflow-auto bg-bg">
      {/* 顶栏 */}
      <header className="sticky top-0 z-10 border-b border-hairline bg-bg/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-3.5">
          <span className="font-editorial flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-sm font-semibold text-white">
            翼
          </span>
          <div className="mr-auto">
            <h1 className="font-editorial text-base font-semibold leading-tight text-text">
              Wingsight Studio
            </h1>
            <p className="text-[11px] leading-tight text-text-3">AI 影视创作画布</p>
          </div>
          {isAdmin ? (
            <button
              type="button"
              onClick={() => router.push("/admin")}
              className="flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              管理后台
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void create()}
            disabled={creating}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <FolderPlus className="h-3.5 w-3.5" />
            )}
            新建项目
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-6">
        {/* 搜索/排序 */}
        <div className="mb-5 flex items-center gap-2">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-4" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索项目…"
              className="w-full rounded-md border border-hairline bg-surface-2 py-1.5 pl-8 pr-3 text-sm text-text outline-none focus:border-accent"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-md border border-hairline bg-surface-2 px-2 py-1.5 text-xs text-text-2 outline-none"
          >
            <option value="recent_edit">最近编辑</option>
            <option value="name_asc">名称（拼音）</option>
          </select>
          <span className="ml-auto text-xs text-text-4">
            {projects ? `${projects.length} 个项目` : ""}
          </span>
        </div>

        {error ? (
          <p className="mb-4 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
        ) : null}

        {/* 卡片网格 */}
        {projects === null ? (
          <WorkspaceLoadingState label="加载项目…" />
        ) : shown.length === 0 ? (
          error ? (
            <WorkspaceErrorState
              title="项目列表加载失败"
              description="服务可能未启动，当前内容不会被覆盖。"
              onRetry={() => void refresh()}
            />
          ) : (
            <WorkspaceState
              icon={<LayoutGrid className="mb-3 h-8 w-8 text-text-4" />}
              title={q.trim() ? "没有匹配的项目" : "从这里开始你的第一部片子"}
              description={
                q.trim()
                  ? "换个关键词试试"
                  : "新建项目进入画布：放剧本、建角色卡、拆分镜，让助手帮你搭故事板。"
              }
            />
          )
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((p) => (
              <div
                key={p.id}
                className="ws-card group relative cursor-pointer p-4 transition-shadow hover:shadow-md"
                onClick={() => router.push(`/project/${p.id}`)}
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-editorial line-clamp-2 min-h-[2.5rem] text-sm font-semibold text-text">
                    {p.name}
                  </h2>
                  <button
                    type="button"
                    className="nodrag shrink-0 rounded-md p-1 text-text-4 opacity-0 transition-opacity hover:bg-surface-2 hover:text-text group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuPid(menuPid === p.id ? null : p.id);
                    }}
                    title="更多操作"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-text-4">
                  编辑于 {formatTime(p.updated_at) || "未知时间"}
                </p>

                {/* 卡片菜单 */}
                {menuPid === p.id ? (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuPid(null);
                      }}
                    />
                    <div className="absolute right-3 top-10 z-20 flex w-32 flex-col rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
                      <MenuButton
                        icon={<Users className="h-3.5 w-3.5" />}
                        label="协作者"
                        onClick={() => {
                          setCollabFor(p);
                          setMenuPid(null);
                        }}
                      />
                      <MenuButton
                        icon={<Pencil className="h-3.5 w-3.5" />}
                        label="重命名"
                        onClick={() => void rename(p)}
                      />
                      <MenuButton
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        label="删除"
                        danger
                        onClick={() => {
                          setDeleting(p);
                          setMenuPid(null);
                        }}
                      />
                    </div>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </main>

      {deleting ? (
        <ConfirmDialog
          title={`删除项目「${deleting.name}」？`}
          message="项目及其画布数据将被永久删除，此操作不可撤销。"
          confirmText="删除"
          danger
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      ) : null}

      {collabFor ? (
        <CollaboratorsDialog
          pid={collabFor.id}
          projectName={collabFor.name}
          initial={collabFor.collaborators ?? []}
          onClose={() => setCollabFor(null)}
          onChanged={() => void refresh()}
        />
      ) : null}
    </div>
  );
}

function MenuButton({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-2 ${
        danger ? "text-danger" : "text-text-2 hover:text-text"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

export default function Home() {
  return (
    <AuthGate>
      <HomeInner />
      <WelcomeModal />
    </AuthGate>
  );
}
