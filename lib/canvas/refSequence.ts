/**
 * 参考序列单一事实源：直连出图的参考数组与「图N」编号全部经此构建。
 * PromptBar（计数/chips 位次）与 CanvasAgentBridge（referenceImages/
 * numberingNote/visualNotes）共用，口径不再漂移——罪案实录「参考 0/4、
 * 实发 3 张」事故的根因就是两处各算各的。
 *
 * 序列语义（与生成管线逐位对应）：
 *   正文 @ 引用（编号序，排最前）→ 本卡原图（未 @ 自己时兜底图生图锚点）
 *   → 上游连线卡，带图才收；按图片 URL 去重。
 */

import type { WingNode } from "./store";

/** 上下文注入的正文截断统一口径（visualNotes/行出图/聊天指令/文本撰写
 *  共用）：此前 40~800 各自为政，长设定在多数消费方被切到面目全非 */
export const CONTEXT_BODY_LIMIT = 500;

export type RefSeqEntry = {
  node: WingNode;
  url: string;
  /** 图1/图2…：正文指代与 flow 参考位次一一对应 */
  label: string;
  kind: "mention" | "self" | "edge";
};

export function buildRefSequence(opts: {
  mentionIds: string[];
  nodes: WingNode[];
  selfId?: string;
  selfImageUrl?: string;
  connectedIds: string[];
}): { entries: RefSeqEntry[]; urls: string[] } {
  const byId = new Map(opts.nodes.map((n) => [n.id, n]));
  const entries: RefSeqEntry[] = [];
  const seen = new Set<string>();
  const push = (n: WingNode, url: string, kind: RefSeqEntry["kind"]) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    entries.push({ node: n, url, label: `图${entries.length + 1}`, kind });
  };
  for (const id of opts.mentionIds) {
    const n = byId.get(id);
    const url = n?.data.imageUrl as string | undefined;
    if (n && url) push(n, url, "mention");
  }
  if (
    opts.selfId &&
    opts.selfImageUrl &&
    !opts.mentionIds.includes(opts.selfId)
  ) {
    const self = byId.get(opts.selfId);
    if (self) push(self, opts.selfImageUrl, "self");
  }
  for (const id of opts.connectedIds) {
    if (opts.mentionIds.includes(id)) continue;
    const n = byId.get(id);
    const url = n?.data.imageUrl as string | undefined;
    if (n && url) push(n, url, "edge");
  }
  return { entries, urls: entries.map((e) => e.url) };
}
