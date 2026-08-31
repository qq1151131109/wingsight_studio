/**
 * 认证会话缓存（模块级）：status + verify 一轮往返后全站复用。
 * AuthGate / 首页 isAdmin / 管理后台角色判定都读这里，页面切换不再
 * 各自串行重查（原先进一页要 2-3 个前置请求才出内容）。
 * 登录/登出都是整页跳转，模块重新求值，缓存随会话自然重置。
 * - 服务不可达（status 拉取失败）的"离线放行"结果不落缓存：下次挂载重试，
 *   agent 恢复后自愈（对齐原 AuthGate 每页重查的语义）
 * - token 过期不再由页面守卫踢出（每 SPA 会话只查一次），业务请求自身仍会 401 兜底
 */
import { fetchAuthStatus, getToken } from "@/lib/auth";

export interface AuthSession {
  /** 认证是否开启 */
  enabled: boolean;
  /** verify 的登录名；未登录/离线时为 null，认证关闭时为匿名占位 "local" */
  username: string | null;
  /** verify 角色；认证关闭时服务端匿名 admin，这里同样拿到 "admin" */
  role: string | null;
  /** 守卫判定：关闭认证 / token 校验通过 / 服务不可达离线放行 */
  pass: boolean;
  /** status 是否真实拉到（false = 离线放行的临时结果，不可缓存） */
  reachable: boolean;
}

let pending: Promise<AuthSession> | null = null;
let settled: AuthSession | null = null;

async function whoFrom(r: Response): Promise<{ username: string | null; role: string | null }> {
  try {
    const d = (await r.json()) as { role?: string; username?: string };
    return { role: d.role ?? null, username: d.username ?? null };
  } catch {
    return { role: null, username: null };
  }
}

export function getAuthSession(): Promise<AuthSession> {
  if (settled) return Promise.resolve(settled);
  if (pending) return pending;
  const fetchOnce = (async (): Promise<AuthSession> => {
      const status = await fetchAuthStatus();
      if (!status) {
        // 服务不可达：离线放行，但不缓存（结果带 reachable=false）
        return { enabled: false, username: null, role: null, pass: true, reachable: false };
      }
      if (!status.enabled) {
        // 关闭认证：仍取一次角色（服务端匿名 admin），供首页/管理后台判定
        try {
          const r = await fetch("/api/v1/auth/verify");
          const who = r.ok ? await whoFrom(r) : { username: null, role: null };
          return { enabled: false, ...who, pass: true, reachable: true };
        } catch {
          return { enabled: false, username: null, role: null, pass: true, reachable: true };
        }
      }
      const token = getToken();
      if (!token) {
        return { enabled: true, username: null, role: null, pass: false, reachable: true };
      }
      try {
        const r = await fetch("/api/v1/auth/verify", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.status === 401) {
          return { enabled: true, username: null, role: null, pass: false, reachable: true };
        }
        const who = r.ok
          ? await whoFrom(r)
          : { username: null, role: null };
        return { enabled: true, ...who, pass: true, reachable: true };
      } catch {
        // verify 网络失败（status 已可达）：离线放行，不缓存
        return { enabled: true, username: null, role: null, pass: true, reachable: false };
      }
    })();
  const chained = fetchOnce.then((s) => {
    if (s.reachable) settled = s;
    else pending = null; // 离线结果不占位：下次调用重新拉
    return s;
  });
  pending = chained;
  return chained;
}

/** 同步窥探已确认的会话（未完成/离线临时结果返回 null）——命中缓存时页面挂载零 spinner 直渲染 */
export function peekAuthSession(): AuthSession | null {
  return settled;
}
