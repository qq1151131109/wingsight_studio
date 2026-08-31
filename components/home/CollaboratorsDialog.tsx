"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Search, UserPlus, X } from "lucide-react";
import { addCollaborator, removeCollaborator, searchUsers } from "@/lib/admin";

/**
 * 协作者管理弹窗（模式照搬 juben CollaboratorsDialog：
 * 按用户名搜索添加、二次确认移除；入口已限 owner/admin）。
 */
export default function CollaboratorsDialog({
  pid,
  projectName,
  initial,
  onClose,
  onChanged,
}: {
  pid: string;
  projectName: string;
  initial: string[];
  onClose: () => void;
  onChanged: (collaborators: string[]) => void;
}) {
  const [collaborators, setCollaborators] = useState(initial);
  const [q, setQ] = useState("");
  const [suggestions, setSuggestions] = useState<{ id: string; username: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [error, setError] = useState("");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 输入防抖 → 用户检索（排除已是协作者的）；清空与 searching 置位在 onChange 同步处理
  useEffect(() => {
    if (!q.trim()) return;
    debounce.current = setTimeout(() => {
      void searchUsers(q.trim())
        .then((users) =>
          setSuggestions(users.filter((u) => !collaborators.includes(u.username))),
        )
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // collaborators 变化时重新过滤建议列表
  }, [q, collaborators]);

  const onQueryChange = (v: string) => {
    setQ(v);
    if (!v.trim()) {
      if (debounce.current) clearTimeout(debounce.current);
      setSuggestions([]);
      setSearching(false);
    } else {
      setSearching(true);
    }
  };

  const add = async (username: string) => {
    setBusyName(username);
    setError("");
    try {
      const next = await addCollaborator(pid, username);
      setCollaborators(next);
      onChanged(next);
      setSuggestions((s) => s.filter((u) => u.username !== username));
      setQ("");
      setSearching(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "添加失败");
    } finally {
      setBusyName(null);
    }
  };

  const remove = async (username: string) => {
    if (!window.confirm(`移除协作者「${username}」？其将失去本项目的编辑权。`)) return;
    setBusyName(username);
    setError("");
    try {
      const next = await removeCollaborator(pid, username);
      setCollaborators(next);
      onChanged(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "移除失败");
    } finally {
      setBusyName(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="ws-card w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className="flex items-center justify-between">
          <h3 className="font-editorial text-base font-semibold text-text">
            协作者 · {projectName}
          </h3>
          <button
            type="button" data-tip="关闭" aria-label="关闭"
            onClick={onClose}
            className="rounded-md p-1 text-text-3 hover:bg-surface-2 hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-1 text-xs text-text-3">协作者可与所有者同等编辑本项目画布。</p>

        {/* 搜索添加 */}
        <div className="relative mt-4">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-4" />
          <input
            value={q}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="按用户名搜索添加…"
            className="w-full rounded-md border border-hairline bg-surface-2 py-1.5 pl-8 pr-8 text-sm text-text outline-none focus:border-accent"
          />
          {searching ? (
            <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 motion-safe:animate-spin text-text-4" />
          ) : null}
          {q.trim() && suggestions.length > 0 ? (
            <div className="absolute z-10 mt-1 max-h-44 w-full overflow-auto rounded-md border border-hairline bg-surface-1 p-1 shadow-lg">
              {suggestions.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  disabled={busyName === u.username}
                  onClick={() => void add(u.username)}
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm text-text-2 hover:bg-surface-2 hover:text-text"
                >
                  <span>{u.username}</span>
                  <UserPlus className="h-3.5 w-3.5 text-accent" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}

        {/* 名册 */}
        <div className="mt-4 flex flex-col gap-1">
          {collaborators.length === 0 ? (
            <p className="py-4 text-center text-xs text-text-4">暂无协作者</p>
          ) : (
            collaborators.map((name) => (
              <div
                key={name}
                className="flex items-center justify-between rounded-md border border-hairline-soft bg-surface-2 px-2.5 py-1.5"
              >
                <span className="text-sm text-text">{name}</span>
                <button
                  type="button"
                  disabled={busyName === name}
                  onClick={() => void remove(name)}
                  className="rounded p-1 text-text-4 transition-colors hover:bg-danger/10 hover:text-danger"
                  data-tip="移除" aria-label="移除"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
