"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  ShieldCheck,
  Users,
} from "lucide-react";
import AuthGate from "@/components/shell/AuthGate";
import ConfirmDialog from "@/components/shell/ConfirmDialog";
import {
  createAdminUser,
  createApiKey,
  deleteApiKey,
  fetchVerify,
  listAdminUsers,
  listApiKeys,
  patchAdminUser,
  type AdminUser,
  type ApiKeyCreated,
  type ApiKeyMeta,
} from "@/lib/admin";

/**
 * 管理后台（信息架构照搬 juben AdminUsersPage + ApiKeysTab，纸感重写）：
 *  - 用户管理：统计 / 建号（用户名+密码+角色）/ 改角色 / 停用启用 / 重置密码
 *  - API Key：创建（明文仅展示一次，可复制）/ 列表 / 吊销
 * 认证关闭时匿名 admin 也可用（单人管理自己的 API Key）。
 */

type Tab = "users" | "apikeys";

function AdminInner() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("users");
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    void fetchVerify().then((v) => setRole(v?.role ?? "none"));
  }, []);

  if (role === null) {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg text-sm text-text-3">
        <Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" /> 加载中…
      </div>
    );
  }
  if (role !== "admin") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center bg-bg text-center">
        <ShieldCheck className="mb-3 h-8 w-8 text-text-4" />
        <p className="font-editorial text-lg font-medium text-text-2">需要管理员权限</p>
        <button
          type="button"
          onClick={() => router.push("/")}
          className="mt-4 rounded-md border border-hairline px-3 py-1.5 text-xs text-text-2 hover:bg-surface-2"
        >
          返回首页
        </button>
      </div>
    );
  }

  return (
    <div className="h-dvh overflow-auto bg-bg">
      <header className="sticky top-0 z-10 border-b border-hairline bg-bg/85 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 py-3.5">
          <button
            type="button"
            onClick={() => router.push("/")}
            className="flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回首页
          </button>
          <h1 className="font-editorial mr-auto text-base font-semibold text-text">
            管理后台
          </h1>
          <nav className="flex items-center gap-1 rounded-lg border border-hairline bg-surface-1 p-1">
            {(
              [
                { id: "users", label: "用户", icon: <Users className="h-3.5 w-3.5" /> },
                { id: "apikeys", label: "API Key", icon: <KeyRound className="h-3.5 w-3.5" /> },
              ] as const
            ).map(({ id, label, icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${
                  tab === id
                    ? "bg-accent-dim text-accent"
                    : "text-text-2 hover:bg-surface-2 hover:text-text"
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-6">
        {tab === "users" ? <UsersTab /> : <ApiKeysTab />}
      </main>
    </div>
  );
}

// ==================== 用户管理 ====================

function RoleBadge({ role }: { role: AdminUser["role"] }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] ${
        role === "admin"
          ? "border-accent/40 bg-accent-dim text-accent"
          : "border-hairline bg-surface-2 text-text-3"
      }`}
    >
      {role === "admin" ? "管理员" : "成员"}
    </span>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "member">("member");
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<AdminUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      setUsers(await listAdminUsers());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await listAdminUsers();
        if (alive) {
          setUsers(list);
          setError("");
        }
      } catch {
        if (alive) {
          setError("读取失败");
          setUsers([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const create = async () => {
    if (!username.trim() || !password) return;
    setCreating(true);
    setError("");
    try {
      await createAdminUser(username.trim(), password, newRole);
      setUsername("");
      setPassword("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  const changeRole = async (u: AdminUser, role: "admin" | "member") => {
    if (u.role === role) return;
    try {
      await patchAdminUser(u.id, { role });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新失败");
    }
  };

  const toggleActive = async () => {
    if (!toggling) return;
    const target = toggling;
    setToggling(null);
    try {
      await patchAdminUser(target.id, { is_active: !target.is_active });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新失败");
    }
  };

  const resetPassword = async (u: AdminUser) => {
    const pw = window.prompt(`重置「${u.username}」的密码（至少 1 位）`);
    if (!pw) return;
    try {
      await patchAdminUser(u.id, { password: pw });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "重置失败");
    }
  };

  const active = users?.filter((u) => u.is_active).length ?? 0;
  const admins = users?.filter((u) => u.role === "admin" && u.is_active).length ?? 0;

  return (
    <div>
      {/* 建号表单 */}
      <div className="ws-card mb-5 p-4">
        <h2 className="mb-3 text-sm font-semibold text-text">创建用户</h2>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-[11px] text-text-3" htmlFor="au">用户名</label>
            <input
              id="au"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-40 rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-text-3" htmlFor="ap">初始密码</label>
            <input
              id="ap"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-40 rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-text-3" htmlFor="ar">角色</label>
            <select
              id="ar"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as "admin" | "member")}
              className="rounded-md border border-hairline bg-surface-2 px-2 py-1.5 text-sm text-text-2 outline-none"
            >
              <option value="member">成员</option>
              <option value="admin">管理员</option>
            </select>
          </div>
          <button
            type="button"
            onClick={() => void create()}
            disabled={creating || !username.trim() || !password}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            创建
          </button>
        </div>
      </div>

      {error ? (
        <p className="mb-4 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
      ) : null}

      <p className="mb-2 text-xs text-text-4">
        共 {users?.length ?? 0} 人 · 启用 {active} · 管理员 {admins}
      </p>

      {/* 用户表 */}
      {users === null ? (
        <div className="flex justify-center py-16 text-sm text-text-3">加载中…</div>
      ) : (
        <div className="ws-card divide-y divide-hairline-soft overflow-hidden p-0">
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-text">
                    {u.username}
                  </span>
                  <RoleBadge role={u.role} />
                  {!u.is_active ? (
                    <span className="rounded border border-hairline bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-4">
                      已停用
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[11px] text-text-4">
                  创建于 {u.created_at.slice(0, 10)}
                </p>
              </div>
              <select
                value={u.role}
                onChange={(e) => void changeRole(u, e.target.value as "admin" | "member")}
                className="rounded-md border border-hairline bg-surface-2 px-2 py-1 text-xs text-text-2 outline-none"
                title="更改角色"
              >
                <option value="member">成员</option>
                <option value="admin">管理员</option>
              </select>
              <button
                type="button"
                onClick={() => void resetPassword(u)}
                className="rounded-md border border-hairline px-2 py-1 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
              >
                重置密码
              </button>
              <button
                type="button"
                onClick={() => setToggling(u)}
                className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                  u.is_active
                    ? "border-hairline text-text-2 hover:bg-danger/10 hover:text-danger"
                    : "border-good/40 text-good hover:bg-good/10"
                }`}
              >
                {u.is_active ? "停用" : "启用"}
              </button>
            </div>
          ))}
        </div>
      )}

      {toggling ? (
        <ConfirmDialog
          title={toggling.is_active ? `停用「${toggling.username}」？` : `启用「${toggling.username}」？`}
          message={
            toggling.is_active
              ? "停用后该用户无法登录，已有 token 立即失效。"
              : "启用后该用户可重新登录。"
          }
          confirmText={toggling.is_active ? "停用" : "启用"}
          danger={toggling.is_active}
          onConfirm={() => void toggleActive()}
          onCancel={() => setToggling(null)}
        />
      ) : null}
    </div>
  );
}

