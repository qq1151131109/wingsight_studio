"use client";

/** 实体库 API 客户端（经同源代理 /api/v1/entities）。 */

import { apiFetch } from "@/lib/auth";
import type { Topic } from "@/lib/topics";

export type EntityKind = "person" | "object" | "case" | "era" | "place";

export const ENTITY_KIND_LABEL: Record<string, string> = {
  person: "人物",
  object: "物",
  case: "案件",
  era: "年代",
  place: "地点",
};

export const ENTITY_KIND_COLOR: Record<string, string> = {
  person: "var(--color-warm)",
  object: "var(--color-cool)",
  case: "var(--color-danger)",
  era: "var(--color-accent)",
  place: "var(--color-good)",
};

/** 实体证据底账的一条（信源标题+链接，来自采集信号） */
export interface EntityEvidence {
  title: string;
  url: string;
}

export interface EntityItem {
  id: string;
  kind: EntityKind;
  name: string;
  summary: string;
  aliases: string[];
  evidence: EntityEvidence[];
  topicCount?: number | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export async function listEntities(params?: {
  kind?: EntityKind;
  q?: string;
}): Promise<EntityItem[]> {
  const qs = new URLSearchParams();
  if (params?.kind) qs.set("kind", params.kind);
  if (params?.q?.trim()) qs.set("q", params.q.trim());
  const r = await apiFetch(`/api/v1/entities?${qs.toString()}`);
  if (!r.ok) throw new Error(`读取实体库失败：${r.status}`);
  const data = await r.json();
  return data.entities as EntityItem[];
}

export async function getEntity(
  id: string,
): Promise<{ entity: EntityItem; topics: Topic[] }> {
  const r = await apiFetch(`/api/v1/entities/${id}`);
  if (!r.ok) throw new Error(`读取实体失败：${r.status}`);
  return r.json();
}
