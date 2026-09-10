/**
 * 画布操作契约（ops）——Agent 写通道的统一入口。
 *
 * 参考影策 canvas_apply_ops 的指令集设计，适配 React Flow 数据模型：
 *   add_node / update_node / delete_nodes / connect_nodes / set_viewport
 *
 * 校验从严：未知 op、非法参数一律记入 errors，不中断整批执行。
 */

import {
  EPISODE_MEMBER_TYPES,
  NODE_FOOTPRINT,
  NODE_META,
  absolutePosition,
  findFreePosition,
  inheritEpisodeId,
  nodeSize,
  noteFootprintFor,
  useCanvasStore,
  type ShotRow,
  type WingNodeData,
  type WingNodeType,
} from "./store";
import type { CSSProperties } from "react";

/** 测试/工具同源取 state（tsx 下测试直连 store.ts 会拿到另一个模块实例） */
export { useCanvasStore };

export type AddNodeOp = {
  op: "add_node";
  nodeType: WingNodeType;
  title?: string;
  body?: string;
  /** 画布坐标；缺省时自动在现有内容右下侧找空位 */
  position?: { x: number; y: number };
  /** 指定 id（幂等用）；已存在则报错 */
  id?: string;
  /** 图片/视频/音频卡的媒体源（生成结果回填） */
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  /** image 卡：一次生成的多张候选 */
  imageUrls?: string[];
  /** compose 卡：上游视频节点 id 的拼接顺序 */
  itemIds?: string[];
  /** 锁定（不可拖动/不可改标题） */
  locked?: boolean;
  /** 分镜表：整表替换镜头行 */
  rows?: {
    rid?: string;
    shotSize?: string;
    cameraMove?: string;
    duration?: string;
    action?: string;
    dialogue?: string;
    lighting?: string;
    sound?: string;
    /** 引用资产名清单（agent 整表写回时带）：按画布资产卡精确标题匹配转 refIds */
    assets?: string[];
    imageUrl?: string;
  }[];
  /** research 卡：深度调研任务 id（start_deep_research 返回的 jobId）。
   *  卡面进度轮询与「卷宗」按钮只认这个字段——写进正文不算，缺了卡是死卡 */
  researchId?: string;
  /** storyboard 卡：镜号 / 景别 / 运镜 / 时长（建卡时可直接带上） */
  shotNumber?: string;
  shotSize?: string;
  cameraMove?: string;
  duration?: string;
  /** storyboard 卡：台词 / 旁白 */
  dialogue?: string;
  /** 生成卡生命周期状态（聊天侧批量分镜图落卡用：出图已完成直接 ready） */
  status?: "loading" | "error" | "ready";
  /** 生成快照（聊天侧落卡与前端出图按钮同语义：重跑/面板预填吃真实载荷） */
  genPrompt?: string;
  genShot?: WingNodeData["genShot"];
  /** 角色卡：造型计划（拆解产出，label 必填；造型图据此出图并物化成卡） */
  looks?: WingNodeData["looks"];
  /** 参考资产卡 id（连线即引用；资产→镜头图卡穿线） */
  refIds?: string[];
  styleSnapshot?: string;
  /** 文本卡：可点来源行（候选落卡：每条候选的背景出处，卡面渲染「来源」行）。
   *  上限 6 条，title 截 60 字，url 需 http(s)——协议校验在 sanitize 再兜一道 */
  links?: { title: string; url: string }[];
  /** 归属集 = 所属剧本卡 nodeId（一张剧本卡 = 一集）。缺省时若同批
   *  connect_nodes 把本卡连到某张卡上，自动从那张卡继承（见 applyOps） */
  episodeId?: string;
  /** 剧本卡：集号（1 起）。缺省时自动排到末尾（现有最大 + 1） */
  episodeNo?: number;
};

export type UpdateNodeOp = {
  op: "update_node";
  id: string;
  title?: string;
  body?: string;
  /** image/video/audio 卡生命周期状态（生成循环用） */
  status?: "loading" | "error" | "ready";
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  imageUrls?: string[];
  primaryIndex?: number;
  itemIds?: string[];
  locked?: boolean;
  errorMessage?: string;
  /** 分镜表：按 rid 更新单行（常用：镜头级出图回填 imageUrl / 挂镜头图卡） */
  row?: {
    rid: string;
    shotSize?: string;
    cameraMove?: string;
    duration?: string;
    action?: string;
    dialogue?: string;
    imageUrl?: string;
    /** 该行关联的镜头图卡 id（行缩略图读卡上的图；前端出图按钮同款语义） */
    imageNodeId?: string;
    /** 该行关联的镜头视频卡 id（图生视频产物；行内视频状态读卡实时数据） */
    videoNodeId?: string;
  };
  /** 分镜表：整表重写（agent 对话式「压缩到 N 行/重新生成」用），整组替换 */
  rows?: {
    rid?: string;
    shotSize?: string;
    cameraMove?: string;
    duration?: string;
    action?: string;
    dialogue?: string;
    lighting?: string;
    sound?: string;
    /** 引用资产名清单（agent 整表写回时带）：按画布资产卡精确标题匹配转 refIds */
    assets?: string[];
    imageUrl?: string;
  }[];
  /** research 卡：深度调研任务 id（补挂/修正用；建卡时必须带） */
  researchId?: string;
  /** storyboard 卡：镜号 / 景别 / 运镜 / 时长 / 台词 */
  shotNumber?: string;
  shotSize?: string;
  cameraMove?: string;
  duration?: string;
  dialogue?: string;
  /** 生成快照（补挂/修正用，字段同 add_node） */
  genPrompt?: string;
  genShot?: WingNodeData["genShot"];
  /** 角色卡：造型计划（拆解产出，label 必填；造型图据此出图并物化成卡） */
  looks?: WingNodeData["looks"];
  refIds?: string[];
  styleSnapshot?: string;
  /** 文本卡：可点来源行（补挂/修正用，字段同 add_node） */
  links?: { title: string; url: string }[];
  /** 归属集 = 所属剧本卡 nodeId（改归属/补挂用；传空串清空归属） */
  episodeId?: string;
  /** 剧本卡：集号（1 起，正整数；重排/纠正用） */
  episodeNo?: number;
};

