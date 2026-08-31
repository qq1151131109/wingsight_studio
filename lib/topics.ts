"use client";

/** 选题池 API 客户端（经同源代理 /api/v1/topics，与 juben 的 /api/v1 路径约定一致）。 */

import { apiFetch } from "@/lib/auth";

export type TopicVertical = "history" | "crime";
export type TopicStatus = "candidate" | "adopted" | "dismissed" | "archived";

/** 信源底账的一条检索记录（管线全程留痕） */
export interface SourceMapEntry {
  label: string;
  query: string;
  results: { title: string; url: string; snippet: string }[];
}

export interface TopicHeatEvidence {
  title: string;
  platform: string;
  source: string;
  url: string;
  provider?: string;
  fetched_at?: string;
}

export interface TopicResearch {
  evidence_level: "strong" | "thin";
  event?: string;
  why_now?: string;
  material_base?: string;
  competition_gap?: string;
  gaps?: string[];
  /** 观察卡：这条现在为什么不能拍、值得继续盯什么 */
  observation?: string;
  unit_kind?: "person" | "object" | "case" | "era";
  viewing_question?: string;
  scale?: "single" | "series" | "anthology";
  series_thread?: string;
  source_map?: SourceMapEntry[];
}

export interface Topic {
  id: string;
  vertical: TopicVertical;
  source: string;
  title: string;
  summary: string;
  angles: string[];
  heatEvidence: TopicHeatEvidence[];
  research: TopicResearch;
  status: TopicStatus;
  adoptedPid: string | null;
  createdAt: string;
  updatedAt: string;
  lastProgressAt: string;
}

export interface TopicRefreshRun {
  finishedAt?: string;
  collected?: number;
  shortlisted?: number;
  created?: number;
  observed?: number;
  upgraded?: number;
  error?: string;
}

const BASE = "/api/v1/topics";

export interface TopicListResult {
  topics: Topic[];
  refreshing: boolean;
  lastRun: TopicRefreshRun;
}

export async function listTopics(params?: {
  status?: TopicStatus | "all";
  vertical?: TopicVertical;
  q?: string;
}): Promise<TopicListResult> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.vertical) qs.set("vertical", params.vertical);
  if (params?.q?.trim()) qs.set("q", params.q.trim());
  const r = await apiFetch(`${BASE}?${qs.toString()}`);
  if (!r.ok) throw new Error(`读取选题池失败：${r.status}`);
  return r.json();
}

/** 启动策展刷新（后台任务，轮询 listTopics 的 refreshing 字段等完成） */
export async function refreshTopics(): Promise<{ started: boolean } | "conflict" | "unconfigured"> {
  const r = await apiFetch(`${BASE}/refresh`, { method: "POST" });
  if (r.status === 409) return "conflict";
  if (r.status === 503) return "unconfigured";
  if (!r.ok) throw new Error(`启动刷新失败：${r.status}`);
  return r.json();
}

export async function dismissTopic(id: string): Promise<boolean> {
  const r = await apiFetch(`${BASE}/${id}/dismiss`, { method: "POST" });
  return r.ok;
}

/** 认领：建项目 + 选题落画布剧本卡；返回项目 id 供跳转 */
export async function adoptTopic(id: string): Promise<{ pid: string; name: string } | null> {
  const r = await apiFetch(`${BASE}/${id}/adopt`, { method: "POST" });
  if (!r.ok) return null;
  return r.json();
}
