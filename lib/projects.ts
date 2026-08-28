"use client";

/** 项目 API 客户端（经同源代理 /agent-service/projects）。 */

export interface ProjectMeta {
  id: string;
  name: string;
  updated_at: string;
}

const BASE = "/agent-service/projects";

export async function listProjects(): Promise<ProjectMeta[]> {
  const r = await fetch(BASE);
  if (!r.ok) throw new Error(`列出项目失败：${r.status}`);
  return r.json();
}

export async function createProject(name: string): Promise<ProjectMeta> {
  const r = await fetch(BASE, {
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
  const r = await fetch(`${BASE}/${pid}/canvas`);
  if (r.status === 404) return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  if (!r.ok) throw new Error(`读取画布失败：${r.status}`);
  return r.json();
}

export async function saveCanvas(
  pid: string,
  state: { nodes: unknown[]; edges: unknown[]; viewport: unknown },
): Promise<boolean> {
  const r = await fetch(`${BASE}/${pid}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  return r.ok;
}
