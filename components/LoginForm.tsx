"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Drama } from "lucide-react";
import { fetchAuthStatus, safeReturnPath, setToken } from "@/lib/auth";

/**
 * 登录页（流程移植自 juben LoginPage：OAuth2 表单 POST → 存 token → 回跳）。
 * AUTH_ENABLED=false 时自动跳回主界面（单人模式不需要登录）。
 */
export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get("from");

  const [checking, setChecking] = useState(true);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const status = await fetchAuthStatus();
      if (!status?.enabled) {
        router.replace(safeReturnPath(from));
        return;
      }
      setRegisterOpen(status.register_open);
      setChecking(false);
    })();
  }, [from, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/v1/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: username.trim(), password }),
      });
      if (!r.ok) {
        setError(r.status === 401 ? "用户名或密码错误" : `登录失败（${r.status}）`);
        setBusy(false);
        return;
      }
      const data = (await r.json()) as { access_token: string };
      setToken(data.access_token);
      window.location.href = safeReturnPath(from);
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
        <div className="mb-1 flex items-center gap-2">
          <span className="font-editorial flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-sm font-semibold text-white">
            翼
          </span>
          <h1 className="font-editorial text-lg font-semibold text-text">
            Wingsight Studio
          </h1>
        </div>
        <p className="mb-5 text-xs leading-relaxed text-text-3">
          AI 影视创作画布 · 请登录后继续
        </p>

        <label className="mb-1 block text-xs font-medium text-text-2" htmlFor="username">
          用户名
        </label>
        <input
          id="username"
          autoComplete="username"
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
          autoComplete="current-password"
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
          {busy ? "登录中…" : "登录"}
        </button>

        {registerOpen ? (
          <p className="mt-4 text-center text-xs text-text-3">
            没有账号？
            <a className="ml-1 text-accent hover:underline" href="/register">
              注册
            </a>
          </p>
        ) : (
          <p className="mt-4 flex items-center justify-center gap-1 text-center text-[11px] text-text-4">
            <Drama className="h-3 w-3" />
            账号由管理员创建
          </p>
        )}
      </form>
    </div>
  );
}
