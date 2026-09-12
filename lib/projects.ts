"use client";

/** 项目 API 客户端（经同源代理 /agent-service/projects）。 */

import { apiFetch } from "@/lib/auth";
import { showToast } from "@/lib/toast";

export interface ProjectMeta {
  id: string;
  name: string;
  updated_at: string;
  /** 归属与协作者（多人模式下由后端返回） */
  owner_id?: string;
  /** owner 用户名（后端批量回填；历史遗留归属如 default 原样透出） */
  ownerName?: string;
  collaborators?: string[];
  /** 协作用户名（与 collaborators 的 id 一一对应，已剔除查不到的账号） */
  collaboratorNames?: string[];
  /** 是否可执行重命名/删除等生命周期操作（owner/admin）；协作者为 false */
  canManage?: boolean;
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
  meta?: {
    visualStyle?: string;
    factuality?: "real" | "fiction";
    era?: string;
    dismissedReports?: string[];
    dismissedTopicRefs?: string[];
  };
  /** 服务端乐观锁版本（成功保存 +1；保存时原样带回做 CAS） */
  revision?: number;
} | null> {
  const r = await apiFetch(`${BASE}/${pid}/canvas`);
  if (r.status === 404) return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  if (!r.ok) throw new Error(`读取画布失败：${r.status}`);
  return r.json();
}

/** 保存画布。带 revision 时服务端做乐观锁（CAS）：版本不一致返回
 *  {ok:false, conflict:true}——另一窗口/agent 先写过，调用方应拉最新
 *  状态合并后重试，不再无版本检查地整包覆盖（双开页面旧快照踩掉新出图
 *  结果的萧燕燕事故）。revision 缺省 = 无版本覆盖（旧语义，仅迁移路径用） */
export async function saveCanvas(
  pid: string,
  state: {
    nodes: unknown[];
    edges: unknown[];
    viewport: unknown;
    meta?: {
      visualStyle?: string;
      factuality?: "real" | "fiction";
      era?: string;
      dismissedReports?: string[];
      dismissedTopicRefs?: string[];
    };
  },
  revision?: number,
): Promise<{ ok: boolean; revision?: number; conflict?: boolean }> {
  const r = await apiFetch(`${BASE}/${pid}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      revision != null ? { ...state, revision } : state,
    ),
  });
  if (r.status === 409) {
    const body = (await r.json().catch(() => null)) as {
      revision?: number;
    } | null;
    return { ok: false, conflict: true, revision: body?.revision };
  }
  if (!r.ok) return { ok: false };
  const data = (await r.json().catch(() => null)) as {
    ok?: boolean;
    revision?: number;
  } | null;
  return { ok: data?.ok !== false, revision: data?.revision };
}

/** 上传媒体/文档附件（粘贴/拖拽/选择共用），返回同源可访问的 URL；失败返回 null
 *  并经全局 toast 明报原因（历史上静默返回 null，拖拽导入直接跳过文件，
 *  用户视角就是"拖了没反应"——大图上传挂死的事故因此长期看不出原因）。
 *  name 传原始文件名：文档类 mime 认不出时服务端靠它推断扩展名。 */
export async function uploadAsset(
  file: Blob,
  contentType?: string,
  name?: string,
): Promise<string | null> {
  const buf = await file.arrayBuffer();
  const qs = name ? `?name=${encodeURIComponent(name)}` : "";
  let r: Response;
  try {
    r = await apiFetch(`/agent-service/assets${qs}`, {
      method: "POST",
      headers: { "Content-Type": contentType || file.type || "image/png" },
      body: buf,
    });
  } catch {
    showToast("网络中断，上传失败，请重试");
    return null;
  }
  if (r.status === 413) {
    const kind = (contentType || file.type || "").startsWith("video/")
      ? "视频"
      : (contentType || file.type || "").startsWith("image/")
        ? "图片"
        : "文档";
    showToast(
      `${kind}超过大小上限（${kind === "视频" ? 200 : kind === "图片" ? 50 : 20}MB），请压缩后重试`,
    );
    return null;
  }
  if (!r.ok) {
    showToast(`上传失败（HTTP ${r.status}）`);
    return null;
  }
  const { url } = (await r.json()) as { url: string };
  return url;
}

/** 二进制文档（doc/docx/rtf/pdf）服务端文本提取：成功 {ok:true,text}；
 *  失败 {ok:false,error}（中文原因：扫描件/加密/损坏/超限——浏览器读不了
 *  这些格式，只有服务端 soffice/pdftotext/zip 直解能转，失败明报不静默） */
export async function extractText(
  file: Blob,
  name?: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const buf = await file.arrayBuffer();
  const qs = name ? `?name=${encodeURIComponent(name)}` : "";
  let r: Response;
  try {
    r = await apiFetch(`/agent-service/extract-text${qs}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: buf,
    });
  } catch {
    return { ok: false, error: "网络中断，提取失败，请重试" };
  }
  if (r.ok) {
    const { text } = (await r.json()) as { text: string };
    return { ok: true, text };
  }
  const reason = (await r.text().catch(() => "")).slice(0, 120);
  return { ok: false, error: reason || `提取失败（HTTP ${r.status}）` };
}

