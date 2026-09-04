/**
 * 画布数据消毒（装载边界）：剥离指向不存在节点的 parentId/连线。
 * 背景：多会话并发保存曾产生过"孤儿子卡"（组框丢失、坐标仍是相对值），
 * 直接进渲染管线会引发 xyflow 告警和布局错乱——必须在 loadCanvas 后过滤。
 */

import {
  findFreePosition,
  NODE_FOOTPRINT,
  type ShotRow,
  type WingEdge,
  type WingNode,
} from "./store";
import { resolveRowRefIds } from "./shotRefs";

export interface SanitizeResult {
  nodes: WingNode[];
  edges: WingEdge[];
  removedNodes: number;
  removedEdges: number;
  fixedParents: number;
  /** 遗留 looks[] 迁移拆出的 Look 图片卡数（一张卡一张图） */
  migratedLooks: number;
  /** 存量镜头图补参考：补写 refIds 的图卡数（参考连线另计） */
  fixedShotRefs: number;
  /** 存量占位标题剥成空名的卡数（hint 默认标题/hex 文件名） */
  strippedTitles: number;
  /** 存量调研卡从正文回填 researchId 的卡数（agent 曾把任务 id 写进正文） */
  fixedResearchIds: number;
  /** 存量调研卡升文档尺寸的卡数（旧默认 320×220 → 卷宗上卡后的 480×560） */
  upsizedResearch: number;
}

/** 旧版建卡/agent 兜底把 NODE_META.hint 占位文案存成真标题（罪案实录 9 张卡
 *  同名「设定图 / 参考图占位」——污染 @ 候选、参考职责标签、编号契约），
 *  上传卡以随机 hex 文件名做标题。一律剥成空名：新代码空名建卡，UI 以类型
 *  名兜底显示。精确匹配防误伤用户真标题 */
const PLACEHOLDER_TITLES = new Set([
  "自由文本",
  "故事大纲或分场剧本",
  "角色设定卡",
  "场景概念图 / 空间参考",
  "道具设定 / 单件参考",
  "服饰设定 / Look 素材",
  "设定图 / 参考图占位",
  "镜头视频 / 动态预览",
  "配音 / 音效 / BGM",
  "按序拼接上游视频成片",
  "镜头画面描述",
  "整场戏的镜头清单",
  "粘贴的文本",
  "粘贴的图片",
]);
/** agent 归档文件名是 uuid hex[:12]（12-32 位 hex + 扩展名） */
const HEX_FILENAME_TITLE =
  /^[0-9a-f]{12,32}\.(png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav)$/i;

