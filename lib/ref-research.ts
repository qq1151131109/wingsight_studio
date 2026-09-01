"use client";

/** 资产参考图调研客户端（豆包搜图 + wikimedia 双渠道，job + 轮询）。 */

import { apiFetch } from "@/lib/auth";

export interface RefCandidate {
  id: string;
  nodeId: string;
  query: string;
  provider: string;
  title: string;
  pageUrl: string;
  sourceDomain: string;
  sourceUrl: string;
  assetUrl: string;
  width: number;
  height: number;
  adopted: boolean;
  /** LLM 终选推荐（适合做生图参考） */
  recommended: boolean;
  recReason: string;
  createdAt: string;
}

export interface RefResearchJob {
  status: "running" | "done" | "error";
  error: string;
  errors: Record<string, string>;
  /** LLM 终选的取舍说明 */
  note: string;
  candidates: RefCandidate[];
}

/** 资产上下文（AI 生成搜索词与终选的判断依据）。 */
export interface RefAsset {
  name: string;
  type: string;
  description: string;
}

export const MAX_ADOPT_PER_NODE = 10;

/** 发起调研：queries 空 = AI 生成搜索词（需 asset.description）；否则手填词首轮直用。 */
export async function startRefResearch(
  projectId: string,
  nodeId: string,
  queries: string[],
  asset?: RefAsset,
): Promise<string> {
  const r = await apiFetch(`/agent-service/projects/${projectId}/refs/research`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId, queries, asset }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(text || `发起调研失败（${r.status}）`);
  }
  const body = (await r.json()) as { jobId: string };
  return body.jobId;
}

export async function getRefResearchJob(
  projectId: string,
  jobId: string,
): Promise<RefResearchJob> {
  const r = await apiFetch(
    `/agent-service/projects/${projectId}/refs/research/${jobId}`,
  );
  if (r.status === 404) throw new Error("调研任务不存在（agent 可能已重启）");
  if (!r.ok) throw new Error(`调研任务查询失败（${r.status}）`);
  return (await r.json()) as RefResearchJob;
}

/** 发起 + 轮询到终态（2s 间隔 / 300s 截止；AI 模式含规划+补搜+终选，分钟级）。 */
export async function runRefResearch(
  projectId: string,
  nodeId: string,
  queries: string[],
  asset?: RefAsset,
): Promise<RefResearchJob> {
  const jobId = await startRefResearch(projectId, nodeId, queries, asset);
  const deadline = Date.now() + 300_000;
  for (;;) {
    await new Promise((res) => setTimeout(res, 2000));
    const job = await getRefResearchJob(projectId, jobId);
    if (job.status !== "running") return job;
    if (Date.now() > deadline) throw new Error("调研超时（候选下载可能较慢），稍后可在面板重开查看");
  }
}

export async function listRefCandidates(
  projectId: string,
  nodeId: string,
): Promise<RefCandidate[]> {
  const r = await apiFetch(
    `/agent-service/projects/${projectId}/refs/candidates?nodeId=${encodeURIComponent(nodeId)}`,
  );
  if (!r.ok) throw new Error(`候选列表加载失败（${r.status}）`);
  return (await r.json()) as RefCandidate[];
}

export async function adoptRefCandidates(
  projectId: string,
  nodeId: string,
  ids: string[],
): Promise<RefCandidate[]> {
  const r = await apiFetch(`/agent-service/projects/${projectId}/refs/adopt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId, ids }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(text || `采纳失败（${r.status}）`);
  }
  const body = (await r.json()) as { candidates: RefCandidate[] };
  return body.candidates;
}

export async function deleteRefCandidate(
  projectId: string,
  id: string,
): Promise<void> {
  const r = await apiFetch(
    `/agent-service/projects/${projectId}/refs/candidates/${id}`,
    { method: "DELETE" },
  );
  if (!r.ok) throw new Error(`删除失败（${r.status}）`);
}
