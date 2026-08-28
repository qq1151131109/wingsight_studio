"use client";

/** 平台管理 API 封装（用户管理 / API Key / 协作者 / 用户检索）。 */

import { apiFetch } from "@/lib/auth";

const V1 = "/api/v1";

export interface AdminUser {
  id: string;
  username: string;
  role: "admin" | "member";
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyMeta {
  id: number;
  name: string;
  key_prefix: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

export interface ApiKeyCreated extends ApiKeyMeta {
  key: string; // 完整 key，仅创建时返回一次
}

export interface VerifyInfo {
  valid: boolean;
  username: string;
  role: string;
  id: string | null;
}

export async function fetchVerify(): Promise<VerifyInfo | null> {
  try {
    const r = await apiFetch(`${V1}/auth/verify`);
    if (!r.ok) return null;
    return (await r.json()) as VerifyInfo;
  } catch {
    return null;
  }
}

// ---------- 用户管理（admin） ----------

export async function listAdminUsers(): Promise<AdminUser[]> {
  const r = await apiFetch(`${V1}/admin/users`);
  if (!r.ok) throw new Error(`读取用户失败：${r.status}`);
  const { users } = (await r.json()) as { users: AdminUser[] };
  return users;
}

export async function createAdminUser(
  username: string,
  password: string,
  role: "admin" | "member",
): Promise<AdminUser> {
  const r = await apiFetch(`${V1}/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, role }),
  });
  if (!r.ok) {
    const d = (await r.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(d?.detail === "用户名已存在" ? "用户名已存在" : `创建失败（${r.status}）`);
  }
  const { user } = (await r.json()) as { user: AdminUser };
  return user;
}

export async function patchAdminUser(
  uid: string,
  patch: { role?: "admin" | "member"; is_active?: boolean; password?: string },
): Promise<AdminUser> {
  const r = await apiFetch(`${V1}/admin/users/${uid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const d = (await r.json().catch(() => null)) as { detail?: string } | null;
    const reasons: Record<string, string> = {
      cannot_disable_self: "不能停用自己",
      cannot_demote_last_admin: "不能降级最后一个管理员",
      user_not_found: "用户不存在",
    };
    throw new Error(reasons[d?.detail ?? ""] ?? `更新失败（${r.status}）`);
  }
  const { user } = (await r.json()) as { user: AdminUser };
  return user;
}

/** 轻量用户检索（协作者选择器） */
export async function searchUsers(q: string): Promise<{ id: string; username: string }[]> {
  const r = await apiFetch(`${V1}/users${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  if (!r.ok) return [];
  const { users } = (await r.json()) as { users: { id: string; username: string }[] };
  return users;
}

// ---------- API Key ----------

export async function listApiKeys(): Promise<ApiKeyMeta[]> {
  const r = await apiFetch(`${V1}/api-keys`);
  if (!r.ok) throw new Error(`读取 API Key 失败：${r.status}`);
  return (await r.json()) as ApiKeyMeta[];
}

export async function createApiKey(
  name: string,
  expiresDays: number | null,
): Promise<ApiKeyCreated> {
  const r = await apiFetch(`${V1}/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, expires_days: expiresDays ?? 0 }),
  });
  if (!r.ok) throw new Error(`创建失败（${r.status}）`);
  return (await r.json()) as ApiKeyCreated;
}

export async function deleteApiKey(id: number): Promise<void> {
  const r = await apiFetch(`${V1}/api-keys/${id}`, { method: "DELETE" });
  if (!r.ok && r.status !== 204) throw new Error(`删除失败（${r.status}）`);
}

// ---------- 协作者 ----------

export async function listCollaborators(pid: string): Promise<string[]> {
  const r = await apiFetch(`/agent-service/projects/${pid}/collaborators`);
  if (!r.ok) throw new Error(`读取协作者失败：${r.status}`);
  const { collaborators } = (await r.json()) as { collaborators: string[] };
  return collaborators;
}

export async function addCollaborator(pid: string, username: string): Promise<string[]> {
  const r = await apiFetch(`/agent-service/projects/${pid}/collaborators`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!r.ok) throw new Error(`添加失败（${r.status}）`);
  return (await r.json()).collaborators;
}

export async function removeCollaborator(pid: string, username: string): Promise<string[]> {
  const r = await apiFetch(
    `/agent-service/projects/${pid}/collaborators/${encodeURIComponent(username)}`,
    { method: "DELETE" },
  );
  if (!r.ok) throw new Error(`移除失败（${r.status}）`);
  return (await r.json()).collaborators;
}
