"use client";

/**
 * 项目管理桥：
 *  - 路由激活：按 /project/[pid] 路由参数激活项目；无效则回退到列表第一个
 *  - 初始化：拉项目列表；无项目则建「默认项目」并迁移旧 localStorage 画布
 *  - 同步：画布变化 debounce 1.2s → PUT 服务端；同时写本地缓存（离线降级）
 *  - 离开工作台（组件卸载）时冲刷未落盘的 debounce 保存
 *  - localStorage 仅作每项目缓存（键含 projectId），服务端是唯一事实源
 */

import { useCallback, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { useCanvasStore } from "@/lib/canvas/store";
import { sanitizeCanvas } from "@/lib/canvas/sanitize";
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
    // 仅初始激活一次；项目内切换走 switch-project 事件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 项目切换（ActivityBar 快捷切换器） ----------
  const switchProject = useCallback(async (pid: string) => {
    const store = useCanvasStore.getState();
    // 先落盘当前项目
    if (store.projectId && store.hydrated) {
      await saveCanvas(store.projectId, {
        nodes: store.nodes,
        edges: store.edges,
        viewport: store.viewport,
        meta: { visualStyle: store.projectStyle },
        revision: store.rev > 0 ? store.rev : undefined,
      }).catch(() => undefined);
    }
    await activateProject({ id: pid, name: "", updated_at: "" });
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const pid = (e as CustomEvent<{ pid: string }>).detail?.pid;
      if (pid) void switchProject(pid);
    };
    window.addEventListener("wingsight:switch-project", handler);
    return () => window.removeEventListener("wingsight:switch-project", handler);
  }, [switchProject]);

  // ---------- 画布变化 → debounce 同步 ----------
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const viewport = useCanvasStore((s) => s.viewport);
  const projectStyle = useCanvasStore((s) => s.projectStyle);
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
        meta: { visualStyle: s.projectStyle },
        revision: s.rev > 0 ? s.rev : undefined,
      });
    }, SYNC_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [projectId, nodes, edges, viewport, projectStyle]);

  // ---------- 离开工作台：冲刷未落盘的修改 ----------
  useEffect(() => {
    return () => {
      if (!timer.current) return;
      const s = useCanvasStore.getState();
      if (s.projectId && s.hydrated) {
        if (useCanvasStore.getState().saveState === "conflict") return; // 冲突未处理前不自动覆盖
        void persist(s.projectId, {
          nodes: s.nodes,
          edges: s.edges,
          viewport: s.viewport,
          meta: { visualStyle: s.projectStyle },
          revision: s.rev > 0 ? s.rev : undefined,
        });
      }
    };
  }, []);

  return null;
}

/** 服务端 + 本地缓存双写（结果写入画布的保存状态指示器）。
 *  同文档保存串行化（对标 novanova save-scheduler）：链式排队防并发写竞态 */
let saveChain: Promise<unknown> = Promise.resolve();
async function persist(
  pid: string,
  payload: {
    nodes: unknown[];
    edges: unknown[];
    viewport: unknown;
    meta?: { visualStyle?: string };
    revision?: number;
    force?: boolean;
  },
) {
  const run = saveChain.then(async () => {
    // 冲突未处理前停止自动保存（避免反复 409 与静默覆盖）
    if (useCanvasStore.getState().saveState === "conflict" && !payload.force) return;
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
      const res = await saveCanvas(pid, clean);
      // 仅当仍在本项目时更新状态（快速切换项目不被旧请求覆盖）
      if (useCanvasStore.getState().projectId !== pid) return;
      if (res.conflict) {
        // 乐观锁命中：服务器有更新的画布。停止自动保存，等用户在底部坞选择
        // 「载入服务器版本」或「强制覆盖」
        useCanvasStore.getState().setSaveState("conflict");
        return;
      }
      if (res.ok) {
        useCanvasStore.setState({
          rev: res.revision ?? useCanvasStore.getState().rev,
          saveState: "saved",
        });
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
      if (clean.removedNodes || clean.removedEdges || clean.fixedParents) {
        console.warn(
          `[canvas] 装载消毒：剥离 ${clean.removedNodes} 个坏节点 / ${clean.removedEdges} 条坏连线 / ${clean.fixedParents} 个孤儿分组引用`,
        );
      }
      store.replaceCanvas(
        clean.nodes as never,
        clean.edges as never,
        (canvas.viewport ?? { x: 0, y: 0, zoom: 1 }) as never,
      );
      useCanvasStore.setState({
        projectStyle: String((canvas as { meta?: { visualStyle?: string } }).meta?.visualStyle ?? ""),
        rev: canvas.revision ?? 0,
      });
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
