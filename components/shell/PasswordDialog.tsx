"use client";

import { useEffect, useState } from "react";
import { KeyRound, Loader2, X } from "lucide-react";
import { apiFetch, clearToken } from "@/lib/auth";

/**
 * 修改密码弹窗（成员自助；入口在 AccountMenu，admin 不显示——
 * 其密码由服务端 .env.local 管理）。改成功即强制重登：
 * 旧 JWT 虽无状态未失效，但新密码生效后留在原会话容易困惑。
 */
export default function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || !next || !confirm) return;
    if (next !== confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch("/api/v1/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => null)) as { detail?: string } | null;
        setError(
          typeof d?.detail === "string"
            ? d.detail
            : d?.detail
              ? "请求参数不合规"
              : `修改失败（${r.status}）`,
        );
        setBusy(false);
        return;
      }
      setDone(true);
    } catch {
      setError("网络错误，请确认服务已启动");
      setBusy(false);
    }
  };

  const relogin = () => {
    clearToken();
    // 故意整页跳转：与登出同语义，清掉全部内存态
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="ws-card w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        {done ? (
          <>
            <h3 className="font-editorial flex items-center gap-2 text-base font-semibold text-text">
              <KeyRound className="h-4 w-4 text-accent" />
              密码已修改
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-text-3">
              请使用新密码重新登录。
            </p>
            <button
              type="button"
              onClick={relogin}
              className="mt-4 w-full rounded-md bg-accent py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              去登录
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <h3 className="font-editorial text-base font-semibold text-text">
                修改密码
              </h3>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1 text-text-3 hover:bg-surface-2 hover:text-text"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={submit}>
              {(
                [
                  ["当前密码", current, setCurrent, "current-password"],
                  ["新密码（至少 8 位）", next, setNext, "new-password"],
                  ["确认新密码", confirm, setConfirm, "new-password"],
                ] as const
              ).map(([label, value, set, autoComplete]) => (
                <div key={label} className="mt-3">
                  <label className="mb-1 block text-xs font-medium text-text-2">
                    {label}
                  </label>
                  <input
                    type="password"
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    autoComplete={autoComplete}
                    className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent"
                  />
                </div>
              ))}

              {error ? (
                <p className="mt-3 rounded-md bg-danger/10 px-2 py-1.5 text-xs text-danger">
                  {error}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={busy || !current || !next || !confirm}
                className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-md bg-accent py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
                ) : null}
                {busy ? "提交中…" : "确认修改"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
