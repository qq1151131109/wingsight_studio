"use client";

/**
 * 调研产物对账（2026-09-10：把「投产物的时机」从轮询窗口里救出来）。
 *
 * 此前画布上的一切调研产物都靠一个前端轮询窗口写入：卡片带 refBatchJobId 锚
 * → useBatchRefJob 轮询 → 条目 done 时顺手写 data.researchBrief、顺手自动采纳
 * 建参考卡。四个条件（锚在、卡挂载、轮询跑到、agent 没重启）任一不成立，产物
 * 就永久留在内存/DB 行里，画布上什么都没有——生产库实测 23 个项目
 * refSource 零命中、资产卡 researchBrief 全零，而 ref_candidates 里躺着 152 张
 * 已采纳的参考图（agent 从聊天发起的调研没人写 refBatchJobId 锚，是最常见的
 * 断法）。
 *
 * 条目表（服务端）现在承载权威数据，本模块做的是「把它呈现到画布」这一步：
 * 打开项目 / 调研完成事件时各对账一次，缺什么补什么，缺得再久也自愈。对账
 * 天然幂等——简报按内容比、参考卡按图 URL 去重、报告卡按 reportKind 单例。
 */

import { adoptRefRows } from "@/lib/canvas/refAdopt";
import { absolutePosition, nodeSize, useCanvasStore } from "@/lib/canvas/store";
import { addCardAt } from "@/lib/canvas/ingest";
import {
  adoptRefCandidates,
  getRefOutline,
  getRefReport,
  type RefOutline,
  type RefReport,
} from "@/lib/ref-research";
import { useRefStatusStore } from "@/lib/refStatus";

/** 报告卡标记（同一项目恒定一张，按它认领不重复建卡） */
export const REF_REPORT_KIND = "ref-research";
/** 考证大纲卡标记（计划与进度板；事实归报告卡，两张不重复内容） */
export const REF_OUTLINE_KIND = "ref-outline";

export type CardState = "created" | "updated" | "unchanged" | "skipped";

export interface ReconcileResult {
  /** 写进资产卡的简报条数 */
  briefsWritten: number;
  /** 新建的参考图卡张数 */
  refsCreated: number;
  report: CardState;
  outline: CardState;
  /** 报告里待补考据的资产数（供调用方提示用户） */
  missing: number;
}

/** 在途去重：打开项目与事件流可能同时触发，同一项目只跑一次 */
const inflight = new Map<string, Promise<ReconcileResult>>();

/** 报告卡的落位：画布内容右下方留白（不压在任何卡上，也不抢视口） */
function reportAnchor() {
  const nodes = useCanvasStore.getState().nodes;
  let maxRight = 0;
  let maxBottom = 0;
  for (const n of nodes) {
    if (n.hidden) continue;
    const abs = absolutePosition(nodes, n);
    const s = nodeSize(n);
    maxRight = Math.max(maxRight, abs.x + s.w);
    maxBottom = Math.max(maxBottom, abs.y + s.h);
  }
  return { x: maxRight + 96, y: maxBottom + 96 };
}

/** 参考卡已物化的图 URL（资产 → 已有参考图的 URL 集合，按它去重） */
function materializedUrls(nodeId: string): Set<string> {
  const st = useCanvasStore.getState();
  const refIds = new Set(
    st.edges.filter((e) => e.target === nodeId).map((e) => e.source),
  );
  const urls = new Set<string>();
  for (const n of st.nodes) {
    if (!refIds.has(n.id) || n.data.refSource !== "research") continue;
    if (n.data.imageUrl) urls.add(String(n.data.imageUrl));
  }
  return urls;
}

/** 报告卡/大纲卡共用的单例写卡：有内容才建，内容没变不动（幂等）。
 *  系统写入——不进撤销栈（用户打开项目不该改变 Ctrl+Z 的语义） */
function upsertDocCard(
  kind: string,
  title: string,
  body: string,
): CardState {
  const st = useCanvasStore.getState();
  // 用户删过这张卡 = 不要这张视图了，不再重建（2026-09-10 用户拍板，与参考卡
  // 「删了不再长回来」同语义）。标记随 meta 持久化，见 store.deleteNodes
  if (st.dismissedReports.includes(kind)) return "skipped";
  const existing = st.nodes.find((n) => n.data.reportKind === kind);
  if (!existing) {
    const id = addCardAt(
      reportAnchor(),
      {
        nodeType: "note",
        title,
        body,
        reportKind: kind,
      },
      undefined,
      { history: "skip" },
    );
    return id ? "created" : "skipped";
  }
  if (existing.data.body === body && existing.data.title === title) {
    return "unchanged";
  }
  useCanvasStore
    .getState()
    .updateNodeData(existing.id, { body, title }, { history: "skip" });
  return "updated";
}