export type DeleteNodesOp = {
  op: "delete_nodes";
  ids: string[];
};

export type ConnectNodesOp = {
  op: "connect_nodes";
  fromId: string;
  toId: string;
};

export type SetViewportOp = {
  op: "set_viewport";
  x: number;
  y: number;
  zoom?: number;
};

export type GroupNodesOp = {
  op: "group_nodes";
  /** 要收进分组的节点 id 列表 */
  ids: string[];
  title?: string;
};

export type CanvasOp =
  | AddNodeOp
  | UpdateNodeOp
  | DeleteNodesOp
  | ConnectNodesOp
  | SetViewportOp
  | GroupNodesOp;

export interface OpResult {
  applied: number;
  createdIds: string[];
  errors: string[];
}

export interface OpIssue {
  index: number;
  severity: "error" | "warning";
  message: string;
}

/** 集号校验：只认正整数（1 起）。错值明报，不静默丢弃（静默丢会让
 *   agent 以为「第 3 集」已生效、实际卡排在末尾）。 */
export function episodeNoIssue(
  op: { episodeNo?: number },
  index: number,
): OpIssue | null {
  const v = op.episodeNo;
  if (v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
    return {
      index,
      severity: "error",
      message: `episodeNo 必须是正整数（1 起），收到 "${String(v)}"`,
    };
  return null;
}

/** links 白名单整形（add_node/update_node 共用）：只收 http(s) 链接，
 *  截 6 条、title 60 字、url 500 字；非法项静默剔除（sanitize 装载时再兜一道）。
 *  返回 undefined 表示无有效 links，不写字段。 */
function sanitizeLinks(
  links: { title: string; url: string }[] | undefined,
): { links: { title: string; url: string }[] } | Record<string, never> {
  if (!Array.isArray(links)) return {};
  const clean = links
    .filter(
      (l): l is { title: string; url: string } =>
        !!l &&
        typeof l.title === "string" &&
        typeof l.url === "string" &&
        /^https?:\/\//i.test(l.url),
    )
    .slice(0, 6)
    .map((l) => ({ title: l.title.slice(0, 60), url: l.url.slice(0, 500) }));
  return clean.length > 0 ? { links: clean } : {};
}

/** looks 白名单整形（add_node/update_node 共用）：造型计划是角色卡的结构化
 *  数据（拆解产出，造型图据此出图）。label 必填否则整项剔除，description
 *  500 字、costume 60 字，最多 8 项。**不收 imageUrl/nodeId**——那是出图与
 *  物化流程回填的产物，agent 不该写。返回 {} 表示无有效 looks，不写字段。 */
function sanitizeLooks(
  looks: unknown,
): { looks: NonNullable<WingNodeData["looks"]> } | Record<string, never> {
  if (!Array.isArray(looks)) return {};
  const clean = looks
    .filter((l): l is Record<string, unknown> =>
      Boolean(l) && typeof l === "object",
    )
    .map((l) => {
      const label = String(l.label ?? "").trim().slice(0, 40);
      if (!label) return null;
      const item: NonNullable<WingNodeData["looks"]>[number] = { label };
      const description = String(l.description ?? "").trim();
      if (description) item.description = description.slice(0, 500);
      const costume = String(l.costume ?? "").trim();
      if (costume) item.costume = costume.slice(0, 60);
      const costumeId = String(l.costumeId ?? "").trim();
      if (costumeId) item.costumeId = costumeId.slice(0, 64);
      return item;
    })
    .filter((x): x is NonNullable<WingNodeData["looks"]>[number] => x !== null)
    .slice(0, 8);
  return clean.length > 0 ? { looks: clean } : {};
}

/** update_node 的造型计划合并：按 label 保留既有项的出图产物（imageUrl/
 *  nodeId/error）。agent 重写造型计划时会传全量 looks，若直接覆盖，已出图的
 *  造型会丢掉记账——轻则被当「待出」重复出图，重则 nodeId 丢失后装载时重建
 *  卡片。add_node 用 sanitizeLooks 即可（新卡没有既有项）。 */
function lookPatchMerged(
  existing: WingNodeData["looks"],
  incoming: unknown,
): { looks: NonNullable<WingNodeData["looks"]> } | Record<string, never> {
  const clean = sanitizeLooks(incoming);
  if (!("looks" in clean)) return {};
  const prev = new Map((existing ?? []).map((l) => [l.label, l]));
  return {
    looks: clean.looks.map((l) => {
      const old = prev.get(l.label);
      if (!old) return l;
      return {
        ...l,
        ...(old.imageUrl ? { imageUrl: old.imageUrl } : {}),
        ...(old.nodeId ? { nodeId: old.nodeId } : {}),
        ...(old.error ? { error: old.error } : {}),
      };
    }),
  };
}

/** 干跑校验（canvas_validate_ops 前端工具用；影策 validateCanvasOps 范式）：
 * 对着当前画布状态顺序推演整批 ops——后面的 delete 会正确移除前面 add 的
 * 占位节点、connect 查重、update 校验目标存在——返回 issues 不落画布。
 * 顺序敏感：与 applyOps 同序执行，同批内 add_node 带 id 的占位符可被
 * 后续 connect/update 引用（占位符即真实 id）。 */
export function validateOps(rawOps: unknown): {
  ok: boolean;
  issues: OpIssue[];
  operationCount: number;
} {
  const issues: OpIssue[] = [];
  const normErrors: string[] = [];
  const ops = normalizeOps(rawOps, normErrors);
  if (normErrors.length > 0)
    issues.push({ index: -1, severity: "error", message: normErrors.join("；") });

  const { nodes, edges } = useCanvasStore.getState();
  const liveIds = new Set(nodes.map((n) => n.id));
  const edgeKeys = new Set(edges.map((e) => `${e.source}\0${e.target}`));
  const assetTitles = new Set(
    nodes
      .filter((n) =>
        ["character", "scene", "prop", "costume"].includes(String(n.data.nodeType)),
      )
      .map((n) => (n.data.title ?? "").trim()),
  );
  const checkRowsAssets = (
    rows: { assets?: string[] }[] | undefined,
    index: number,
  ) => {
    if (!Array.isArray(rows)) return;
    const empties = emptyRowNumbers(rows);
    if (empties.length > 0)
      issues.push({
        index,
        severity: "error",
        message: `第 ${empties.join(",")} 行内容全空——疑似工具参数被截断，请整批重发`,
      });
    for (const name of rows.flatMap((r) => r.assets ?? []).filter(Boolean)) {
      if (!assetTitles.has(String(name).trim()))
        issues.push({
          index,
          severity: "warning",
          message: `行引用资产「${String(name)}」在画布上无同名资产卡（仅靠行文本全名兜底匹配）`,
        });
    }
  };

  ops.forEach((op, index) => {
    switch (op.op) {
      case "add_node": {
        if (!VALID_NODE_TYPES.includes(op.nodeType))
          issues.push({
            index,
            severity: "error",
            message: `add_node: nodeType 必须是 ${VALID_NODE_TYPES.join(" / ")}，收到 "${String(op.nodeType)}"`,
          });
        if (
          op.nodeType === "research" &&
          !String(op.researchId ?? "").trim()
        )
          issues.push({
            index,
            severity: "error",
            message:
              "add_node: 调研卡必须带 researchId（start_deep_research/confirm_research_plan 返回的 jobId）——卡面进度与「卷宗」按钮只认这个字段，写进正文不算",
          });
        if (op.id) {
          if (liveIds.has(op.id))
            issues.push({ index, severity: "error", message: `add_node: 节点 ${op.id} 已存在` });
          liveIds.add(op.id);
        }
        const addNoIssue = episodeNoIssue(op, index);
        if (addNoIssue) issues.push(addNoIssue);
        checkRowsAssets(op.rows, index);
        break;
      }
      case "update_node": {
        if (!liveIds.has(op.id))
          issues.push({
            index,
            severity: "error",
            message: `update_node: 节点 ${op.id} 不存在（引用同批新增节点要用 add_node 的 id 占位符）`,
          });
        const updNoIssue = episodeNoIssue(op, index);
        if (updNoIssue) issues.push(updNoIssue);
        checkRowsAssets(op.rows, index);
        break;
      }
      case "delete_nodes": {
        if (!Array.isArray(op.ids) || op.ids.length === 0)
          issues.push({ index, severity: "error", message: "delete_nodes: ids 不能为空" });
        for (const id of op.ids ?? []) {
          if (!liveIds.delete(id))
            issues.push({ index, severity: "error", message: `delete_nodes: 节点 ${id} 不存在` });
        }
        break;
      }
      case "connect_nodes": {
        if (!liveIds.has(op.fromId))
          issues.push({
            index,
            severity: "error",
            message: `connect_nodes: ${op.fromId} 不存在（add_node 带 id 占位符可同批引用）`,
          });
        if (!liveIds.has(op.toId))
          issues.push({
            index,
            severity: "error",
            message: `connect_nodes: ${op.toId} 不存在（add_node 带 id 占位符可同批引用）`,
          });
        if (op.fromId === op.toId)
          issues.push({ index, severity: "error", message: "connect_nodes: 不能连接节点自身" });
        const key = `${op.fromId}\0${op.toId}`;
        if (edgeKeys.has(key))
          issues.push({ index, severity: "error", message: `connect_nodes: ${op.fromId} → ${op.toId} 连线已存在` });
        edgeKeys.add(key);
        break;
      }
      case "group_nodes": {
        if (!Array.isArray(op.ids) || op.ids.length < 2)
          issues.push({ index, severity: "error", message: "group_nodes: 至少需要 2 个节点" });
        for (const id of op.ids ?? [])
          if (!liveIds.has(id))
            issues.push({ index, severity: "error", message: `group_nodes: 节点 ${id} 不存在` });
        break;
      }
      case "set_viewport": {
        if (
          typeof op.x !== "number" ||
          typeof op.y !== "number" ||
          !Number.isFinite(op.x + op.y)
        )
          issues.push({ index, severity: "error", message: "set_viewport: x/y 必须是数字" });
        break;
      }
    }
  });
  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues,
    operationCount: ops.length,
  };
}

