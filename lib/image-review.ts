"use client";

/** AI 艺术评审客户端（引擎在 agent/image_review.py；job 轮询直读 DB）。 */

import { apiFetch } from "@/lib/auth";

/** 评审维度（与 agent 端 DIMENSIONS 对齐；四维一次评完无勾选） */
export const ART_DIMENSIONS = ["composition", "color", "lighting", "proportion"] as const;
export type ArtDimension = (typeof ART_DIMENSIONS)[number];

export const ART_DIMENSION_LABEL: Record<ArtDimension, string> = {
  composition: "构图与视觉层级",
  color: "色彩",
  lighting: "光线",
  proportion: "比例结构与透视",
};

export type ArtReviewStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "interrupted"
  | "stopped";

export const ART_REVIEW_SEVERITY_LABEL: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export interface ArtReviewFinding {
  id: string;
  jobId: string;
  dimension: ArtDimension;
  severity: "high" | "medium" | "low";
  title: string;
  /** 画面位置描述（如：画面左上角/人物右手） */
  quote: string;
  detail: string;
  suggestion: string;
  dismissed: boolean;
  createdAt: string;
}

export interface ArtReviewJob {
  jobId: string;
  projectId: string;
  nodeId: string;
  cardTitle: string;
  imageUrl: string;
  status: ArtReviewStatus;
  dims: Record<string, { state: string; error: string; open: number }>;
  model: string;
  error: string;
  log: { t: string; kind: string; text: string }[];
  createdAt: string;
  updatedAt: string;
  findings?: ArtReviewFinding[];
  openCount?: number;
  totalCount?: number;
}

export async function startArtReview(
  projectId: string,
  input: { nodeId: string; title: string; imageUrl: string },
): Promise<ArtReviewJob> {
  const res = await apiFetch(`/agent-service/projects/${projectId}/image-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.text()) || `发起评审失败（${res.status}）`);
  return res.json();
}

export async function getArtReview(
  projectId: string,
  jobId: string,
): Promise<ArtReviewJob> {
  const res = await apiFetch(`/agent-service/projects/${projectId}/image-review/${jobId}`);
  if (!res.ok) throw new Error((await res.text()) || `评审查询失败（${res.status}）`);
  return res.json();
}

export async function dismissArtReviewFinding(
  projectId: string,
  jobId: string,
  findingId: string,
  dismissed: boolean,
): Promise<ArtReviewFinding> {
  const res = await apiFetch(
    `/agent-service/projects/${projectId}/image-review/${jobId}/findings/${findingId}/dismiss`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismissed }),
    },
  );
  if (!res.ok) throw new Error((await res.text()) || `更新失败（${res.status}）`);
  return res.json();
}

export async function cancelArtReview(projectId: string, jobId: string): Promise<void> {
  const res = await apiFetch(
    `/agent-service/projects/${projectId}/image-review/${jobId}/cancel`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error((await res.text()) || `取消失败（${res.status}）`);
}

/** 终态判定（轮询用） */
export function isArtReviewTerminal(status: ArtReviewStatus): boolean {
  return status !== "queued" && status !== "running";
}
