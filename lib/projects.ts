"use client";

/** 项目 API 客户端（经同源代理 /agent-service/projects）。 */

import { apiFetch } from "@/lib/auth";

export interface ProjectMeta {
  id: string;
  name: string;
  updated_at: string;
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

/** 上传图片资产（粘贴/拖拽导入共用），返回同源可访问的图片 URL；失败返回 null */
export async function uploadAsset(
  file: Blob,
  contentType?: string,
): Promise<string | null> {
  const buf = await file.arrayBuffer();
  const r = await apiFetch("/agent-service/assets", {
    method: "POST",
    headers: { "Content-Type": contentType || file.type || "image/png" },
    body: buf,
  });
  if (!r.ok) return null;
  const { url } = (await r.json()) as { url: string };
  return url;
}
