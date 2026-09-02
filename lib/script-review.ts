"use client";

/** 剧本审查客户端（引擎在 agent/script_review.py；job 轮询直读 DB）。 */

import { apiFetch } from "@/lib/auth";

/** 审查维度（与 agent 端 DIMENSIONS 对齐） */
export const REVIEW_DIMENSIONS = ["compliance", "consistency", "fact"] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

export const REVIEW_DIMENSION_LABEL: Record<ReviewDimension, string> = {
  compliance: "合规",
  consistency: "一致性",
  fact: "事实核查",
};

export const REVIEW_DIMENSION_DESC: Record<ReviewDimension, string> = {
  compliance: "敏感内容与平台规则风险（敏感词表底料 + 语境判定）",
  consistency: "人物/时间线/设定的内部矛盾",
  fact: "现实事实断言联网核查（Serper 搜索）",
};

export type ReviewStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "interrupted"
  | "stopped";

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  queued: "排队中",
  running: "审查中",
  done: "已完成",
  error: "失败",
  interrupted: "已中断",
  stopped: "已取消",
};

export const REVIEW_SEVERITY_LABEL: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export interface ReviewEvidence {
  sid: string;
  url: string;
  title: string;
}

export interface ReviewFinding {
  id: string;
  jobId: string;
  dimension: ReviewDimension;
  severity: "high" | "medium" | "low";
  category: string;
  /** 原文摘录（定位锚） */
  quote: string;
  /** 正文字符区间；-1 表示未能定位（只展示引文不高亮） */
  quoteStart: number;
  quoteEnd: number;
  /** 一致性维度的矛盾 B 处引文 */
  relatedQuote: string;
  message: string;
  suggestion: string;
  evidence: ReviewEvidence[];
  dismissed: boolean;
  createdAt: string;
}

export interface ReviewDimState {
  state: "pending" | "running" | "done" | "error";
  error: string;
}

export interface ReviewJob {
  jobId: string;
  projectId: string;
  nodeId: string;
  cardTitle: string;
  dimensions: ReviewDimension[];
  status: ReviewStatus;
  dims: Record<string, ReviewDimState>;
  bodySha1: string;
  bodyChars: number;
  textModel: string;
  error: string;
  log: { t: string; kind: string; text: string }[];
  createdAt: string;
  updatedAt: string;
  findings?: ReviewFinding[];
  openCount?: number;
}

export interface ReviewJobSummary {
  jobId: string;
  nodeId: string;
  status: ReviewStatus;
  bodySha1: string;
  bodyChars: number;
  totalCount: number;
  openCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function startScriptReview(
  projectId: string,
  input: {
    nodeId: string;
    title: string;
    body: string;
    dimensions: ReviewDimension[];
    textModel?: string;
  },
): Promise<ReviewJob> {
  const res = await apiFetch(`/agent-service/projects/${projectId}/script-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.text()) || `发起审查失败（${res.status}）`);
  return res.json();
}

export async function getScriptReview(
  projectId: string,
  jobId: string,
): Promise<ReviewJob> {
  const res = await apiFetch(`/agent-service/projects/${projectId}/script-review/${jobId}`);
  if (!res.ok) throw new Error((await res.text()) || `审查查询失败（${res.status}）`);
  return res.json();
}

export async function getLatestScriptReview(
  projectId: string,
  nodeId: string,
): Promise<ReviewJobSummary> {
  const res = await apiFetch(
    `/agent-service/projects/${projectId}/script-review?nodeId=${encodeURIComponent(nodeId)}`,
  );
  if (!res.ok) throw new Error((await res.text()) || `审查摘要查询失败（${res.status}）`);
  return res.json();
}

/**
 * 卡面角标用的摘要缓存：剧本卡开了 onlyRenderVisibleElements，平移画布会
 * 反复卸载/重挂载，每卡挂载直拉一次就是请求雨——TTL + in-flight 去重，
 * 任务收尾/弹窗关闭用 force=true 穿透。404（从未审查）也按 null 缓存。
 */
const SUMMARY_TTL_MS = 10_000;
const summaryCache = new Map<string, { at: number; promise: Promise<ReviewJobSummary | null> }>();

export function getLatestScriptReviewCached(
  projectId: string,
  nodeId: string,
  force = false,
): Promise<ReviewJobSummary | null> {
  const key = `${projectId}:${nodeId}`;
  const hit = summaryCache.get(key);
  if (hit && !force && Date.now() - hit.at < SUMMARY_TTL_MS) return hit.promise;
  const promise = getLatestScriptReview(projectId, nodeId).then(
    (s) => s,
    () => null,
  );
  summaryCache.set(key, { at: Date.now(), promise });
  return promise;
}

export async function dismissScriptReviewFinding(
  projectId: string,
  jobId: string,
  findingId: string,
  dismissed: boolean,
): Promise<ReviewFinding> {
  const res = await apiFetch(
    `/agent-service/projects/${projectId}/script-review/${jobId}/findings/${findingId}/dismiss`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismissed }),
    },
  );
  if (!res.ok) throw new Error((await res.text()) || `更新失败（${res.status}）`);
  return res.json();
}

export async function cancelScriptReview(
  projectId: string,
  jobId: string,
): Promise<void> {
  const res = await apiFetch(
    `/agent-service/projects/${projectId}/script-review/${jobId}/cancel`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error((await res.text()) || `取消失败（${res.status}）`);
}

/** 终态判定（轮询用） */
export function isReviewTerminal(status: ReviewStatus): boolean {
  return status !== "queued" && status !== "running";
}
