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
): Promise<{
  nodes: unknown[];
  edges: unknown[];
  viewport: unknown;
  meta?: { visualStyle?: string };
  revision?: number;
} | null> {
  const r = await apiFetch(`${BASE}/${pid}/canvas`);
  if (r.status === 404) return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  if (!r.ok) throw new Error(`读取画布失败：${r.status}`);
  return r.json();
}

export async function saveCanvas(
  pid: string,
  state: {
    nodes: unknown[];
    edges: unknown[];
    viewport: unknown;
    meta?: { visualStyle?: string };
    /** 乐观锁：服务端 revision 不一致返回 conflict；0/缺省=不过检 */
    revision?: number;
    /** 用户显式覆盖服务器版本（跳过乐观锁） */
    force?: boolean;
  },
): Promise<{ ok: boolean; conflict: boolean; revision?: number }> {
  const r = await apiFetch(`${BASE}/${pid}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (r.status === 409) {
    const body = (await r.json().catch(() => null)) as { revision?: number } | null;
    return { ok: false, conflict: true, revision: body?.revision };
  }
  if (!r.ok) return { ok: false, conflict: false };
  const data = (await r.json().catch(() => null)) as { ok?: boolean; revision?: number } | null;
  return { ok: Boolean(data?.ok), conflict: false, revision: data?.revision };
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

// ---------- 聊天会话（多会话：threads；与画布同为服务端事实源） ----------

export interface ChatThreadMeta {
  id: string;
  title: string;
  updated_at: string;
  message_count: number;
}

export interface ChatMessageRecord {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
}

export async function listChatThreads(pid: string): Promise<ChatThreadMeta[]> {
  const r = await apiFetch(`${BASE}/${pid}/threads`);
  if (!r.ok) throw new Error(`读取会话列表失败：${r.status}`);
  return r.json();
}

export async function createChatThread(
  pid: string,
  title = "",
): Promise<ChatThreadMeta> {
  const r = await apiFetch(`${BASE}/${pid}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!r.ok) throw new Error(`新建会话失败：${r.status}`);
  return r.json();
}

export async function renameChatThread(
  pid: string,
  tid: string,
  title: string,
): Promise<boolean> {
  const r = await apiFetch(`${BASE}/${pid}/threads/${tid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return r.ok;
}

export async function deleteChatThread(
  pid: string,
  tid: string,
): Promise<boolean> {
  const r = await apiFetch(`${BASE}/${pid}/threads/${tid}`, {
    method: "DELETE",
  });
  return r.ok;
}

export async function loadChatMessages(
  pid: string,
  tid: string,
): Promise<ChatMessageRecord[]> {
  const r = await apiFetch(`${BASE}/${pid}/threads/${tid}/messages`);
  if (!r.ok) throw new Error(`读取会话消息失败：${r.status}`);
  return r.json();
}

export async function saveChatMessages(
  pid: string,
  tid: string,
  messages: ChatMessageRecord[],
): Promise<boolean> {
  const r = await apiFetch(`${BASE}/${pid}/threads/${tid}/messages`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  return r.ok;
}

// ---------- 素材库（生成历史自动入库 + 手动收藏；按项目隔离） ----------

export type AssetKind = "image" | "video" | "audio";

export interface AssetRecord {
  id: string;
  kind: AssetKind;
  title: string;
  url: string;
  source: "generation" | "upload";
  created_at: string;
}

export async function listAssets(pid: string): Promise<AssetRecord[]> {
  const r = await apiFetch(`${BASE}/${pid}/assets`);
  if (!r.ok) throw new Error(`读取素材库失败：${r.status}`);
  return r.json();
}

/** 入库（url 同项目内去重，幂等）；失败静默返回 null（自动入库不打扰用户） */
export async function saveAsset(
  pid: string,
  asset: {
    kind: AssetKind;
    title: string;
    url: string;
    source?: "generation" | "upload";
  },
): Promise<AssetRecord | null> {
  try {
    const r = await apiFetch(`${BASE}/${pid}/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(asset),
    });
    return r.ok ? ((await r.json()) as AssetRecord) : null;
  } catch {
    return null;
  }
}

export async function deleteAsset(pid: string, aid: string): Promise<boolean> {
  const r = await apiFetch(`${BASE}/${pid}/assets/${aid}`, { method: "DELETE" });
  return r.ok;
}

// ---------- 视频合成（ffmpeg 拼接；compose 卡按钮直连，不绕聊天） ----------

export async function composeVideos(
  pid: string,
  urls: string[],
): Promise<{ url: string } | null> {
  try {
    const r = await apiFetch(`${BASE}/${pid}/compose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    if (!r.ok) return null;
    return (await r.json()) as { url: string };
  } catch {
    return null;
  }
}