const VALID_NODE_TYPES = Object.keys(NODE_META) as WingNodeType[];

/** 行内 assets 资产名 → 画布资产卡 id（精确标题匹配；对不上忽略——
 *  行文本全名兜底仍会命中，不在这里做模糊匹配误绑） */
function assetsToRefIds(names: string[]): string[] | undefined {
  const nodes = useCanvasStore.getState().nodes;
  const ids = names
    .map((name) =>
      nodes.find(
        (x) =>
          ["character", "scene", "prop", "costume"].includes(
            String(x.data.nodeType),
          ) && (x.data.title ?? "").trim() === name.trim(),
      )?.id,
    )
    .filter((id): id is string => Boolean(id));
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

/** 行内容全空（无任何字段也无 assets）的序号（1 起）——工具参数被截断的
 * 典型残骸：部分解析抢救出前几行完整对象 + 尾部空对象 */
function emptyRowNumbers(
  raw: {
    shotSize?: string;
    cameraMove?: string;
    duration?: string;
    action?: string;
    dialogue?: string;
    lighting?: string;
    sound?: string;
    assets?: string[];
    imageUrl?: string;
  }[],
): number[] {
  return raw
    .map((r, i) => ({ r, n: i + 1 }))
    .filter(
      ({ r }) =>
        !Array.isArray(r.assets) &&
        [r.shotSize, r.cameraMove, r.duration, r.action, r.dialogue, r.lighting, r.sound, r.imageUrl]
          .every((v) => v === undefined || String(v).trim() === ""),
    )
    .map(({ n }) => n);
}

/** 分镜行归一（add_node / update_node 的 rows 共用）：字段截断 + assets→refIds */
function normalizeRows(
  raw: {
    rid?: string;
    scene?: string;
    shotSize?: string;
    cameraMove?: string;
    duration?: string;
    action?: string;
    dialogue?: string;
    lighting?: string;
    sound?: string;
    assets?: string[];
    imageUrl?: string;
    imageNodeId?: string;
    videoNodeId?: string;
  }[],
  ridPrefix: string,
): { rows: ShotRow[]; emptyIdx: number[] } {
  const emptyIdx = emptyRowNumbers(raw);
  const rows = raw.slice(0, 60).map((r, i) => {
    const norm = {
      rid: String(r.rid ?? `${ridPrefix}${i + 1}`),
      ...(r.scene !== undefined ? { scene: String(r.scene).slice(0, 30) } : {}),
      ...(r.shotSize !== undefined ? { shotSize: String(r.shotSize).slice(0, 20) } : {}),
      ...(r.cameraMove !== undefined ? { cameraMove: String(r.cameraMove).slice(0, 20) } : {}),
      ...(r.duration !== undefined ? { duration: String(r.duration).slice(0, 20) } : {}),
      ...(r.action !== undefined ? { action: String(r.action).slice(0, 500) } : {}),
      ...(r.dialogue !== undefined ? { dialogue: String(r.dialogue).slice(0, 500) } : {}),
      ...(r.lighting !== undefined ? { lighting: String(r.lighting).slice(0, 30) } : {}),
      ...(r.sound !== undefined ? { sound: String(r.sound).slice(0, 30) } : {}),
      ...(Array.isArray(r.assets)
        ? { refIds: assetsToRefIds(r.assets.filter(Boolean).map(String)) }
        : {}),
      ...(r.imageUrl !== undefined ? { imageUrl: String(r.imageUrl) } : {}),
      ...(r.imageNodeId !== undefined
        ? { imageNodeId: String(r.imageNodeId).slice(0, 40) }
        : {}),
      ...(r.videoNodeId !== undefined
        ? { videoNodeId: String(r.videoNodeId).slice(0, 40) }
        : {}),
    };
    return norm;
  });
  return { rows, emptyIdx };
}

/** 批量自动排版的类型档位：资产四类各成一个组框（novanova 资产分组范式，
 *  与剧本卡拆解链路同款），其余类型共用一个无边框网格 */
const LAYOUT_KIND_ORDER: WingNodeType[] = [
  "character",
  "scene",
  "prop",
  "costume",
];

type BatchLayout = {
  /** 未带 position 的 add_node：op 在数组中的下标 → 落点坐标 */
  positions: Map<number, { x: number; y: number }>;
  /** 建完后要收进组框的类型（key=nodeType，值=该类型的 op 下标序） */
  groupedKinds: { type: WingNodeType; label: string; opIdx: number[] }[];
};

/** 批量建卡的自动排版计划（apply 前算好，循环里按下标取落点）：
 *  在现有内容下方开一条「资产带」——角色/场景/道具/服饰各一组框、组内
 *  √n 列网格（组框整块避让找空地，逐卡避让会散成一条横排——白骨精项目
 *  25 卡 8700px 横带事故）；非资产卡排在带尾的普通网格，不套框。
 *  agent 显式给了 position 的卡不参与（尊重精确摆位）。
 *  纯 note 批次（分集策划/系列方案这类成组文本卡）锚点续接到**最近一张
 *  note 卡正下方同列**——系列跨轮逐批建卡也自成一列（集序自上而下可读），
 *  不再沿全局内容的左缘斜向漂移（罪案策划0909 项目 11 卡斜跨 2700×2800
 *  无组框事故）；列位被占由 findFreePosition 避让。混合批次保持全局锚点
 *  （资产带语义不变） */
function planBatchLayout(ops: CanvasOp[]): BatchLayout {
  const positions = new Map<number, { x: number; y: number }>();
  const groupedKinds: BatchLayout["groupedKinds"] = [];
  const autoAdds = ops
    .map((op, i) => ({ op, i }))
    .filter(
      (x): x is { op: Extract<CanvasOp, { op: "add_node" }>; i: number } =>
        x.op.op === "add_node" && !x.op.position,
    );
  if (autoAdds.length === 0) return { positions, groupedKinds };

  const { nodes } = useCanvasStore.getState();
  // 带的锚点：现有内容包围盒下方（空画布放原点）。下方是中性空地——
  // 右侧会与「右侧渐新增卡」的直觉位打架，左侧压上游来向。
  // 纯 note 批次例外：接在最近一张 note 卡正下方（系列成列续排）
  const allNotes = autoAdds.every((a) => a.op.nodeType === "note");
  let anchor = { x: 0, y: 0 };
  if (allNotes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if ((n.data?.nodeType ?? n.type) !== "note") continue;
      const abs = absolutePosition(nodes, n);
      const size = nodeSize(n);
      anchor = { x: abs.x, y: abs.y + size.h + 44 };
      break;
    }
  } else if (nodes.length > 0) {
    const xs = nodes.map((n) => n.position.x);
    const ys = nodes.map((n) => n.position.y);
    anchor = {
      x: Math.min(...xs),
      y: Math.max(...ys) + 160,
    };
  }

  let groupLeft = anchor.x;
  let rowY = anchor.y;
  /** 建卡实际足迹：note 按正文实算（与 add_node 落卡尺寸同源）——布局
   *  格子必须与实际卡面同尺寸，否则长文 note 会压到邻卡身上 */
  const footprintOf = (op: Extract<CanvasOp, { op: "add_node" }>) =>
    op.nodeType === "note"
      ? noteFootprintFor(op.body ?? "", op.links?.length ?? 0)
      : (NODE_FOOTPRINT[op.nodeType] ?? NODE_FOOTPRINT.note);
  /** 混类型网格用批内最大占位做统一单元格（不同 footprint 逐卡错位会散） */
  const maxFootprint = (adds: Extract<CanvasOp, { op: "add_node" }>[]) => {
    const fps = adds.map(footprintOf);
    return {
      w: Math.max(...fps.map((f) => f.w)),
      h: Math.max(...fps.map((f) => f.h)),
    };
  };
  const placeGrid = (
    items: { i: number }[],
    origin: { x: number; y: number },
    cols: number,
    fp: { w: number; h: number },
  ) => {
    items.forEach((it, k) => {
      positions.set(it.i, {
        x: origin.x + (k % cols) * (fp.w + 60),
        y: origin.y + Math.floor(k / cols) * (fp.h + 54),
      });
    });
  };

  for (const kind of LAYOUT_KIND_ORDER) {
    const items = autoAdds.filter((a) => a.op.nodeType === kind);
    if (items.length === 0) continue;
    const fp = maxFootprint(items.map((it) => it.op));
    const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(items.length))));
    const kw = cols * (fp.w + 60) - 60;
    const kh = Math.ceil(items.length / cols) * (fp.h + 54) - 54;
    const origin = findFreePosition(
      useCanvasStore.getState().nodes,
      { x: groupLeft, y: rowY },
      { w: kw, h: kh },
    );
    items.forEach((it, k) => {
      positions.set(it.i, {
        x: origin.x + (k % cols) * (fp.w + 60),
        y: origin.y + Math.floor(k / cols) * (fp.h + 54),
      });
    });
    if (items.length >= 2)
      groupedKinds.push({
        type: kind,
        label: NODE_META[kind].label,
        opIdx: items.map((it) => it.i),
      });
    groupLeft = origin.x + kw + 80;
    rowY = Math.max(rowY, origin.y);
  }

  // 非资产卡：带尾普通网格（无边框——笔记/媒体等不是「一格一资产」的语义）
  const otherAdds = autoAdds.filter(
    (a) => !LAYOUT_KIND_ORDER.includes(a.op.nodeType),
  );
  if (otherAdds.length > 0) {
    const fp0 = maxFootprint(otherAdds.map((a) => a.op));
    const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(otherAdds.length))));
    const kw = cols * (fp0.w + 60) - 60;
    const kh = Math.ceil(otherAdds.length / cols) * (fp0.h + 54) - 54;
    const origin = findFreePosition(
      useCanvasStore.getState().nodes,
      { x: groupLeft, y: rowY },
      { w: kw, h: kh },
    );
    placeGrid(otherAdds.map((a) => ({ i: a.i })), origin, cols, fp0);
  }
  return { positions, groupedKinds };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 把外部（agent 传来的）未知数据归一成 CanvasOp 数组；非法项记入 errors */
