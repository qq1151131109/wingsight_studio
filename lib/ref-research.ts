"use client";

/** 资产参考图调研客户端（Google 搜索经 Serper 号池，job + 轮询）。 */

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
  /** LLM 适配度排序位（1=最推荐；0=未入推）——自动采纳按它取 top-K */
  recRank: number;
  recReason: string;
  createdAt: string;
}

export interface RefResearchJob {
  status: "running" | "done" | "error";
  /** 当前阶段（出搜索词/搜图与下载/考据与终选） */
  phase: string;
  error: string;
  errors: Record<string, string>;
  /** LLM 终选的取舍说明 */
  note: string;
  candidates: RefCandidate[];
  /** 文字考据简报（AI 出词模式才有；已同步落资产卡 data.researchBrief） */
  researchBrief?: string;
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
  onPhase?: (phase: string) => void,
): Promise<RefResearchJob> {
  const jobId = await startRefResearch(projectId, nodeId, queries, asset);
  const deadline = Date.now() + 300_000;
  for (;;) {
    await new Promise((res) => setTimeout(res, 2000));
    const job = await getRefResearchJob(projectId, jobId);
    if (job.status !== "running") return job;
    onPhase?.(job.phase);
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

/** 取消采纳（保留候选行）：用户删掉参考卡 = 这张参考不要了——不再作为出图
 *  参考，也不再被对账物化成卡。候选仍在「找参考图」面板里可重新采纳。 */
export async function unadoptRefCandidates(
  projectId: string,
  nodeId: string,
  ids: string[],
): Promise<RefCandidate[]> {
  const r = await apiFetch(`/agent-service/projects/${projectId}/refs/unadopt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId, ids }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(text || `取消采纳失败（${r.status}）`);
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

// ---------- 批量调研（拆解链后，多资产串行） ----------

export interface BatchAssetInput {
  nodeId: string;
  name: string;
  type: string;
  description: string;
}

export interface BatchRefItem {
  nodeId: string;
  name: string;
  status: "pending" | "running" | "done" | "error";
  error: string;
  /** 文字考据简报（done 且文路成功时有值；落资产卡 data.researchBrief） */
  brief?: string;
}

export interface BatchRefJob {
  batchId: string;
  status: "running" | "done";
  total: number;
  done: number;
  current: string;
  items: BatchRefItem[];
}

/** 批量发起：后端串行逐资产调研（每资产 = AI 出词→双渠道→终选）。 */
export async function startBatchRefResearch(
  projectId: string,
  assets: BatchAssetInput[],
): Promise<string> {
  const r = await apiFetch(
    `/agent-service/projects/${projectId}/refs/batch-research`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assets }),
    },
  );
  if (!r.ok) {
    const text = await r.text();
    throw new Error(text || `批量调研发起失败（${r.status}）`);
  }
  const body = (await r.json()) as { batchId: string };
  return body.batchId;
}

/** 查询批量调研任务状态（轮询循环在节点卡组件的 useBatchRefJob：任务锚在
 *  节点数据 refBatchJobId 上，卡片卸载/刷新后凭锚续轮询、终态照弹面板）。 */
export async function getBatchRefResearchJob(
  projectId: string,
  batchId: string,
): Promise<BatchRefJob> {
  const r = await apiFetch(
    `/agent-service/projects/${projectId}/refs/batch-research/${batchId}`,
  );
  if (r.status === 404) throw new Error("批量调研任务不存在（agent 可能已重启）");
  if (!r.ok) throw new Error(`批量调研查询失败（${r.status}）`);
  return (await r.json()) as BatchRefJob;
}

// ---------- 考证报告（服务端权威：条目 + 参考图底账 + 待补清单） ----------

/** 考据条目（服务端 research_entries 表的一行）：调研文字产物的落点。
 *  era 相同且资产名相同的历史条目可跨项目复用（`/refs/report` 是它的人读视图）。 */
export interface RefEntry {
  id: string;
  projectId: string;
  nodeId: string;
  assetName: string;
  assetType: string;
  era: string;
  /** 主题归属（考证大纲的主题；未归类为空） */
  topicKey: string;
  body: string;
  sources: { title: string; url: string; domain: string }[];
  updatedAt: string;
}

export interface RefReport {
  projectId: string;
  projectName: string;
  era: string;
  entries: RefEntry[];
  /** 画布上还没有考据的资产卡（报告「待补」段，也是用户该动手的清单） */
  missing: { nodeId: string; title: string; nodeType: string }[];
  /** 真待办 = missing 里连参考图都没有的（调研没成或从没跑过）——报告卡
   *  「补调研 N」按钮的工作清单。有参考图只缺文字简报的不进这里（重跑浪费） */
  pendingAssets: { nodeId: string; name: string; type: string }[];
  /** 已采纳候选按节点分组（前端对账物化参考卡用；已物化的按图 URL 去重） */
  adopted: { nodeId: string; candidates: RefCandidate[] }[];
  /** 时代参考池物化清单：有图集的主题 + 服务哪些卡（对账落成时代参考卡，
   *  一张图一张卡、连到每个成员卡；图带 id 作 meta.dismissedTopicRefs 删除凭据） */
  topicRefs: {
    topicKey: string;
    title: string;
    subjectKey: string;
    images: {
      id: string;
      url: string;
      title: string;
      sourceUrl: string;
      sourceDomain: string;
    }[];
    servedNodeIds: string[];
  }[];
  /** 考证大纲的主题（报告首节） */
  outline: RefTopic[];
  /** 卡片简报：本资产条目 + 服务它的主题条目合成（卡上显示的 = 出图发出去的） */
  cardBriefs: Record<string, string>;
  /** 报告正文（纯文本，含来源底账与待补清单）——落成画布报告卡 */
  text: string;
  generatedAt: string;
}

/** 考证大纲的一个主题：检索词 + 服务哪些卡 + 状态（调研单位是题材不是资产）。 */
export interface RefTopic {
  topicKey: string;
  title: string;
  rationale: string;
  queries: string[];
  nodeIds: string[];
  status: "planned" | "running" | "done" | "reused" | "error";
  /** status=reused 时的来源项目名 */
  reusedFrom: string;
  error: string;
  serves: { nodeId: string; title: string }[];
  entry: RefEntry | null;
}

export interface RefOutline {
  projectId: string;
  projectName: string;
  era: string;
  topics: RefTopic[];
  /** 未被任何主题覆盖的资产（缺口清单，用来补主题） */
  uncovered: { nodeId: string; title: string; nodeType: string }[];
  assetCount: number;
  doneCount: number;
  /** 大纲正文（纯文本，不含事实正文）——落成画布大纲卡 */
  text: string;
  generatedAt: string;
}

/** 拉项目考证报告。条目在简报产出时即落库，与谁发起调研、画布开没开无关。 */
export async function getRefReport(projectId: string): Promise<RefReport> {
  const r = await apiFetch(`/agent-service/projects/${projectId}/refs/report`);
  if (!r.ok) throw new Error(`考证报告加载失败（${r.status}）`);
  return (await r.json()) as RefReport;
}

/** 拉项目考证大纲（主题计划 + 执行状态 + 缺口）。 */
export async function getRefOutline(projectId: string): Promise<RefOutline> {
  const r = await apiFetch(`/agent-service/projects/${projectId}/refs/outline`);
  if (!r.ok) throw new Error(`考证大纲加载失败（${r.status}）`);
  return (await r.json()) as RefOutline;
}

/** 执行大纲主题（缺省全部未完成的）。状态写回主题行，大纲卡即进度板。 */
export async function runRefOutline(
  projectId: string,
  topicKeys: string[] = [],
): Promise<{ started: string[]; outline: RefOutline }> {
  const r = await apiFetch(`/agent-service/projects/${projectId}/refs/outline/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topicKeys }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text || `执行失败（${r.status}）`);
  return JSON.parse(text) as { started: string[]; outline: RefOutline };
}

/** 库中一条可复用的考据主体（别的项目考据过的现成成果）。 */
export interface RefLibraryItem {
  id: string;
  subjectKey: string;
  /** 资产名（时代主题时为空） */
  assetName: string;
  assetType: string;
  topicKey: string;
  kind: "asset" | "topic";
  body: string;
  sources: { title?: string; url?: string; domain?: string }[];
  /** 主体图集张数（跨项目可复用的参考图） */
  refCount: number;
  fromProjectId: string;
  fromProject: string;
  /** 本项目是否已引用 */
  used: boolean;
  updatedAt: string;
}

export interface RefLibrary {
  /** 项目时代口径（空 = 库不可用：主体键都是项目私有的） */
  era: string;
  items: RefLibraryItem[];
}

/** 拉同题材可复用考据库（按项目 era 作用域，跨项目读）。 */
export async function getRefLibrary(projectId: string): Promise<RefLibrary> {
  const r = await apiFetch(`/agent-service/projects/${projectId}/refs/library`);
  if (!r.ok) throw new Error(`考据库加载失败（${r.status}）`);
  return (await r.json()) as RefLibrary;
}

/** 把库里的主体引用到本项目某张卡/某个主题上（活引用，不重搜）。 */
export async function importRefSubject(
  projectId: string,
  entryId: string,
  targetKind: "node" | "topic",
  targetKey: string,
): Promise<void> {
  const r = await apiFetch(`/agent-service/projects/${projectId}/refs/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId, targetKind, targetKey }),
  });
  if (!r.ok) throw new Error((await r.text()) || `引用失败（${r.status}）`);
}
