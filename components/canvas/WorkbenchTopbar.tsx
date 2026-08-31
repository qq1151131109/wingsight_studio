"use client";

/**
 * 工作台轻顶栏（对标即梦式布局的顶栏层）：
 *   左：项目名（点击行内改名，改名同步 store → ActivityBar 下拉联动）
 *   右：协作者头像组 + 「分享」+ 主题切换 + 账户菜单（AccountMenu）
 */

import { useEffect, useRef, useState } from "react";
import { Pencil, Moon, Sun, UserPlus } from "lucide-react";
import { useCanvasStore } from "@/lib/canvas/store";
import { useThemeStore } from "@/lib/theme";
import { renameProject } from "@/lib/projects";
import { listCollaborators } from "@/lib/admin";
import CollaboratorsDialog from "@/components/home/CollaboratorsDialog";
import AccountMenu, { avatarColor } from "@/components/shell/AccountMenu";

export default function WorkbenchTopbar() {
  const projectId = useCanvasStore((s) => s.projectId);
  const projectName = useCanvasStore((s) => s.projectName);
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  const [collabs, setCollabs] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [sharing, setSharing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 初始拉协作者（分享弹窗关闭时 onChanged 已回传最新列表，无需重拉）
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    void (async () => {
      try {
        const list = await listCollaborators(projectId);
        if (alive) setCollabs(list);
      } catch {
        /* 服务离线：头像组留空即可 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  const startEdit = () => {
    setDraft(projectName);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  };

  const commit = async () => {
    setEditing(false);
    const name = draft.trim();
    if (!projectId || !name || name === projectName) return;
    if (await renameProject(projectId, name)) {
      useCanvasStore.setState({ projectName: name });
    }
  };

  return (
    <header className="z-20 flex h-11 shrink-0 items-center gap-2 border-b border-hairline bg-surface-1 px-3">
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="w-60 rounded-md border border-accent-soft bg-surface-2 px-2 py-1 font-editorial text-sm text-text outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={startEdit}
          title="点击重命名项目"
          className="group flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-surface-2"
        >
          <span className="font-editorial truncate text-sm font-semibold text-text">
            {projectName || "未命名项目"}
          </span>
          <Pencil className="h-3 w-3 shrink-0 text-text-4 opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      )}

      <span className="ml-auto" />

      {/* 协作者头像组（首字占位；悬停看全名） */}
      <div
        className="flex items-center -space-x-1.5"
        title={
          collabs.length
            ? `协作者：${collabs.join("、")}`
            : "暂无协作者，点「分享」邀请"
        }
      >
        {collabs.slice(0, 5).map((name) => (
          <span
            key={name}
            className="grid h-6 w-6 place-items-center rounded-full border border-surface-1 text-[10px] font-medium text-white"
            style={{ background: avatarColor(name) }}
          >
            {name.slice(0, 1).toUpperCase()}
          </span>
        ))}
        {collabs.length > 5 ? (
          <span className="grid h-6 w-6 place-items-center rounded-full border border-surface-1 bg-surface-2 text-[10px] text-text-2">
            +{collabs.length - 5}
          </span>
        ) : null}
      </div>

      {/* 主题切换：点一下切到反色（日间↔夜间），覆盖到下个时间边界后恢复 juben
          时间规则（20:00–次日 8:00 自动夜间）。图标显示点击后将到达的主题 */}
      <button
        type="button"
        title={
          resolvedTheme === "dark"
            ? "切换为日间（持续到明早 8:00，之后按时间自动：20:00–8:00 夜间）"
            : "切换为夜间（持续到明早 8:00，之后按时间自动：20:00–8:00 夜间）"
        }
        onClick={() => toggleTheme()}
        className="grid h-8 w-8 place-items-center rounded-md text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
      >
        {resolvedTheme === "dark" ? (
          <Sun className="h-4 w-4" />
        ) : (
          <Moon className="h-4 w-4" />
        )}
      </button>

      <button
        type="button"
        onClick={() => setSharing(true)}
        className="flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
      >
        <UserPlus className="h-3.5 w-3.5" />
        分享
      </button>

      <AccountMenu />

      {sharing && projectId ? (
        <CollaboratorsDialog
          pid={projectId}
          projectName={projectName}
          initial={collabs}
          onClose={() => setSharing(false)}
          onChanged={(list) => setCollabs(list)}
        />
      ) : null}
    </header>
  );
}
