"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchAuthStatus, safeReturnPath, setToken } from "@/lib/auth";

/** 注册页（AUTH_REGISTER_OPEN=true 时开放；新账号一律普通成员）。 */
export default function RegisterPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const status = await fetchAuthStatus();
      if (!status?.register_open) {
        router.replace(status?.enabled ? "/login" : "/");
        return;
      }
      setChecking(false);
    })();
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!r.ok) {
        const detail = (await r.json().catch(() => null)) as { detail?: string } | null;
        setError(
          r.status === 409
            ? "用户名已存在"
            : (detail?.detail ?? `注册失败（${r.status}）`),
        );
        setBusy(false);
        return;
      }
      const data = (await r.json()) as { access_token: string };
      setToken(data.access_token);
      window.location.href = safeReturnPath(null);
    } catch {
      setError("网络错误，请确认服务已启动");
      setBusy(false);
    }
  };

  if (checking) {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg text-sm text-text-3">
        正在检查服务…
      </div>
    );
  }

  return (
    <div className="flex h-dvh items-center justify-center bg-bg p-6">
      <form onSubmit={submit} className="ws-card w-full max-w-xs p-6">
        <h1 className="font-editorial mb-1 text-lg font-semibold text-text">
          注册账号
        </h1>
        <p className="mb-5 text-xs text-text-3">新账号为普通成员角色</p>

        <label className="mb-1 block text-xs font-medium text-text-2" htmlFor="username">
          用户名
        </label>
        <input
          id="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mb-3 w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent"
        />
        <label className="mb-1 block text-xs font-medium text-text-2" htmlFor="password">
          密码
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent"
        />

        {error ? (
          <p className="mb-3 rounded-md bg-danger/10 px-2 py-1.5 text-xs text-danger">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="w-full rounded-md bg-accent py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "注册中…" : "注册并登录"}
        </button>

        <p className="mt-4 text-center text-xs text-text-3">
          已有账号？
          <a className="ml-1 text-accent hover:underline" href="/login">
            去登录
          </a>
        </p>
      </form>
    </div>
  );
}
