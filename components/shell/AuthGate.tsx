"use client";

import { useEffect, useState } from "react";
import { clearToken, getToken, syncAuthCookie } from "@/lib/auth";
import { getAuthSession, peekAuthSession } from "@/lib/auth-session";

/**
 * 认证守卫（结果走 lib/auth-session 模块级缓存，每 SPA 会话只查一次）：
 * - AUTH_ENABLED=false → 直接放行（单人模式零感知）
 * - 开启且无 token / token 失效 → 跳登录页
 * - agent 服务不可达 → 放行（离线仍可编辑画布，后续请求再拦）
 * 已缓存时挂载即同步放行，不再出现"加载中"闪烁。
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "pass">(() =>
    peekAuthSession()?.pass ? "pass" : "checking",
  );

  useEffect(() => {
    if (state === "pass") return;
    let alive = true;
    void getAuthSession().then((s) => {
      if (!alive) return;
      if (!s.pass) {
        clearToken();
        window.location.href = `/login?from=${encodeURIComponent("/")}`;
        return;
      }
      // 存量会话自愈：cookie 机制上线前登录的标签页没有 cookie，补种一次
      // （服务端代理如 /langflow 守卫读 cookie，不读 localStorage）
      const t = getToken();
      if (t) syncAuthCookie(t);
      setState("pass");
    });
    return () => {
      alive = false;
    };
  }, [state]);

  if (state === "checking") {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg text-sm text-text-3">
        Wingsight Studio 加载中…
      </div>
    );
  }
  return <>{children}</>;
}
