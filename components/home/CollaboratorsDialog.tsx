"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, UserPlus, X } from "lucide-react";
import { addCollaborator, removeCollaborator, searchUsers } from "@/lib/admin";
import { getAuthSession, peekAuthSession } from "@/lib/auth-session";

/**
 * 协作者管理弹窗：打开即列出全部用户，点选直接添加（搜索框只做本机过滤）；
 * 二次确认移除。入口已限 owner/admin。
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
  const [allUsers, setAllUsers] = useState<{ id: string; username: string }[] | null>(null);
  const [me, setMe] = useState<string | null>(peekAuthSession()?.username ?? null);
  const [q, setQ] = useState("");
  const [busyName, setBusyName] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 打开即拉全量用户（轻量接口，不含密码/角色）
  useEffect(() => {
    let alive = true;
    void searchUsers("")
      .then((users) => {
        if (alive) setAllUsers(users);
      })
      .catch(() => {
        if (alive) setAllUsers([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 当前用户名缺失时补拉（把「自己」从可添加列表排掉）
  useEffect(() => {
    if (me) return;
    let alive = true;
    void getAuthSession().then((s) => {
      if (alive) setMe(s.username);
    });
    return () => {
      alive = false;
    };
  }, [me]);

  // 可添加 = 全部用户 − 现有协作者 − 自己 − 内置单机账号；再按搜索词本机过滤
  const candidates = useMemo(() => {
    if (!allUsers) return [];
    const kw = q.trim().toLowerCase();
    return allUsers.filter(
      (u) =>
        !collaborators.includes(u.username) &&
        u.username !== me &&
        u.username !== "local" &&
        (!kw || u.username.toLowerCase().includes(kw)),
    );
  }, [allUsers, collaborators, me, q]);

  const add = async (username: string) => {
    setBusyName(username);
    setError("");
    try {
      const next = await addCollaborator(pid, username);
      setCollaborators(next);
      onChanged(next);
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
        className="ws-card flex max-h-[80vh] w-full max-w-md flex-col p-5"
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

        {/* 过滤（本机过滤，不打服务端） */}
        <div className="relative mt-4">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-4" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="过滤用户…"
            className="w-full rounded-md border border-hairline bg-surface-2 py-1.5 pl-8 pr-3 text-sm text-text outline-none focus:border-accent"
          />
        </div>
        {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}

        <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {/* 现有协作者 */}
          <section>
            <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-text-4">
              现有协作者（{collaborators.length}）
            </h4>
            {collaborators.length === 0 ? (
              <p className="py-2 text-center text-xs text-text-4">暂无协作者</p>
            ) : (
              <div className="flex flex-col gap-1">
                {collaborators.map((name) => (
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
                ))}
              </div>
            )}
          </section>

          {/* 全部用户（可添加） */}
          <section>
            <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-text-4">
              全部用户
            </h4>
            {allUsers === null ? (
              <p className="flex items-center justify-center gap-2 py-3 text-xs text-text-4">
                <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
                加载用户列表…
              </p>
            ) : candidates.length === 0 ? (
              <p className="py-2 text-center text-xs text-text-4">
                {q.trim() ? "没有匹配的用户" : "其他用户都已加入"}
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {candidates.map((u) => (
                  <div
                    key={u.id}
                    className="flex items-center justify-between rounded-md border border-hairline-soft bg-surface-1 px-2.5 py-1.5"
                  >
                    <span className="text-sm text-text-2">{u.username}</span>
                    <button
                      type="button"
                      disabled={busyName === u.username}
                      onClick={() => void add(u.username)}
                      className="flex items-center gap-1 rounded p-1 text-accent transition-colors hover:bg-accent-dim disabled:opacity-50"
                      data-tip="添加为协作者" aria-label={`添加 ${u.username}`}
                    >
                      {busyName === u.username ? (
                        <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
                      ) : (
                        <UserPlus className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
