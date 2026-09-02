"use client";

/** 深度调研客户端（引擎在 agent/research.py；job 轮询直读 DB）。 */

import { apiFetch } from "@/lib/auth";

/** 来源分类学（与 agent 端 SOURCE_CATEGORIES 对齐） */
export const SOURCE_CATEGORIES = [
  "一手史料",
  "学术",
  "可靠媒体",
  "自媒体",
  "百科辞书",
  "其他",
] as const;

export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

export interface ResearchPlan {
  viewingQuestion: string;
  directions: { title: string; goal: string; queries: string[] }[];
  risks?: string[];
}

export interface DossierRefs {
  refs: string[];
}

export interface ResearchDossier {
  headline: string;
  summary: string;
  narrativeSpine: ({ step: string; detail: string } & DossierRefs)[];
  establishedFacts: ({ text: string } & DossierRefs)[];
  controversies: { title: string; versions: ({ text: string } & DossierRefs)[] }[];
  risks: ({ text: string } & DossierRefs)[];
  materialClusters: { title: string; points: ({ text: string } & DossierRefs)[] }[];
}

export interface ResearchSource {
  sid: string;
  url: string;
  title: string;
  domain: string;
  category: string;
  /** ok=原文已抓取提纯；snippet=原文获取失败按搜索摘要提纯 */
  fetchStatus: "ok" | "snippet" | "pending";
  snippet: string;
  round: number;
  query: string;
}

export type ResearchStatus =
  | "planning"
  | "running"
  | "done"
  | "error"
  | "interrupted"
  | "stopped";

export interface ResearchJob {
  jobId: string;
  projectId: string;
  topic: string;
  brief: string;
  depth: "quick" | "standard" | "deep";
  mode: "full" | "gap";
  parentJobId: string;
  status: ResearchStatus;
  stage: string;
  roundsDone: number;
  roundsTotal: number;
  summary: string;
  error: string;
  sourcesCount: number;
  findingsCount: number;
  createdAt: string;
  updatedAt: string;
  plan: ResearchPlan | null;
  dossier: ResearchDossier | null;
  log: { t: string; kind: string; text: string }[];
}

export type ResearchDepth = "quick" | "standard" | "deep";

export async function startResearch(
  projectId: string,
  topic: string,
  brief = "",
  depth: ResearchDepth = "standard",
): Promise<ResearchJob> {
  const res = await apiFetch(`/agent-service/projects/${projectId}/research`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, brief, depth }),
  });
  if (!res.ok) throw new Error((await res.text()) || `发起失败（${res.status}）`);
  return res.json();
}

export async function getResearch(
  projectId: string,
  jobId: string,
): Promise<ResearchJob> {
  const res = await apiFetch(`/agent-service/projects/${projectId}/research/${jobId}`);
  if (!res.ok) throw new Error((await res.text()) || `查询失败（${res.status}）`);
  return res.json();
}

export async function listResearchSources(
  projectId: string,
  jobId: string,
): Promise<ResearchSource[]> {
  const res = await apiFetch(
    `/agent-service/projects/${projectId}/research/${jobId}/sources`,
  );
  if (!res.ok) throw new Error((await res.text()) || `来源查询失败（${res.status}）`);
  const data = (await res.json()) as { sources: ResearchSource[] };
  return data.sources;
}

export async function confirmResearch(
  projectId: string,
  jobId: string,
  plan?: ResearchPlan,
): Promise<ResearchJob> {
  const res = await apiFetch(
    `/agent-service/projects/${projectId}/research/${jobId}/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plan ? { plan } : {}),
    },
  );
  if (!res.ok) throw new Error((await res.text()) || `确认失败（${res.status}）`);
  return res.json();
}

export async function cancelResearch(projectId: string, jobId: string): Promise<void> {
  const res = await apiFetch(
    `/agent-service/projects/${projectId}/research/${jobId}/cancel`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error((await res.text()) || `取消失败（${res.status}）`);
}

export async function gapResearch(
  projectId: string,
  jobId: string,
  questions: string[],
): Promise<ResearchJob> {
  const res = await apiFetch(
    `/agent-service/projects/${projectId}/research/${jobId}/gap`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions }),
    },
  );
  if (!res.ok) throw new Error((await res.text()) || `补研发起失败（${res.status}）`);
  return res.json();
}

export const RESEARCH_STAGE_LABEL: Record<string, string> = {
  search: "搜索中",
  fetch: "抓取原文",
  extract: "提纯事实",
  evaluate: "评估完整性",
  dossier: "撰写卷宗",
};

export const RESEARCH_STATUS_LABEL: Record<ResearchStatus, string> = {
  planning: "待确认",
  running: "调研中",
  done: "已完成",
  error: "失败",
  interrupted: "已中断",
  stopped: "已取消",
};

export const RESEARCH_DEPTH_LABEL: Record<ResearchDepth, string> = {
  quick: "快查",
  standard: "标准",
  deep: "深挖",
};

/** 卷宗结构 → Markdown（导出/复制用；S 编号保留，来源清单附后） */
export function dossierToMarkdown(
  job: ResearchJob,
  sources: ResearchSource[],
): string {
  const d = job.dossier;
  if (!d) return "";
  const L: string[] = [];
  L.push(`# ${d.headline || job.topic}`);
  L.push("", d.summary, "");
  const cite = (refs: string[]) => (refs.length ? `（${refs.join("、")}）` : "");
  if (d.narrativeSpine.length) {
    L.push("## 叙事脊", "");
    d.narrativeSpine.forEach((s, i) =>
      L.push(`${i + 1}. **${s.step}** — ${s.detail}${cite(s.refs)}`),
    );
    L.push("");
  }
  if (d.establishedFacts.length) {
    L.push("## 已证实事实边界", "");
    d.establishedFacts.forEach((f) => L.push(`- ${f.text}${cite(f.refs)}`));
    L.push("");
  }
  if (d.controversies.length) {
    L.push("## 真实争议（双版本对质，不定论）", "");
    d.controversies.forEach((c) => {
      L.push(`### ${c.title}`, "");
      c.versions.forEach((v, i) => L.push(`- 版本${i + 1}：${v.text}${cite(v.refs)}`));
      L.push("");
    });
  }
  if (d.risks.length) {
    L.push("## 风险与待核实", "");
    d.risks.forEach((r) => L.push(`- ${r.text}${cite(r.refs)}`));
    L.push("");
  }
  if (d.materialClusters.length) {
    L.push("## 材料簇", "");
    d.materialClusters.forEach((m) => {
      L.push(`### ${m.title}`, "");
      m.points.forEach((p) => L.push(`- ${p.text}${cite(p.refs)}`));
      L.push("");
    });
  }
  if (sources.length) {
    L.push("## 来源底账", "");
    sources.forEach((s) =>
      L.push(
        `- ${s.sid}（${s.category}${s.fetchStatus === "snippet" ? "·摘要级" : ""}）[${s.title}](${s.url})`,
      ),
    );
  }
  return L.join("\n");
}
