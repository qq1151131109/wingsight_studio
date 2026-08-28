"use client";

/**
 * 项目管理桥：
 *  - 初始化：拉项目列表；无项目则建「默认项目」并迁移旧 localStorage 画布
 *  - 同步：画布变化 debounce 1.2s → PUT 服务端；同时写本地缓存（离线降级）
 *  - localStorage 仅作每项目缓存（键含 projectId），服务端是唯一事实源
 */

import { useCallback, useEffect, useRef } from "react";
import { useCanvasStore } from "@/lib/canvas/store";
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

  // ---------- 初始化 / 迁移 ----------
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

        await activateProject(projects[0]);
      } catch {
        // agent 服务不可达：降级用旧缓存（若有），页面仍可用
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
     
  }, []);

  // ---------- 项目切换 ----------
  const switchProject = useCallback(async (pid: string) => {
    const store = useCanvasStore.getState();
    // 先落盘当前项目
    if (store.projectId && store.hydrated) {
      await saveCanvas(store.projectId, {
        nodes: store.nodes,
        edges: store.edges,
        viewport: store.viewport,
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!projectId || !useCanvasStore.getState().hydrated) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const s = useCanvasStore.getState();
      if (!s.projectId || !s.hydrated) return;
      const payload = { nodes: s.nodes, edges: s.edges, viewport: s.viewport };
      // 本地缓存（离线降级用）
      try {
        localStorage.setItem(
          cacheKey(s.projectId),
          JSON.stringify({ state: payload, version: 0 }),
        );
      } catch {
        /* 隐私模式等忽略 */
      }
      void saveCanvas(s.projectId, payload).catch(() => undefined);
    }, SYNC_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [projectId, nodes, edges, viewport]);

  return null;
}

async function activateProject(p: ProjectMeta) {
  const store = useCanvasStore.getState();
  store.setProject(p.id, p.name);
  try {
    const canvas = await loadCanvas(p.id);
    if (canvas) {
      store.replaceCanvas(
        canvas.nodes as never,
        canvas.edges as never,
        (canvas.viewport ?? { x: 0, y: 0, zoom: 1 }) as never,
      );
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
  store.replaceCanvas(
    (cached?.nodes ?? []) as never,
    (cached?.edges ?? []) as never,
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
