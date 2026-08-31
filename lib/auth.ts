"use client";

/**
 * 认证工具（移植自 juben 前端 utils/auth.ts + api.ts 的 withAuth 模式）。
 * token 存 localStorage；apiFetch 统一注入 Bearer 并在 401 时回登录页。
 * AUTH_ENABLED=false 时无 token 也能正常访问（后端匿名放行）。
 */

const TOKEN_KEY = "wingsight_studio_token";
// 同名 cookie：服务端代理（/langflow 守卫）读不到 localStorage，登录时同步种下
const COOKIE_KEY = "wingsight_studio_token";
const COOKIE_MAX_AGE = 7 * 24 * 3600; // 与 JWT 有效期一致

/** token 变更时同步 cookie（服务端代理鉴权用；无 token 即清除） */
export function syncAuthCookie(token: string | null): void {
  try {
    if (token) {
      document.cookie = `${COOKIE_KEY}=${token}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
    } else {
      document.cookie = `${COOKIE_KEY}=; path=/; max-age=0; SameSite=Lax`;
    }
  } catch {
    /* 隐私模式等忽略 */
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 隐私模式等忽略 */
  }
  syncAuthCookie(token);
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 忽略 */
  }
  syncAuthCookie(null);
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 回跳路径白名单：只允许站内路径，防开放重定向（juben safeReturnPath 同款） */
export function safeReturnPath(from: string | null | undefined): string {
  if (from && from.startsWith("/") && !from.startsWith("//")) return from;
  return "/";
}

/** 带 Bearer 的 fetch；401 清 token 回登录页（保留当前页做回跳） */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (res.status === 401) {
    clearToken();
    const from = encodeURIComponent(
      window.location.pathname + window.location.search,
    );
    window.location.href = `/login?from=${from}`;
  }
  return res;
}

export interface AuthStatus {
  enabled: boolean;
  register_open: boolean;
}

export async function fetchAuthStatus(): Promise<AuthStatus | null> {
  try {
    const r = await fetch("/api/v1/auth/status");
    if (!r.ok) return null;
    return (await r.json()) as AuthStatus;
  } catch {
    return null;
  }
}