export function normalizeOps(
  raw: unknown,
  errors: string[] = [],
): CanvasOp[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray((raw as { ops?: unknown }).ops)
      ? ((raw as { ops: unknown[] }).ops)
      : null;
  if (!list) {
    errors.push("ops 必须是数组（或 { ops: [...] }）");
    return [];
  }
  return list.filter((item, i): item is CanvasOp => {
    if (!isRecord(item) || typeof item.op !== "string") {
      errors.push(`#${i}: 缺少 op 字段`);
      return false;
    }
    return true;
  });
}

/** 校验并逐条应用；返回执行报告（handler 返回给 agent，render 卡片也用它）。
 * 注意：zustand 的 state 快照在循环外抓一次，同批前一条 add_node 插入的
 * 节点在快照里看不到——每条 op 必须实时取 state（同批「建卡即连线」
 * 曾因旧快照把真实存在的占位节点误报成不存在） */
export function applyOps(rawOps: unknown): OpResult {
  const errors: string[] = [];
  const ops = normalizeOps(rawOps, errors);
  // 未带 position 的 add_node 的排版计划（资产四类分组框 + 带尾网格）——
  // 先整批算好再进循环，循环里逐卡取落点；建完卡后按计划收组框
  const layout = planBatchLayout(ops);
  // 集归属继承：同批 connect_nodes 指向新建卡时，从源卡继承集（一张剧本卡
  // = 一集）。分镜表出图落卡 ops 正是这个形状（add_node 图卡 +
  // connect_nodes 分镜表→图卡）——agent 不必逐卡手写 episodeId
  const connectSources = new Map<string, string[]>();
  for (const op of ops) {
    if (op.op === "connect_nodes") {
      const list = connectSources.get(op.toId) ?? [];
      list.push(op.fromId);
      connectSources.set(op.toId, list);
    }
  }
  let applied = 0;
  const createdIds: string[] = [];
  // op 下标 → 建出的真实节点 id（收组框用；op.id 占位符或生成 id 都以
  // addNode 返回为准）
  const createdByIdx = new Map<number, string>();

  for (const [opIdx, op] of ops.entries()) {
    const live = useCanvasStore.getState();
    try {
      switch (op.op) {
        case "add_node": {
          if (!VALID_NODE_TYPES.includes(op.nodeType)) {
            errors.push(
              `add_node: nodeType 必须是 ${VALID_NODE_TYPES.join(" / ")}，收到 "${String(op.nodeType)}"`,
            );
            break;
          }
          if (
            op.id &&
            // 用实时 state 而非循环外的快照：同一批 ops 里同 id 出现两次时，
            // 快照看不到前一条刚插入的，会漏判造成重复 key
            useCanvasStore.getState().nodes.some((n) => n.id === op.id)
          ) {
            errors.push(`add_node: 节点 ${op.id} 已存在`);
            break;
          }
          // 调研卡硬闸（白骨精事故：id 写进正文、字段空缺 → 卡成死卡，
          // 40 来源 103 事实的卷宗在库里用户却什么都看不到）
          if (
            op.nodeType === "research" &&
            !String(op.researchId ?? "").trim()
          ) {
            errors.push(
              "add_node: 调研卡必须带 researchId（jobId 字段，不是正文文本）——缺了它卡面不显示进度、卷宗按钮无效，本 op 未应用",
            );
            break;
          }
          // rows 截断守卫：全空行 = 参数被截断的残骸，整 op 拒绝明报
          // （静默落半截表曾让 8 镜分镜只写入 3 行 + 1 行空壳）
          let rowsField: ShotRow[] | null = null;
          if (Array.isArray(op.rows)) {
            const norm = normalizeRows(op.rows, "r");
            if (norm.emptyIdx.length > 0) {
              errors.push(
                `add_node: 第 ${norm.emptyIdx.join(",")} 行内容全空——疑似工具参数被截断，本 op 未应用，请整批重发`,
              );
              break;
            }
            rowsField = norm.rows;
          }
          const pos = op.position ?? layout.positions.get(opIdx);
          if (!pos) {
            errors.push(
              `add_node: 排版计划缺位（nodeType=${String(op.nodeType)}）——内部错误，请整批重发`,
            );
            break;
          }
          // 批量建卡级联入场（对标影策 45ms 错峰；CSS 变量经节点 style 继承到卡片）
          const stagger = Math.min(createdIds.length, 12) * 50;
          // 集归属：显式 episodeId 优先；否则同批连线源卡继承（剧本卡=集，
          // 产物卡=源的集）——分镜表出图落卡 ops 靠这条自动挂到本集
          let episodeId = op.episodeId !== undefined ? op.episodeId.slice(0, 40) : undefined;
          if (episodeId === undefined && EPISODE_MEMBER_TYPES.has(op.nodeType) && op.id) {
            for (const sid of connectSources.get(op.id) ?? []) {
              const src = useCanvasStore.getState().nodes.find((n) => n.id === sid);
              const ep = inheritEpisodeId(src, op.nodeType);
              if (ep) {
                episodeId = ep;
                break;
              }
            }
          }
          const noIssue = episodeNoIssue(op, opIdx);
          if (noIssue) {
            errors.push(`add_node: ${noIssue.message}`);
            break;
          }
          // 建卡初始尺寸三来源必须合并成一个 style 对象（分开 spread 会互相
          // 覆盖）：分组框给显式默认（否则零尺寸不可见）；note 按正文实算
          // 尺寸（全文尽量可见，别挤在便签框里）；stagger 只加级联入场 CSS 变量
          const noteFp =
            op.nodeType === "note"
              ? noteFootprintFor(op.body ?? "", op.links?.length ?? 0)
              : null;
          const nodeStyle: CSSProperties = {
            ...(op.nodeType === "group" ? { width: 480, height: 360 } : {}),
            ...(noteFp ? { width: noteFp.w, height: noteFp.h } : {}),
            ...(stagger > 0
              ? ({ "--ws-stagger": `${stagger}ms` } as CSSProperties)
              : {}),
          };
          const id = live.addNode({
            id: op.id,
            position: pos,
            ...(Object.keys(nodeStyle).length ? { style: nodeStyle } : {}),
            data: {
              nodeType: op.nodeType,
              // 标题缺省留空：占位文案当真名会污染资产名单/@引用（agent
              // 建资产卡必须给业务名，不给就空着让用户命名）
              title: (op.title ?? "").slice(0, 80),
              body: op.body ?? "",
              ...(op.imageUrl !== undefined ? { imageUrl: op.imageUrl } : {}),
              ...(op.videoUrl !== undefined ? { videoUrl: op.videoUrl } : {}),
              ...(op.audioUrl !== undefined ? { audioUrl: op.audioUrl } : {}),
              ...(Array.isArray(op.imageUrls)
                ? { imageUrls: op.imageUrls.slice(0, 8).map(String) }
                : {}),
              ...(Array.isArray(op.itemIds)
                ? { itemIds: op.itemIds.slice(0, 20).map(String) }
                : {}),
              ...(op.locked !== undefined ? { locked: Boolean(op.locked) } : {}),
              ...(rowsField ? { rows: rowsField } : {}),
              ...(op.researchId !== undefined
                ? { researchId: op.researchId.slice(0, 40) }
                : {}),
              ...(op.shotNumber !== undefined
                ? { shotNumber: op.shotNumber.slice(0, 8) }
                : {}),
              ...(op.shotSize !== undefined
                ? { shotSize: op.shotSize.slice(0, 20) }
                : {}),
              ...(op.cameraMove !== undefined
                ? { cameraMove: op.cameraMove.slice(0, 20) }
                : {}),
              ...(op.duration !== undefined
                ? { duration: op.duration.slice(0, 20) }
                : {}),
              ...(op.dialogue !== undefined
                ? { dialogue: op.dialogue.slice(0, 500) }
                : {}),
              ...(op.status !== undefined ? { status: op.status } : {}),
              ...(op.genPrompt !== undefined
                ? { genPrompt: op.genPrompt.slice(0, 4000) }
                : {}),
              ...(op.genShot ? { genShot: op.genShot } : {}),
              ...(Array.isArray(op.refIds)
                ? { refIds: op.refIds.slice(0, 10).map(String) }
                : {}),
              ...(op.styleSnapshot !== undefined
                ? { styleSnapshot: op.styleSnapshot.slice(0, 300) }
                : {}),
              ...(sanitizeLinks(op.links)),
              ...(sanitizeLooks(op.looks)),
              ...(episodeId !== undefined ? { episodeId } : {}),
              // 集号：显式给了就带上，缺省由 store.addNode 自动排到末尾
              ...(op.episodeNo !== undefined ? { episodeNo: op.episodeNo } : {}),
            },
          });
          createdIds.push(id);
          createdByIdx.set(opIdx, id);
          applied += 1;
          break;
        }
        case "update_node": {
          const exists = live.nodes.some((n) => n.id === op.id);
          if (!exists) {
            errors.push(`update_node: 节点 ${op.id} 不存在`);
            break;
          }
          const updNoIssue = episodeNoIssue(op, opIdx);
          if (updNoIssue) {
            errors.push(`update_node: ${updNoIssue.message}`);
            break;
          }
          // rows 截断守卫：同 add_node（整表写回被截曾只落 3 行 + 空壳）
          let rowsField: ShotRow[] | null = null;
          if (Array.isArray(op.rows)) {
            const norm = normalizeRows(op.rows, "m");
            if (norm.emptyIdx.length > 0) {
              errors.push(
                `update_node: 第 ${norm.emptyIdx.join(",")} 行内容全空——疑似工具参数被截断，本 op 未应用，请整批重发`,
              );
              break;
            }
            rowsField = norm.rows;
          }
          live.updateNodeData(op.id, {
            ...(op.title !== undefined ? { title: op.title.slice(0, 80) } : {}),
            ...(op.body !== undefined ? { body: op.body.slice(0, 8000) } : {}),
            ...(op.status !== undefined ? { status: op.status } : {}),
            ...(op.imageUrl !== undefined ? { imageUrl: op.imageUrl } : {}),
            ...(op.videoUrl !== undefined ? { videoUrl: op.videoUrl } : {}),
            ...(op.audioUrl !== undefined ? { audioUrl: op.audioUrl } : {}),
            ...(Array.isArray(op.imageUrls)
              ? { imageUrls: op.imageUrls.slice(0, 8).map(String) }
              : {}),
            ...(op.primaryIndex !== undefined
              ? { primaryIndex: Math.max(0, Math.floor(op.primaryIndex)) }
              : {}),
            ...(Array.isArray(op.itemIds)
              ? { itemIds: op.itemIds.slice(0, 20).map(String) }
              : {}),
            ...(op.locked !== undefined ? { locked: Boolean(op.locked) } : {}),
            ...(rowsField ? { rows: rowsField } : {}),
            ...(op.researchId !== undefined
              ? { researchId: op.researchId.slice(0, 40) }
              : {}),
            ...(op.row && typeof op.row.rid === "string"
              ? {
                  rows: (() => {
                    const rows = [
                      ...(live.nodes.find((n) => n.id === op.id)?.data.rows ?? []),
                    ];
                    const i = rows.findIndex((r) => r.rid === op.row!.rid);
                    const patch = Object.fromEntries(
                      Object.entries(op.row!).filter(
                        ([k, v]) => k !== "rid" && v !== undefined,
                      ),
                    ) as Partial<(typeof rows)[number]>;
                    if (i >= 0) rows[i] = { ...rows[i], ...patch };
                    return rows;
                  })(),
                }
              : {}),
            ...(op.errorMessage !== undefined
              ? { errorMessage: op.errorMessage.slice(0, 300) }
              : {}),
            ...(op.shotNumber !== undefined
              ? { shotNumber: op.shotNumber.slice(0, 8) }
              : {}),
            ...(op.shotSize !== undefined
              ? { shotSize: op.shotSize.slice(0, 20) }
              : {}),
            ...(op.cameraMove !== undefined
              ? { cameraMove: op.cameraMove.slice(0, 20) }
              : {}),
            ...(op.duration !== undefined
              ? { duration: op.duration.slice(0, 20) }
              : {}),
            ...(op.dialogue !== undefined
              ? { dialogue: op.dialogue.slice(0, 500) }
              : {}),
            ...(op.genPrompt !== undefined
              ? { genPrompt: op.genPrompt.slice(0, 4000) }
              : {}),
            ...(op.genShot ? { genShot: op.genShot } : {}),
            ...(Array.isArray(op.refIds)
              ? { refIds: op.refIds.slice(0, 10).map(String) }
              : {}),
            ...(op.styleSnapshot !== undefined
              ? { styleSnapshot: op.styleSnapshot.slice(0, 300) }
              : {}),
            ...(sanitizeLinks(op.links)),
            ...(lookPatchMerged(
              live.nodes.find((n) => n.id === op.id)?.data.looks,
              op.looks,
            )),
            ...(op.episodeId !== undefined
              ? { episodeId: op.episodeId.slice(0, 40) }
              : {}),
            ...(op.episodeNo !== undefined ? { episodeNo: op.episodeNo } : {}),
          });
          applied += 1;
          break;
        }
        case "delete_nodes": {
          if (!Array.isArray(op.ids) || op.ids.length === 0) {
            errors.push("delete_nodes: ids 不能为空");
            break;
          }
          const known = op.ids.filter((id) =>
            live.nodes.some((n) => n.id === id),
          );
          if (known.length === 0) {
            errors.push(`delete_nodes: 节点 ${op.ids.join(",")} 均不存在`);
            break;
          }
          live.deleteNodes(known);
          applied += 1;
          break;
        }
        case "connect_nodes": {
          const has = (id: string) => live.nodes.some((n) => n.id === id);
          if (!has(op.fromId) || !has(op.toId)) {
            errors.push(
              `connect_nodes: ${op.fromId} 或 ${op.toId} 不存在（引用同批新建的节点时，add_node 要带 id 字段同值占位）`,
            );
            break;
          }
          const dup = live.edges.some(
            (e) => e.source === op.fromId && e.target === op.toId,
          );
          if (!dup) {
            live.connect({ source: op.fromId, target: op.toId });
          }
          applied += 1;
          break;
        }
        case "set_viewport": {
          if (
            typeof op.x !== "number" ||
            typeof op.y !== "number" ||
            !Number.isFinite(op.x + op.y)
          ) {
            errors.push("set_viewport: x/y 必须是数字");
            break;
          }
          live.setViewport({
            x: op.x,
            y: op.y,
            zoom:
              typeof op.zoom === "number" && op.zoom > 0
                ? Math.min(Math.max(op.zoom, 0.2), 2)
                : live.viewport.zoom,
          });
          applied += 1;
          break;
        }
        case "group_nodes": {
          if (!Array.isArray(op.ids) || op.ids.length === 0) {
            errors.push("group_nodes: ids 不能为空");
            break;
          }
          const known = op.ids.filter((id) =>
            live.nodes.some((n) => n.id === id),
          );
          if (known.length < 2) {
            errors.push("group_nodes: 至少需要 2 个存在的节点");
            break;
          }
          const gid = live.groupNodes(known, op.title?.slice(0, 40));
          if (gid) {
            createdIds.push(gid);
            applied += 1;
          }
          break;
        }
        default:
          errors.push(`未知 op: ${String((op as { op: string }).op)}`);
      }
    } catch (exc) {
      errors.push(`${(op as { op: string }).op} 执行异常: ${String(exc)}`);
    }
  }

  // 排版计划里的资产组框：建完卡后按类型收拢（组框 id 也进 createdIds，
  // agent 侧选中/闪烁整框而非散卡）。部分卡建失败（校验拒绝）时仍收剩余的
  const groupedIds: string[] = [];
  for (const g of layout.groupedKinds) {
    const ids = g.opIdx
      .map((i) => createdByIdx.get(i))
      .filter((id): id is string => Boolean(id));
    if (ids.length >= 2) {
      const gid = useCanvasStore.getState().groupNodes(ids, g.label);
      if (gid) groupedIds.push(gid);
    }
  }
  createdIds.push(...groupedIds);

  return { applied, createdIds, errors };
}
