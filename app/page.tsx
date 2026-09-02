"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FolderPlus,
  LayoutGrid,
  Lightbulb,
  Loader2,
  Pencil,
  Search,
  Trash2,
  Users,
} from "lucide-react";
import AuthGate from "@/components/shell/AuthGate";
import ConfirmDialog from "@/components/shell/ConfirmDialog";
import AccountMenu from "@/components/shell/AccountMenu";
import TelemetryListener from "@/components/telemetry/TelemetryListener";
import {
  WorkspaceErrorState,
  WorkspaceLoadingState,
  WorkspaceState,
} from "@/components/shell/WorkspaceState";
import CollaboratorsDialog from "@/components/home/CollaboratorsDialog";
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
  const [deleting, setDeleting] = useState<ProjectMeta | null>(null);
  const [collabFor, setCollabFor] = useState<ProjectMeta | null>(null);
  const [error, setError] = useState("");
  // 软导航到未编译路由（dev 首访）要等按需编译数秒；startTransition 让
  // isPending 覆盖全程，按钮转圈/卡片置灰，不再"点了没反应"
  const [pending, startTransition] = useTransition();

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
      startTransition(() => {
        router.push(`/project/${p.id}`);
      });
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
          <Link
            href="/topic-pool"
            className="flex items-center gap-1.5 rounded-md border border-hairline bg-surface-1 px-3 py-1.5 text-xs font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          >
            <Lightbulb className="h-3.5 w-3.5" />
            选题池
          </Link>
          <button
            type="button"
            onClick={() => void create()}
            disabled={creating || pending}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {creating || pending ? (
              <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <FolderPlus className="h-3.5 w-3.5" />
            )}
            新建项目
          </button>
          <AccountMenu />
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
                  : "新建项目进入画布：放剧本、建角色卡、生成分镜表，让助手帮你搭故事板。"
              }
            />
          )
        ) : (
          <div
            className={`grid grid-cols-1 gap-3 transition-opacity sm:grid-cols-2 lg:grid-cols-3 ${
              pending ? "pointer-events-none opacity-60" : ""
            }`}
          >
            {shown.map((p) => (
              <div
                key={p.id}
                className="ws-card group relative cursor-pointer p-4 transition-shadow hover:shadow-md"
                onClick={() =>
                  startTransition(() => {
                    router.push(`/project/${p.id}`);
                  })
                }
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-editorial line-clamp-2 min-h-[2.5rem] text-sm font-semibold text-text">
                    {p.name}
                  </h2>
                  {/* 操作常驻右上角（不折叠）；协作者不显示重命名/删除（无管辖权） */}
                  <div className="nodrag flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-text-4 transition-colors hover:bg-surface-2 hover:text-text"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCollabFor(p);
                      }}
                      data-tip="协作者" aria-label="协作者"
                    >
                      <Users className="h-4 w-4" />
                    </button>
                    {p.canManage ? (
                      <>
                        <button
                          type="button"
                          className="rounded-md p-1.5 text-text-4 transition-colors hover:bg-surface-2 hover:text-text"
                          onClick={(e) => {
                            e.stopPropagation();
                            void rename(p);
                          }}
                          data-tip="重命名" aria-label="重命名"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          className="rounded-md p-1.5 text-text-4 transition-colors hover:bg-danger/10 hover:text-danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleting(p);
                          }}
                          data-tip="删除" aria-label="删除"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-1 text-[11px] text-text-4">
                  {p.ownerName ? (
                    <span
                      className="shrink-0 rounded bg-surface-2 px-1 py-px text-[10px] text-accent"
                      data-tip={`归属：${p.ownerName}`} aria-label={`归属：${p.ownerName}`}
                    >
                      {p.ownerName}
                    </span>
                  ) : null}
                  {(p.collaboratorNames ?? []).slice(0, 2).map((n) => (
                    <span
                      key={n}
                      className="shrink-0 rounded bg-surface-2 px-1 py-px text-[10px] text-text-3"
                      data-tip={`协作：${n}`} aria-label={`协作：${n}`}
                    >
                      {n}
                    </span>
                  ))}
                  {(p.collaboratorNames?.length ?? 0) > 2 ? (
                    <span className="shrink-0 text-[10px] text-text-4">
                      +{(p.collaboratorNames ?? []).length - 2}
                    </span>
                  ) : null}
                  <span className="truncate">
                    编辑于 {formatTime(p.updated_at) || "未知时间"}
                  </span>
                </div>
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

export default function Home() {
  return (
    <AuthGate>
      <TelemetryListener />
      <HomeInner />
    </AuthGate>
  );
}