// ==================== API Key ====================

function ApiKeysTab() {
  const [keys, setKeys] = useState<ApiKeyMeta[] | null>(null);
  const [name, setName] = useState("");
  const [days, setDays] = useState<string>("30");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyMeta | null>(null);
  const [error, setError] = useState("");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setKeys(await listApiKeys());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
      setKeys([]);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await listApiKeys().catch(() => null);
      if (!alive) return;
      if (list) {
        setKeys(list);
        setError("");
      } else {
        setError("读取失败");
        setKeys([]);
      }
    })();
    return () => {
      alive = false;
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setError("");
    try {
      const k = await createApiKey(name.trim(), days === "" ? 0 : Number(days));
      setCreated(k);
      setCopied(false);
      setName("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 剪贴板不可用 */
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    const target = revoking;
    setRevoking(null);
    try {
      await deleteApiKey(target.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "吊销失败");
    }
  };

  const expired = (k: ApiKeyMeta) =>
    k.expires_at ? new Date(k.expires_at) < new Date() : false;

  return (
    <div>
      <div className="ws-card mb-5 p-4">
        <h2 className="mb-1 text-sm font-semibold text-text">创建 API Key</h2>
        <p className="mb-3 text-[11px] leading-relaxed text-text-3">
          供脚本/自动化以 Bearer 方式调用本服务 API；完整 key 仅创建时展示一次。
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-[11px] text-text-3" htmlFor="kn">名称</label>
            <input
              id="kn"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 ci-deploy"
              className="w-44 rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-text-3" htmlFor="ke">有效期</label>
            <select
              id="ke"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="rounded-md border border-hairline bg-surface-2 px-2 py-1.5 text-sm text-text-2 outline-none"
            >
              <option value="30">30 天</option>
              <option value="90">90 天</option>
              <option value="365">365 天</option>
              <option value="">永不过期</option>
            </select>
          </div>
          <button
            type="button"
            onClick={() => void create()}
            disabled={creating || !name.trim()}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            创建
          </button>
        </div>
      </div>

      {error ? (
        <p className="mb-4 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
      ) : null}

      {keys === null ? (
        <div className="flex justify-center py-16 text-sm text-text-3">加载中…</div>
      ) : keys.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center">
          <KeyRound className="mb-3 h-7 w-7 text-text-4" />
          <p className="text-sm text-text-3">还没有 API Key</p>
        </div>
      ) : (
        <div className="ws-card divide-y divide-hairline-soft overflow-hidden p-0">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-text">{k.name}</span>
                  {expired(k) ? (
                    <span className="rounded border border-danger/40 bg-danger/10 px-1.5 py-0.5 text-[10px] text-danger">
                      已过期
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 font-mono text-[11px] text-text-4">
                  {k.key_prefix}… · 创建 {k.created_at.slice(0, 10)} ·{" "}
                  {k.expires_at ? `过期 ${k.expires_at.slice(0, 10)}` : "永不过期"} ·{" "}
                  {k.last_used_at ? `最近使用 ${k.last_used_at.slice(0, 16).replace("T", " ")}` : "未使用"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRevoking(k)}
                className="rounded-md border border-hairline px-2 py-1 text-xs text-text-2 transition-colors hover:bg-danger/10 hover:text-danger"
              >
                吊销
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 一次性展示完整 key */}
      {created ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="ws-card w-full max-w-md p-5">
            <h3 className="font-editorial text-base font-semibold text-text">
              API Key 已创建
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-text-3">
              完整 key 仅此一次展示，请立即复制保存（名称：{created.name}）：
            </p>
            <div className="mt-3 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-hairline bg-surface-2 px-2.5 py-2 font-mono text-xs text-text">
                {created.key}
              </code>
              <button
                type="button"
                onClick={() => void copy()}
                className="flex shrink-0 items-center gap-1 rounded-md border border-hairline px-2.5 py-2 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-good" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "已复制" : "复制"}
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setCreated(null)}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
              >
                我已保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {revoking ? (
        <ConfirmDialog
          title={`吊销 API Key「${revoking.name}」？`}
          message="使用该 key 的调用将立即失效（401），此操作不可撤销。"
          confirmText="吊销"
          danger
          onConfirm={() => void revoke()}
          onCancel={() => setRevoking(null)}
        />
      ) : null}
    </div>
  );
}

export default function AdminPage() {
  return (
    <AuthGate>
      <AdminInner />
    </AuthGate>
  );
}
