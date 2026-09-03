"use client";

/**
 * 项目管理桥：
 *  - 路由激活：按 /project/[pid] 路由参数激活项目；无效则回退到列表第一个
 *  - 初始化：拉项目列表；无项目则建「默认项目」并迁移旧 localStorage 画布
 *  - 同步：画布变化 debounce 1.2s → PUT 服务端；同时写本地缓存（离线降级）
 *  - 离开工作台（组件卸载）时冲刷未落盘的 debounce 保存
 *  - localStorage 仅作每项目缓存（键含 projectId），服务端是唯一事实源
 */

import { useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { useCanvasStore } from "@/lib/canvas/store";
import { sanitizeCanvas } from "@/lib/canvas/sanitize";
import { saneImagegen } from "@/lib/imagegen";
import { showToast } from "@/lib/toast";
import {
  createProject,
  listProjects,
  loadCanvas,
  saveCanvas,
  type ProjectMeta,
} from "@/lib/projects";

const LEGACY_KEY = "wingsight-canvas";
const cacheKey = (pid: string) => `wingsight-canvas-${pid}`;
const SYNC_DEBOUNCE_MS = 1200;

export default function ProjectManager() {
  const projectId = useCanvasStore((s) => s.projectId);
  const params = useParams<{ pid?: string }>();
  const urlPid = params?.pid;

  // ---------- 初始化 / 迁移 / 按 URL 激活 ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let projects: ProjectMeta[] = await listProjects();
        if (cancelled) return;

        // 首次使用：建默认项目并迁移旧画布数据
        if (projects.length === 0) {
          const created = await createProject("默认项目");
          projects = [created];
          const legacy = readLegacyCanvas();
          if (legacy && (legacy.nodes?.length || legacy.edges?.length)) {
            await saveCanvas(created.id, {
              nodes: legacy.nodes ?? [],
              edges: legacy.edges ?? [],
              viewport: legacy.viewport ?? { x: 0, y: 0, zoom: 1 },
            });
          }
          if (cancelled) return;
        }

        // URL 指定的项目优先（首页点进来的）；不存在则回退第一个
        const target =
          (urlPid && projects.find((p) => p.id === urlPid)) || projects[0];
        await activateProject(target);
      } catch {
        // agent 服务不可达：降级用旧缓存（若有），页面仍可用
        useCanvasStore.getState().setSaveState("offline");
        const legacy = readLegacyCanvas();
        if (legacy) {
          useCanvasStore.getState().replaceCanvas(
            (legacy.nodes ?? []) as never,
            (legacy.edges ?? []) as never,
            (legacy.viewport ?? { x: 0, y: 0, zoom: 1 }) as never,
          );
          useCanvasStore.setState({ projectName: "（离线 · 服务未连接）" });
        } else {
          useCanvasStore.setState({
            hydrated: true,
            projectName: "（离线 · 服务未连接）",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 画布变化 → debounce 同步 ----------
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const viewport = useCanvasStore((s) => s.viewport);
  const projectStyle = useCanvasStore((s) => s.projectStyle);
  const imagegen = useCanvasStore((s) => s.imagegen);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!projectId || !useCanvasStore.getState().hydrated) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const s = useCanvasStore.getState();
      if (!s.projectId || !s.hydrated) return;
      void persist(s.projectId, {
        nodes: s.nodes,
        edges: s.edges,
        viewport: s.viewport,
        meta: { visualStyle: s.projectStyle, imagegen: s.imagegen },
      });
    }, SYNC_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [projectId, nodes, edges, viewport, projectStyle, imagegen]);

  // ---------- 离开工作台：冲刷未落盘的修改 ----------
  useEffect(() => {
    return () => {
      if (!timer.current) return;
      const s = useCanvasStore.getState();
      if (s.projectId && s.hydrated) {
        void persist(s.projectId, {
          nodes: s.nodes,
          edges: s.edges,
          viewport: s.viewport,
          meta: { visualStyle: s.projectStyle, imagegen: s.imagegen },
        });
      }
    };
  }, []);

  return null;
}

/** 服务端 + 本地缓存双写（结果写入画布的保存状态指示器）。
 *  同文档保存串行化（对标 novanova save-scheduler）：链式排队防并发写竞态。
 *  乐观锁（萧燕燕事故根治）：保存带 revision 做 CAS；409 = 别处先写过
 *  （另一窗口/agent），拉服务端最新做「服务端为基线 + 本地未保存编辑叠加」
 *  的节点级三方合并后重试一次——对方窗口的出图结果不再被本窗口的旧快照
 *  静默踩掉，本窗口刚做的编辑也不丢 */
let saveChain: Promise<unknown> = Promise.resolve();
/** 最近一次成功保存的净载荷（按项目）：409 合并的 base——本地与它不同
 *  的节点才是「本窗口改过的」，其余以服务端为准 */
let lastSaved: { pid: string; nodes: unknown[]; edges: unknown[] } | null = null;

function jsonKey(v: unknown): string {
  return JSON.stringify(v) ?? "null";
}

/** 节点级三方合并（open-ai-canvas mergeValue 的节点粒度版）：服务端为
 *  基线；本地与 lastSaved 有差异（改过/新建）的条目叠加；本地删掉的
 *  （lastSaved 有、本地无）从合并结果剔除。同节点双方都改仍后写胜——
 *  粒度止于节点，够挡住「旧快照整包踩掉出图结果」的事故形态 */
function mergeWithServer(
  server: { nodes: unknown[]; edges: unknown[] },
  local: { nodes: unknown[]; edges: unknown[] },
): { nodes: unknown[]; edges: unknown[] } {
  if (!lastSaved) return local; // 无基准可diff：保守用本地（force 语义）
  const baseNodes = new Map(lastSaved.nodes.map((n) => [jsonKey((n as { id?: unknown }).id), n]));
  const serverNodes = new Map(server.nodes.map((n) => [jsonKey((n as { id?: unknown }).id), n]));
  const localIds = new Set(local.nodes.map((n) => jsonKey((n as { id?: unknown }).id)));
  const out = new Map(serverNodes);
  for (const n of local.nodes) {
    const k = jsonKey((n as { id?: unknown }).id);
    // 本地未改（与 lastSaved 相同）→ 保留服务端版本（对方的新图/新内容）；
    // 本地改过/新建 → 本地胜（刚做的编辑不丢）
    if (baseNodes.get(k) !== undefined && jsonKey(baseNodes.get(k)) === jsonKey(n)) continue;
    out.set(k, n);
  }
  for (const k of baseNodes.keys()) {
    if (!localIds.has(k)) out.delete(k); // 本地删除的不再复活
  }
  const baseEdges = new Map(lastSaved.edges.map((e) => [jsonKey((e as { id?: unknown }).id), e]));
  const serverEdges = new Map(server.edges.map((e) => [jsonKey((e as { id?: unknown }).id), e]));
  const localEdgeIds = new Set(local.edges.map((e) => jsonKey((e as { id?: unknown }).id)));
  const outEdges = new Map(serverEdges);
  for (const e of local.edges) {
    const k = jsonKey((e as { id?: unknown }).id);
    if (baseEdges.get(k) !== undefined && jsonKey(baseEdges.get(k)) === jsonKey(e)) continue;
    outEdges.set(k, e);
  }
  for (const k of baseEdges.keys()) {
    if (!localEdgeIds.has(k)) outEdges.delete(k);
  }
  return { nodes: [...out.values()], edges: [...outEdges.values()] };
}

async function persist(
  pid: string,
  payload: {
    nodes: unknown[];
    edges: unknown[];
    viewport: unknown;
    meta?: { visualStyle?: string; imagegen?: { model: string; resolution: string } };
  },
) {
  const run = saveChain.then(async () => {
    // 会话瞬态（选中/拖拽中）不落盘：否则重载项目会恢复上次的旧选区
    const nodes = payload.nodes.map((n) => {
      if (!n || typeof n !== "object") return n;
      const rest = { ...(n as Record<string, unknown>) };
      delete rest.selected;
      delete rest.dragging;
      return rest;
    });
    const clean = { ...payload, nodes };
    useCanvasStore.getState().setSaveState("saving");
    try {
      localStorage.setItem(
        cacheKey(pid),
        JSON.stringify({ state: clean, version: 0 }),
      );
    } catch {
      /* 隐私模式等忽略 */
    }
    try {
      let sent = clean;
      let res = await saveCanvas(
        pid,
        clean,
        useCanvasStore.getState().canvasRevision ?? undefined,
      );
      // 409 合并重试（仅一次，防双窗口互踩死循环）：拉服务端最新，本地
      // 未保存编辑叠加其上再存；重试仍冲突就放弃本轮（下轮 debounce 再来）
      if (res.conflict) {
        const server = await loadCanvas(pid).catch(() => null);
        if (useCanvasStore.getState().projectId !== pid) return;
        if (server && server.revision != null) {
          const merged = mergeWithServer(
            { nodes: server.nodes, edges: server.edges },
            { nodes: clean.nodes, edges: clean.edges },
          );
          sent = { ...clean, ...merged };
          useCanvasStore.getState().replaceCanvas(
            merged.nodes as never,
            merged.edges as never,
            (useCanvasStore.getState().viewport ?? {
              x: 0,
              y: 0,
              zoom: 1,
            }) as never,
          );
          useCanvasStore.setState({ canvasRevision: server.revision });
          res = await saveCanvas(pid, sent, server.revision);
          if (res.ok) showToast("画布已在其他窗口修改，已自动合并（对方的生成结果已保留）");
        }
      }
      // 仅当仍在本项目时更新状态（快速切换项目不被旧请求覆盖）
      if (useCanvasStore.getState().projectId !== pid) return;
      if (res.ok) {
        useCanvasStore.getState().setSaveState("saved");
        if (res.revision != null) {
          useCanvasStore.setState({ canvasRevision: res.revision });
          lastSaved = { pid, nodes: sent.nodes, edges: sent.edges };
        }
      } else {
        useCanvasStore.getState().setSaveState("offline");
      }
    } catch {
      if (useCanvasStore.getState().projectId === pid) {
        useCanvasStore.getState().setSaveState("offline");
      }
    }
  });
  saveChain = run.catch(() => undefined);
  return run;
}

async function activateProject(p: ProjectMeta) {
  const store = useCanvasStore.getState();
  store.setProject(p.id, p.name);
  try {
    const canvas = await loadCanvas(p.id);
    if (canvas) {
      const clean = sanitizeCanvas(
        canvas.nodes as never,
        canvas.edges as never,
      );
      if (
        clean.removedNodes ||
        clean.removedEdges ||
        clean.fixedParents ||
        clean.fixedShotRefs ||
        clean.strippedTitles
      ) {
        console.warn(
          `[canvas] 装载消毒：剥离 ${clean.removedNodes} 个坏节点 / ${clean.removedEdges} 条坏连线 / ${clean.fixedParents} 个孤儿分组引用` +
            (clean.migratedLooks
              ? `；迁移 ${clean.migratedLooks} 张遗留 Look 图为独立卡片`
              : "") +
            (clean.fixedShotRefs
              ? `；为 ${clean.fixedShotRefs} 张存量镜头图补写参考`
              : "") +
            (clean.strippedTitles
              ? `；剥掉 ${clean.strippedTitles} 张存量卡的占位标题`
              : ""),
        );
      }
      store.replaceCanvas(
        clean.nodes as never,
        clean.edges as never,
        (canvas.viewport ?? { x: 0, y: 0, zoom: 1 }) as never,
      );
      // 乐观锁基准：装载时的服务端版本 + 本次装载快照（409 合并的 base）
      useCanvasStore.setState({
        projectStyle: String((canvas as { meta?: { visualStyle?: string } }).meta?.visualStyle ?? ""),
        canvasRevision: canvas.revision ?? null,
      });
      lastSaved = { pid: p.id, nodes: clean.nodes, edges: clean.edges };
      const meta = (canvas as { meta?: { imagegen?: unknown } }).meta;
      if (meta && "imagegen" in meta)
        useCanvasStore.setState({ imagegen: saneImagegen(meta.imagegen) });
      if (!p.name) {
        const list = await listProjects();
        const meta = list.find((x) => x.id === p.id);
        useCanvasStore.setState({ projectName: meta?.name ?? p.name });
      }
      return;
    }
  } catch {
    // 服务端读取失败 → 本地缓存
  }
  const cached = readCache(p.id);
  const cc = sanitizeCanvas(
    (cached?.nodes ?? []) as never,
    (cached?.edges ?? []) as never,
  );
  store.replaceCanvas(
    cc.nodes as never,
    cc.edges as never,
    (cached?.viewport ?? { x: 0, y: 0, zoom: 1 }) as never,
  );
  if (!p.name) useCanvasStore.setState({ projectName: "" });
}

function readLegacyCanvas():
  | { nodes?: unknown[]; edges?: unknown[]; viewport?: unknown }
  | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.state ?? parsed;
  } catch {
    return null;
  }
}

function readCache(pid: string):
  | { nodes?: unknown[]; edges?: unknown[]; viewport?: unknown }
  | null {
  try {
    const raw = localStorage.getItem(cacheKey(pid));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.state ?? parsed;
  } catch {
    return null;
  }
}
