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
  /** 跟拍谁：具名人物或明确可跟拍群体（爆款选题尺子一） */
  person_anchor?: string;
  /** 情绪钩子：观众为什么在意（爆款选题尺子二） */
  emotion?: string;
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
  lastRescanAt: string | null;
}

export interface TopicRefreshRun {
  finishedAt?: string;
  collected?: number;
  shortlisted?: number;
  created?: number;
  observed?: number;
  upgraded?: number;
  /** 刷新尾部顺带轮转复查观察卡的产出 */
  rescanned?: number;
  rescanUpgraded?: number;
  error?: string;
}

/** 手动深挖（单卡复查）异步任务 */
export interface TopicRescanJob {
  jobId: string;
  topicId: string;
  status: "running" | "done" | "error";
  /** done 时：upgraded（升级建议卡）/ thin（仍薄，取证记入信源底账）/ failed（结论生成失败，已记扫描） */
  outcome?: string;
  error?: string;
}

/** 每日自动刷新调度（进程内 asyncio，存 app_settings） */
export interface AutoRefreshSchedule {
  enabled: boolean;
  time: string;
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

/** 手动深挖一张观察卡（后台复查：缺口导向取证 → 证据变硬自动升级）；返回 jobId 轮询用 */
export async function startRescan(id: string): Promise<string> {
  const r = await apiFetch(`${BASE}/${id}/rescan`, { method: "POST" });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(text || `启动深挖失败：${r.status}`);
  }
  const data = await r.json();
  return data.jobId as string;
}

export async function getRescanJob(jobId: string): Promise<TopicRescanJob> {
  const r = await apiFetch(`${BASE}/rescan/${jobId}`);
  if (!r.ok) throw new Error(`读取复查任务失败：${r.status}`);
  const data = await r.json();
  return data.job as TopicRescanJob;
}

export async function getSchedule(): Promise<{ schedule: AutoRefreshSchedule; lastAutoRunDate: string }> {
  const r = await apiFetch(`${BASE}/schedule`);
  if (!r.ok) throw new Error(`读取自动刷新设置失败：${r.status}`);
  return r.json();
}

export async function setSchedule(schedule: AutoRefreshSchedule): Promise<AutoRefreshSchedule> {
  const r = await apiFetch(`${BASE}/schedule`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(schedule),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(text || `保存自动刷新设置失败：${r.status}`);
  }
  const data = await r.json();
  return data.schedule as AutoRefreshSchedule;
}
