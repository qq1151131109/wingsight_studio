/**
 * 画布操作契约（ops）——Agent 写通道的统一入口。
 *
 * 参考影策 canvas_apply_ops 的指令集设计，适配 React Flow 数据模型：
 *   add_node / update_node / delete_nodes / connect_nodes / set_viewport
 *
 * 校验从严：未知 op、非法参数一律记入 errors，不中断整批执行。
 */

import {
  NODE_META,
  useCanvasStore,
  type WingNodeType,
} from "./store";
import type { CSSProperties } from "react";

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
  /** storyboard 卡：镜号 / 景别 / 运镜 / 时长（建卡时可直接带上） */
  shotNumber?: string;
  shotSize?: string;
  cameraMove?: string;
  duration?: string;
  /** storyboard 卡：台词 / 旁白 */
  dialogue?: string;
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
  /** 分镜表：按 rid 更新单行（常用：镜头级出图回填 imageUrl） */
  row?: {
    rid: string;
    shotSize?: string;
    cameraMove?: string;
    duration?: string;
    action?: string;
    dialogue?: string;
    imageUrl?: string;
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
  /** storyboard 卡：镜号 / 景别 / 运镜 / 时长 / 台词 */
  shotNumber?: string;
  shotSize?: string;
  cameraMove?: string;
  duration?: string;
  dialogue?: string;
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
        if (op.id) {
          if (liveIds.has(op.id))
            issues.push({ index, severity: "error", message: `add_node: 节点 ${op.id} 已存在` });
          liveIds.add(op.id);
        }
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

/** 分镜行归一（add_node / update_node 的 rows 共用）：字段截断 + assets→refIds */
function normalizeRows(
  raw: {
    rid?: string;
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
  ridPrefix: string,
) {
  return raw.slice(0, 60).map((r, i) => ({
    rid: String(r.rid ?? `${ridPrefix}${i + 1}`),
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
  }));
}

/** 自动布点：在已有节点包围盒右侧或初始位置放新节点，避免重叠 */
function autoPosition(): { x: number; y: number } {
  const { nodes } = useCanvasStore.getState();
  if (nodes.length === 0) return { x: 0, y: 0 };
  const maxX = Math.max(...nodes.map((n) => n.position.x));
  const sameCol = nodes.filter((n) => Math.abs(n.position.x - maxX) < 8);
  const maxY = Math.max(...sameCol.map((n) => n.position.y));
  const tooClose = sameCol.some((n) => n.position.y >= maxY - 8);
  return tooClose
    ? { x: maxX + 340, y: 0 }
    : { x: maxX, y: maxY + 220 };
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
  let applied = 0;
  const createdIds: string[] = [];

  for (const op of ops) {
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
          const pos = op.position ?? autoPosition();
          // 批量建卡级联入场（对标影策 45ms 错峰；CSS 变量经节点 style 继承到卡片）
          const stagger = Math.min(createdIds.length, 12) * 50;
          const id = live.addNode({
            id: op.id,
            position: pos,
            // agent 直接建空分组时给默认尺寸，否则零尺寸不可见
            ...(op.nodeType === "group"
              ? { style: { width: 480, height: 360 } }
              : {}),
            ...(stagger > 0
              ? {
                  style: { "--ws-stagger": `${stagger}ms` } as CSSProperties,
                }
              : {}),
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
              ...(Array.isArray(op.rows)
                ? { rows: normalizeRows(op.rows, "r") }
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
            },
          });
          createdIds.push(id);
          applied += 1;
          break;
        }
        case "update_node": {
          const exists = live.nodes.some((n) => n.id === op.id);
          if (!exists) {
            errors.push(`update_node: 节点 ${op.id} 不存在`);
            break;
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
            ...(Array.isArray(op.rows)
              ? { rows: normalizeRows(op.rows, "m") }
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

  return { applied, createdIds, errors };
}
