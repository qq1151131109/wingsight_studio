"use client";

/** 项目 API 客户端（经同源代理 /agent-service/projects）。 */

import { apiFetch } from "@/lib/auth";

export interface ProjectMeta {
  id: string;
  name: string;
  updated_at: string;
  /** 归属与协作者（多人模式下由后端返回） */
  owner_id?: string;
  collaborators?: string[];
}

const BASE = "/agent-service/projects";

export async function listProjects(): Promise<ProjectMeta[]> {
  const r = await apiFetch(BASE);
  if (!r.ok) throw new Error(`列出项目失败：${r.status}`);
  return r.json();
}

export async function createProject(name: string): Promise<ProjectMeta> {
  const r = await apiFetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`新建项目失败：${r.status}`);
  return r.json();
}

export async function renameProject(pid: string, name: string): Promise<boolean> {
  const r = await apiFetch(`${BASE}/${pid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return r.ok;
}

export async function deleteProject(pid: string): Promise<boolean> {
  const r = await apiFetch(`${BASE}/${pid}`, { method: "DELETE" });
  return r.ok;
}

export async function loadCanvas(
  pid: string,
): Promise<{ nodes: unknown[]; edges: unknown[]; viewport: unknown } | null> {
  const r = await apiFetch(`${BASE}/${pid}/canvas`);
  if (r.status === 404) return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  if (!r.ok) throw new Error(`读取画布失败：${r.status}`);
  return r.json();
}

export async function saveCanvas(
  pid: string,
  state: { nodes: unknown[]; edges: unknown[]; viewport: unknown },
): Promise<boolean> {
  const r = await apiFetch(`${BASE}/${pid}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  return r.ok;
}

/** 上传媒体/文档附件（粘贴/拖拽/选择共用），返回同源可访问的 URL；失败返回 null。
 *  name 传原始文件名：文档类 mime 认不出时服务端靠它推断扩展名。 */
export async function uploadAsset(
  file: Blob,
  contentType?: string,
  name?: string,
): Promise<string | null> {
  const buf = await file.arrayBuffer();
  const qs = name ? `?name=${encodeURIComponent(name)}` : "";
  const r = await apiFetch(`/agent-service/assets${qs}`, {
    method: "POST",
    headers: { "Content-Type": contentType || file.type || "image/png" },
    body: buf,
  });
  if (!r.ok) return null;
  const { url } = (await r.json()) as { url: string };
  return url;
}

// ---------- 聊天历史（与画布同为服务端事实源；只存 user/assistant 文本） ----------

export interface ChatMessageRecord {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
}

export async function loadChatHistory(
  pid: string,
): Promise<ChatMessageRecord[]> {
  const r = await apiFetch(`${BASE}/${pid}/messages`);
  if (!r.ok) throw new Error(`读取聊天历史失败：${r.status}`);
  return r.json();
}

export async function saveChatHistory(
  pid: string,
  messages: ChatMessageRecord[],
): Promise<boolean> {
  const r = await apiFetch(`${BASE}/${pid}/messages`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  return r.ok;
}
