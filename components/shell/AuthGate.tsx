"use client";

import { useEffect, useState } from "react";
import { clearToken, fetchAuthStatus, getToken } from "@/lib/auth";

/**
 * 认证守卫（移植自 juben 的 AuthGate 模式）：
 * - AUTH_ENABLED=false → 直接放行（单人模式零感知）
 * - 开启且无 token / token 失效 → 跳登录页
 * - agent 服务不可达 → 放行（离线仍可编辑画布，后续请求再拦）
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "pass">("checking");

  useEffect(() => {
    let alive = true;
    void (async () => {
      const status = await fetchAuthStatus();
      if (!alive) return;
      if (!status?.enabled) {
        setState("pass");
        return;
      }
      if (!getToken()) {
        window.location.href = `/login?from=${encodeURIComponent("/")}`;
        return;
      }
      try {
        const r = await fetch("/api/v1/auth/verify", {
          headers: {
            Authorization: `Bearer ${getToken()}`,
          },
        });
        if (!alive) return;
        if (r.status === 401) {
          clearToken();
          window.location.href = `/login?from=${encodeURIComponent("/")}`;
          return;
        }
      } catch {
        /* 服务不可达：放行，业务请求自行降级 */
      }
      if (alive) setState("pass");
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (state === "checking") {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg text-sm text-text-3">
        Wingsight Studio 加载中…
      </div>
    );
  }
  return <>{children}</>;
}