/** 把服务端报告落成画布状态（简报 → 资产卡、采纳图 → 参考卡、报告/大纲 → 文本卡）。
 *  失败抛错由调用方决定是否明报——对账是自愈层，不该静默吞掉服务端故障。 */
export async function reconcileRefResearch(
  projectId: string,
): Promise<ReconcileResult> {
  const running = inflight.get(projectId);
  if (running) return running;
  const task = (async (): Promise<ReconcileResult> => {
    const [report, outline]: [RefReport, RefOutline] = await Promise.all([
      getRefReport(projectId),
      getRefOutline(projectId),
    ]);
    const st = useCanvasStore.getState();
    // 期间切了项目/还没装载完：这一轮的产物不属于当前画布，直接作废
    if (!st.hydrated || st.projectId !== projectId) {
      return {
        briefsWritten: 0,
        refsCreated: 0,
        report: "skipped",
        outline: "skipped",
        missing: report.missing.length,
      };
    }

    // ① 简报落资产卡（按内容比，幂等）。cardBriefs 已是「本资产条目 + 服务它
    //    的主题条目」的合成结果——卡上显示的与出图注入的同源，不各说各话。
    //    系统写入（history:"skip"）：打开项目不该改变 Ctrl+Z 的语义
    let briefsWritten = 0;
    for (const [nodeId, brief] of Object.entries(report.cardBriefs ?? {})) {
      if (!nodeId || !brief) continue;
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      if (!node || node.data.researchBrief === brief) continue;
      useCanvasStore
        .getState()
        .updateNodeData(nodeId, { researchBrief: brief }, { history: "skip" });
      briefsWritten += 1;
    }

    // ② 已采纳参考图物化成参考卡 + 连线（按图 URL 去重，重跑不堆卡）
    let refsCreated = 0;
    for (const group of report.adopted) {
      if (!useCanvasStore.getState().nodes.some((n) => n.id === group.nodeId)) continue;
      const have = materializedUrls(group.nodeId);
      const picks = group.candidates.filter((c) => c.assetUrl && !have.has(c.assetUrl));
      if (!picks.length) continue;
      refsCreated += adoptRefRows([{ nodeId: group.nodeId, candidates: picks }], {
        history: "skip",
      }).length;
    }

    // ②b 反向修复：画布上有参考卡、服务端却未采纳（删卡撤销回来后就是这状态）
    //     → 补采纳。不做的话卡片看着是参考、实际已不在采纳集里，两个真相。
    const adoptedIds = new Set(
      report.adopted.flatMap((g) => g.candidates.map((c) => c.id)),
    );
    const readopt = new Map<string, string[]>();
    for (const n of useCanvasStore.getState().nodes) {
      const cid = String(n.data.refCandidateId ?? "");
      if (n.data.refSource !== "research" || !cid || adoptedIds.has(cid)) continue;
      const assetNodeId = String(
        useCanvasStore.getState().edges.find((e) => e.source === n.id)?.target ?? "",
      );
      if (!assetNodeId) continue;
      readopt.set(assetNodeId, [...(readopt.get(assetNodeId) ?? []), cid]);
    }
    if (readopt.size) {
      await Promise.all(
        [...readopt.entries()].map(([nodeId, ids]) =>
          adoptRefCandidates(projectId, nodeId, ids).catch((err) =>
            console.warn("[调研对账] 参考卡补采纳失败", nodeId, err),
          ),
        ),
      );
    }

    // ③ 报告卡与大纲卡（各自单例）：有条目/主题才建——空卡是噪音
    const reportState: CardState =
      report.entries.length > 0 && report.text
        ? upsertDocCard(
            REF_REPORT_KIND,
            `《${report.projectName || "本项目"}》资产考证报告`,
            report.text,
          )
        : "skipped";
    const outlineState: CardState =
      outline.topics.length > 0 && outline.text
        ? upsertDocCard(
            REF_OUTLINE_KIND,
            `《${outline.projectName || "本项目"}》考证大纲`,
            outline.text,
          )
        : "skipped";

    if (refsCreated) void useRefStatusStore.getState().refresh(projectId, { force: true });
    return {
      briefsWritten,
      refsCreated,
      report: reportState,
      outline: outlineState,
      missing: report.missing.length,
    };
  })();
  inflight.set(projectId, task);
  try {
    return await task;
  } finally {
    inflight.delete(projectId);
  }
}
