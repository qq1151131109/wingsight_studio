/**
 * 分镜行 ↔ 资产卡引用解析（共享纯函数）：行内出图参考、行 @候选下拉、
 * sanitize 存量迁移三处共用同一实现，避免逻辑漂移。
 * 三通道（命中优先级从高到低）：
 * ① 结构化 refIds（行上字段，改名不失联）——resolveRowRefIds 合并；
 * ② 文本 @名称——最长名优先匹配（防「小雨」误命中「小雨萍」），已命中的
 *    区间不再被更短名覆盖；
 * ③ 全名兜底（ai-moive-studio 按名解析范式）：行文本出现完整资产标题（无
 *    @ 也认，≥2 字防单字误伤）——分镜先于资产生成时行文本天然含资产名，
 *    资产后建/后出图在出图时活解析自动挂上，无需回填步骤。
 */

import type { ShotRow, WingEdge, WingNode } from "./store";

/** 资产卡四类型（角色/场景/道具/服饰）——引用解析与建卡防重共用 */
export const ASSET_TYPES = ["character", "scene", "prop", "costume"];

/** Look 图卡判定：image 卡且有来自资产卡的连线 = 派生参考图（一张卡一张图
 *  重构后，造型变体都是这种卡），可被行内 @ 引用当一致性参考。
 *  有分镜表入边的镜头派生图不算——它们是产出不是造型参考 */
export function isLookCard(
  n: WingNode | undefined,
  nodes: WingNode[],
  edges: WingEdge[],
): boolean {
  if (
    !n ||
    n.data.nodeType !== "image" ||
    !(n.data.title as string)?.trim()
  ) {
    return false;
  }
  return edges.some((e) => {
    if (e.target !== n.id) return false;
    const src = nodes.find((m) => m.id === e.source);
    if (!src) return false;
    if (src.data.nodeType === "shotlist") return false;
    return ASSET_TYPES.includes(String(src.data.nodeType));
  });
}

/** 文本引用匹配：@名称 显式档 + 全名兜底档，返回命中的候选卡 id（去重，
 *  跨卡命中区间不重叠——@ 档区间优先，全名档只填空隙） */
export function mentionedRefIds(
  text: string,
  nodes: WingNode[],
  edges: WingEdge[],
): string[] {
  const cands = nodes
    .filter(
      (n) =>
        (ASSET_TYPES.includes(String(n.data.nodeType)) ||
          isLookCard(n, nodes, edges)) &&
        (n.data.title as string)?.trim(),
    )
    .sort(
      (a, b) =>
        (b.data.title as string).length - (a.data.title as string).length,
    );
  const found: string[] = [];
  const spans: [number, number][] = [];
  const scan = (tokenOf: (title: string) => string, minLen: number) => {
    for (const n of cands) {
      const title = n.data.title as string;
      if (title.length < minLen) continue;
      const token = tokenOf(title);
      let from = 0;
      for (;;) {
        const i = text.indexOf(token, from);
        if (i === -1) break;
        const end = i + token.length;
        if (!spans.some(([s0, e0]) => i < e0 && end > s0)) {
          spans.push([i, end]);
          found.push(n.id);
        }
        from = i + 1;
      }
    }
  };
  scan((t) => `@${t}`, 1); // @名称：显式引用
  scan((t) => t, 2); // 全名兜底：完整标题、≥2 字（单字误伤率不可控）
  return [...new Set(found)];
}

/** 行引用解析：结构化 refIds ∪ 文本 @名称 兜底，合并去重（refIds 在前） */
export function resolveRowRefIds(
  row: Pick<ShotRow, "refIds" | "action" | "dialogue">,
  nodes: WingNode[],
  edges: WingEdge[],
): string[] {
  const ids = new Set<string>(row.refIds ?? []);
  mentionedRefIds(`${row.action ?? ""}${row.dialogue ?? ""}`, nodes, edges).forEach(
    (id) => ids.add(id),
  );
  return [...ids];
}

/** 行出图参考的 Look 优先展开：引用了角色卡且行文字（画面/台词）命中其
 *  某张 Look 卡的造型名或绑定服饰名（服饰→Look 边）时，用该 Look 图替换
 *  角色定妆照做参考——Look 继承定妆照五官又带正确服饰，是更准的一致性
 *  锚点（juben look 范式）。没命中保持定妆照，不瞎选 */
export function preferLookRefs(
  row: Pick<ShotRow, "action" | "dialogue">,
  refIds: string[],
  nodes: WingNode[],
  edges: WingEdge[],
): string[] {
  const text = `${row.action ?? ""}${row.dialogue ?? ""}`;
  const out = refIds.map((id) => {
    const n = nodes.find((m) => m.id === id);
    if (!n || n.data.nodeType !== "character") return id;
    const looks = nodes.filter(
      (m) =>
        isLookCard(m, nodes, edges) &&
        edges.some((e) => e.source === id && e.target === m.id),
    );
    // 用户显式引用了该角色的某张 Look 卡：照单全收，不做自动替换
    if (looks.some((m) => refIds.includes(m.id))) return id;
    // 多命中消歧：取文本中最后出现的造型/服饰词（「脱下常服换上雨夜装」
    // 里换上的才是身上穿的）；同位置取更长词（素裙大礼服 压过 素裙）
    let best: { id: string; pos: number; len: number } | null = null;
    for (const m of looks) {
      const title = m.data.title as string;
      const label = title.includes("·") ? title.split("·").slice(1).join("·") : title;
      const terms = [label];
      for (const e of edges) {
        if (e.target !== m.id) continue;
        const c = nodes.find((x) => x.id === e.source);
        if (c?.data.nodeType === "costume" && c.data.title) terms.push(c.data.title as string);
      }
      for (const t of terms) {
        if (!t || !text.includes(t)) continue;
        const pos = text.lastIndexOf(t);
        if (!best || pos > best.pos || (pos === best.pos && t.length > best.len)) {
          best = { id: m.id, pos, len: t.length };
        }
      }
    }
    return best ? best.id : id;
  });
  return [...new Set(out)];
}