// ---------- 聊天会话（多会话：threads；与画布同为服务端事实源） ----------

export interface ChatThreadMeta {
  id: string;
  title: string;
  updated_at: string;
  message_count: number;
  /** 标题仍是机械产物（首条消息截断/附件名，等待 LLM 智能命名升级）——
   *  页签据此在升级落库后及时重拉回显 */
  title_mechanical?: boolean;
}

export interface ChatMessageRecord {
  id: string;
  /** reasoning = 思考行（2026-09-12 起随会话落库回放，对齐 codex rollout） */
  role: "user" | "assistant" | "reasoning";
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
  /** 客户端指定 id：与 agent 侧 langgraph thread 同 id（会话记忆 ↔ UI 会话对齐） */
  id?: string,
): Promise<ChatThreadMeta> {
  const r = await apiFetch(`${BASE}/${pid}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, ...(id ? { id } : {}) }),
  });
  if (!r.ok) throw new Error(`新建会话失败：${r.status}`);
  return r.json();
}

/** 取消会话在途的后端工具（出图/拆解/技能调用）——「停止」「切会话」透传。
 *  尽力而为：失败静默（后端可能已结束/服务离线）。 */
export async function cancelChatRun(threadId: string | null | undefined): Promise<void> {
  if (!threadId) return;
  try {
    await apiFetch(`/agent-service/chat/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId }),
    });
  } catch {
    /* 静默 */
  }
}

/** 任务面板：逐任务取消 */
export async function cancelChatJob(threadId: string, jobId: string): Promise<void> {
  try {
    await apiFetch(`/agent-service/chat/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, jobId }),
    });
  } catch {
    /* 静默 */
  }
}

/** 重新生成的服务端分叉：把 messageId 之前的 checkpoint 变成会话当前头。
 *  必须在客户端截断历史 + 重跑之前调用（否则旧回答仍留在模型上下文里）。
 *
 *  turnMessages = 这次会被放弃的那一版助手消息。前端手上有实时内容，直接传；
 *  服务端会连「当前头的 checkpoint」一起存档成可切回的版本（见分支切换）。 */
export async function regenerateChatRun(
  threadId: string,
  messageId: string,
  turnMessages?: { id?: string; role?: string; content?: string }[],
): Promise<boolean> {
  try {
    const r = await apiFetch(`/agent-service/chat/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, messageId, turnMessages: turnMessages ?? [] }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** 一轮的某个版本（‹ i/N › 用） */
export type ChatBranchVersion = {
  idx: number;
  active: boolean;
  messages: { id?: string; role?: string; content?: string }[];
};

/** 该会话里有多版本的轮次清单（单版轮不返回——不需要切换器） */
export async function loadChatBranches(
  threadId: string,
): Promise<{ turnId: string; versions: ChatBranchVersion[] }[]> {
  try {
    const r = await apiFetch(
      `/agent-service/chat/branches?threadId=${encodeURIComponent(threadId)}`,
    );
    if (!r.ok) return [];
    const data = (await r.json()) as {
      turns?: { turnId: string; versions: ChatBranchVersion[] }[];
    };
    return Array.isArray(data.turns) ? data.turns : [];
  } catch {
    return [];
  }
}

/** 切到某个历史版本：服务端把会话头挪到那一版（显示与模型上下文一起切），
 *  返回该版本的助手消息供直接上屏；失败返回 null（调用方明报，不静默）。 */
export async function switchChatBranch(
  threadId: string,
  turnId: string,
  idx: number,
  turnMessages?: { id?: string; role?: string; content?: string }[],
): Promise<{ id?: string; role?: string; content?: string }[] | null> {
  try {
    const r = await apiFetch(`/agent-service/chat/branch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, turnId, idx, turnMessages: turnMessages ?? [] }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      messages?: { id?: string; role?: string; content?: string }[];
    };
    return Array.isArray(data.messages) ? data.messages : null;
  } catch {
    return null;
  }
}

export interface ChatJob {
  jobId: string;
  kind: "imagegen" | "tool" | string;
  title: string;
  done: number;
  /** 0 = 进度不可数（单流任务） */
  total: number;
  cancelled: boolean;
}

/** 会话在途长任务清单（任务面板轮询用）；失败静默返回空 */
export async function listChatJobs(threadId: string): Promise<ChatJob[]> {
  try {
    const r = await apiFetch(
      `/agent-service/chat/jobs?threadId=${encodeURIComponent(threadId)}`,
    );
    if (!r.ok) return [];
    return r.json();
  } catch {
    return [];
  }
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

/** 读会话消息。404（会话不存在于该项目：跨项目残留选择/已被删）返回 null，
 *  由调用方自愈重新选会话；其他失败照常 throw。 */
export async function loadChatMessages(
  pid: string,
  tid: string,
): Promise<ChatMessageRecord[] | null> {
  const r = await apiFetch(`${BASE}/${pid}/threads/${tid}/messages`);
  if (r.status === 404) return null;
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