export function sanitizeCanvas(
  nodes: WingNode[],
  edges: WingEdge[],
): SanitizeResult {
  const ids = new Set(
    nodes.filter((n) => n && typeof n.id === "string").map((n) => n.id),
  );
  const cleanNodes: WingNode[] = [];
  const seenIds = new Set<string>();
  let removedNodes = 0;
  let fixedParents = 0;
  for (const n of nodes) {
    if (!n || typeof n.id !== "string" || typeof n.data?.nodeType !== "string") {
      removedNodes += 1;
      continue;
    }
    if (seenIds.has(n.id)) {
      // 重复 id（多会话竞态/重放）：React key 唯一性要求，保留首个
      removedNodes += 1;
      continue;
    }
    seenIds.add(n.id);
    if (n.parentId && !ids.has(n.parentId)) {
      // 组框丢失的孤儿卡：脱离分组（坐标按绝对值近似处理，交给用户微调）
      const { parentId: _p, extent: _e, ...rest } = n;
      cleanNodes.push(rest as WingNode);
      fixedParents += 1;
      continue;
    }
    cleanNodes.push(n);
  }
  // 遗留 looks[] 迁移（一张卡一张图）：角色卡上的 Look 变体拆成独立图片卡，
  // 角色卡 → Look卡 连线表达派生关系；迁后 looks 字段剥离，再次装载即幂等
  const byId = new Map(cleanNodes.map((n) => [n.id, n]));
  const extraNodes: WingNode[] = [];
  const extraEdges: WingEdge[] = [];
  let migratedLooks = 0;
  for (const n of cleanNodes) {
    const looks = n.data.looks;
    if (n.data.nodeType !== "character" || !Array.isArray(looks) || looks.length === 0) {
      continue;
    }
    delete n.data.looks;
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    const abs = parent
      ? {
          x: parent.position.x + n.position.x,
          y: parent.position.y + n.position.y,
        }
      : { ...n.position };
    const charW =
      (typeof n.style?.width === "number" ? n.style.width : 0) || 256;
    // 落点：角色可视位置右侧一列；在组内时摆到组框外右缘（避免叠组内兄弟卡）
    const baseX = parent
      ? parent.position.x +
        ((typeof parent.style?.width === "number" ? parent.style.width : 0) || 480) +
        32
      : abs.x + charW + 32;
    const gen = () => Math.random().toString(36).slice(2, 10);
    looks.forEach((l, i) => {
      if (!l?.imageUrl) return;
      const lid = `n_${gen()}`;
      extraNodes.push({
        id: lid,
        type: "image",
        position: {
          x: baseX,
          y: abs.y + i * (NODE_FOOTPRINT.image.h + 32),
        },
        // 与普通图片卡同尺寸（通用容器）；历史小卡由用户手动缩放或重建
        style: { width: NODE_FOOTPRINT.image.w, height: NODE_FOOTPRINT.image.h },
        data: {
          nodeType: "image",
          title: `${n.data.title || "角色"}·${l.label || "造型"}`.slice(0, 40),
          body: "",
          imageUrl: l.imageUrl,
          status: "ready",
        },
      });
      extraEdges.push({ id: `e_${gen()}`, source: n.id, target: lid });
      migratedLooks += 1;
    });
  }
  const liveIds = new Set(cleanNodes.map((n) => n.id));
  const cleanEdges: WingEdge[] = [];
  let removedEdges = 0;
  for (const e of edges) {
    if (!e || !liveIds.has(e.source) || !liveIds.has(e.target) || e.source === e.target) {
      removedEdges += 1;
      continue;
    }
    cleanEdges.push(e);
  }

  // 旧 Look 小卡（176×132 特批尺寸）→ 标准图片卡尺寸；同源角色成组的按
  // 原区域重铺网格（新尺寸沿用旧间距会互相叠压）。精确匹配尺寸判定，
  // 迁后不再命中，装载幂等
  const byId2 = new Map(cleanNodes.map((n) => [n.id, n]));
  const smallLooks = new Set(
    cleanNodes
      .filter(
        (n) =>
          n.data.nodeType === "image" &&
          n.style?.width === 176 &&
          n.style?.height === 132,
      )
      .map((n) => n.id),
  );
  if (smallLooks.size > 0) {
    // 按连线来源（角色/服饰卡）分组重铺；无来源的孤立小卡就地放大
    const groups = new Map<string, string[]>();
    for (const e of [...cleanEdges, ...extraEdges]) {
      if (!smallLooks.has(e.target)) continue;
      const src = byId2.get(e.source);
      if (!src || src.data.nodeType === "image") continue;
      const arr = groups.get(e.source) ?? [];
      if (!arr.includes(e.target)) arr.push(e.target);
      groups.set(e.source, arr);
    }
    const handled = new Set<string>();
    for (const [, ids] of groups) {
      // 同时连角色+服饰的 Look 卡归先到的组，后组跳过（不重复布局）
      const nodes = ids
        .filter((nid) => !handled.has(nid))
        .map((nid) => byId2.get(nid)!)
        .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
      if (nodes.length === 0) continue;
      const minX = Math.min(...nodes.map((n) => n.position.x));
      const minY = Math.min(...nodes.map((n) => n.position.y));
      const cols = Math.min(2, nodes.length);
      nodes.forEach((n, i) => {
        n.style = { width: NODE_FOOTPRINT.image.w, height: NODE_FOOTPRINT.image.h };
        n.position = {
          x: minX + (i % cols) * (NODE_FOOTPRINT.image.w + 32),
          y: minY + Math.floor(i / cols) * (NODE_FOOTPRINT.image.h + 32),
        };
        handled.add(n.id);
      });
    }
    for (const id of smallLooks) {
      if (handled.has(id)) continue;
      const n = byId2.get(id);
      if (n) n.style = { width: NODE_FOOTPRINT.image.w, height: NODE_FOOTPRINT.image.h };
    }
  }

  // 存量镜头图补参考：历史批量出图已把行级 @资产喂给出图 flow（一致性
  // 锚点），但没把参考落到图卡（无 refIds、无连线），画布看不出派生关系。
  // 按行解析补 refIds + 「资产→镜头图」连线；解析与运行时同源（shotRefs），
  // 已有即跳过，装载幂等
  const byId3 = new Map(cleanNodes.map((n) => [n.id, n]));
  const allEdges = [...cleanEdges, ...extraEdges];
  let fixedShotRefs = 0;
  for (const s of cleanNodes) {
    if (s.data.nodeType !== "shotlist" || !Array.isArray(s.data.rows)) continue;
    for (const row of s.data.rows as ShotRow[]) {
      const imgId = row?.imageNodeId;
      if (!imgId || !byId3.has(imgId)) continue;
      const refIds = resolveRowRefIds(row, cleanNodes, allEdges);
      if (refIds.length === 0) continue;
      const img = byId3.get(imgId)!;
      const prev = (img.data.refIds as string[] | undefined) ?? [];
      const merged = new Set([...prev, ...refIds]);
      if (merged.size > prev.length) {
        img.data.refIds = [...merged];
        fixedShotRefs += 1;
      }
      for (const rid of refIds) {
        if (allEdges.some((e) => e.source === rid && e.target === imgId)) continue;
        const e = {
          id: `e_${Math.random().toString(36).slice(2, 10)}`,
          source: rid,
          target: imgId,
        };
        allEdges.push(e);
        extraEdges.push(e);
      }
    }
  }

  // 存量 Look 散卡收框「造型图」：有 角色/服饰 入边、未归组的「名·造型」
  // 图片卡即 Look 造型图（镜头派生图天然排除——它有分镜表入边）。≥2 张时
  // 按来源角色分行重排、贴角色组右缘成框（无角色组则落散卡现区域）；进框
  // 后有 parentId，再次装载不再命中，幂等
  const lookLoose = cleanNodes.filter(
    (n) =>
      !n.parentId &&
      n.data.nodeType === "image" &&
      String(n.data.title ?? "").includes("·") &&
      allEdges.some((e) => {
        if (e.target !== n.id) return false;
        const src = byId3.get(e.source);
        return (
          Boolean(src) &&
          ["character", "costume"].includes(String(src!.data.nodeType))
        );
      }) &&
      !allEdges.some((e) => {
        const src = byId3.get(e.source);
        return e.target === n.id && src?.data.nodeType === "shotlist";
      }),
  );
  if (lookLoose.length >= 2) {
    const charTitleOf = (n: WingNode) => {
      for (const e of allEdges) {
        if (e.target !== n.id) continue;
        const src = byId3.get(e.source);
        if (src?.data.nodeType === "character")
          return String(src.data.title ?? "");
      }
      return "·"; // 无角色源（仅服饰绑定等）归入同一兜底行
    };
    const sorted = [...lookLoose].sort(
      (a, b) => a.position.y - b.position.y || a.position.x - b.position.x,
    );
    const rows: WingNode[][] = [];
    for (const n of sorted) {
      const last = rows[rows.length - 1];
      if (last && charTitleOf(last[0]) === charTitleOf(n)) last.push(n);
      else rows.push([n]);
    }
    const lfp = NODE_FOOTPRINT.image;
    const colsMax = Math.max(...rows.map((r) => r.length), 1);
    const low = colsMax * (lfp.w + 32) - 32;
    const loh = rows.length * (lfp.h + 32) - 32;
    const charGroup = cleanNodes.find(
      (n) => n.data.nodeType === "group" && n.data.title === "角色",
    );
    const originL = findFreePosition(
      cleanNodes,
      charGroup
        ? {
            x:
              charGroup.position.x +
              ((typeof charGroup.style?.width === "number"
                ? charGroup.style.width
                : 0) || 0) +
              64,
            y: charGroup.position.y,
          }
        : {
            x: Math.min(...lookLoose.map((n) => n.position.x)),
            y: Math.min(...lookLoose.map((n) => n.position.y)),
          },
      { w: low, h: loh },
    );
    rows.forEach((row, ri) => {
      row.forEach((n, ci) => {
        n.position = {
          x: originL.x + ci * (lfp.w + 32),
          y: originL.y + ri * (lfp.h + 32),
        };
      });
    });
    // 手工建组（sanitize 是纯函数，不走 store.groupNodes）：尺寸/内边距与
    // groupNodes 约定一致（pad 36 + 标题条 22）；组节点须排在子节点之前
    const pad = 36;
    const gid = `n_${Math.random().toString(36).slice(2, 10)}`;
    const groupNode: WingNode = {
      id: gid,
      type: "group",
      position: { x: originL.x - pad, y: originL.y - pad - 22 },
      style: { width: low + pad * 2, height: loh + pad * 2 + 22 },
      data: { nodeType: "group", title: "造型图", body: "" },
    };
    for (const n of lookLoose) {
      n.parentId = gid;
      n.position = {
        x: n.position.x - groupNode.position.x,
        y: n.position.y - groupNode.position.y,
      };
    }
    cleanNodes.unshift(groupNode);
  }

  // 存量调研卡回填 researchId（2026-09-04 白骨精事故：agent 建调研卡把任务 id
  // 写进正文而没填 data.researchId——卡面轮询/卷宗按钮只认字段，卡成死卡：
  // 进度永远「…」、卷宗按钮点击无效。从正文「深度调研任务：{id}」回填；
  // 回填后不再命中，装载幂等。字段缺失且正文无 id 的卡不动（新建路径已堵死）
  let fixedResearchIds = 0;
  for (const n of cleanNodes) {
    if (n.data.nodeType !== "research" || n.data.researchId) continue;
    const m = /深度调研任务[：:]\s*([0-9a-f]{12})/.exec(
      String(n.data.body ?? ""),
    );
    if (!m) continue;
    n.data.researchId = m[1];
    fixedResearchIds += 1;
  }

  // 存量调研卡升文档尺寸（2026-09-04 卷宗全文上卡）：旧默认 320×220 精确
  // 匹配才升 480×560——用户手调过的尺寸不动。升后不再命中，装载幂等
  let upsizedResearch = 0;
  for (const n of cleanNodes) {
    if (
      n.data.nodeType === "research" &&
      n.style?.width === 320 &&
      n.style?.height === 220
    ) {
      n.style = { ...n.style, width: 480, height: 560 };
      upsizedResearch += 1;
    }
  }

  // 存量占位标题清洗：hint 默认标题/hex 文件名 → 空名（幂等，二次装载为 0）
  let strippedTitles = 0;
  for (const n of cleanNodes) {
    // title 缺失/非字符串 → 规范成空名（空名约定；下游 summarizeCanvas 等
    // 直接 .slice 的地方不当边界）
    if (typeof n.data.title !== "string") n.data.title = "";
    const t = n.data.title.trim();
    if (!t) continue;
    if (PLACEHOLDER_TITLES.has(t) || HEX_FILENAME_TITLE.test(t)) {
      n.data.title = "";
      strippedTitles += 1;
    }
  }

  return {
    nodes: [...cleanNodes, ...extraNodes],
    edges: [...cleanEdges, ...extraEdges],
    removedNodes,
    removedEdges,
    fixedParents,
    migratedLooks,
    fixedShotRefs,
    strippedTitles,
    fixedResearchIds,
    upsizedResearch,
  };
}
