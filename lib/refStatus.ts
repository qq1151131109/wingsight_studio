/**
 * 参考图调研的轻量状态总线（客户端缓存，不进 canvas store、不落库）：
 * - byNode：每资产候选计数（服务端 SQLite 一次汇总全项目），资产卡
 *   「N 张参考候选待选」徽标的数据源；调研/采纳/删除后 force 刷新。
 * - runningByBatch：批量调研进行中的资产节点 id（锚卡 useBatchRefJob
 *   轮询时同步写入），资产卡「调研中」状态的来源；锚卡卸载即冻结，
 *   重挂载续轮询后自动跟上。
 * refresh 自带 5s 节流 + 在途去重：资产卡随平移成批挂载也只打一发请求。
 */

import { create } from "zustand";

import { apiFetch } from "@/lib/auth";

export interface RefCandidateSummary {
  nodeId: string;
  total: number;
  adopted: number;
  recommended: number;
}

interface RefStatusState {
  byNode: Record<string, RefCandidateSummary>;
  runningByBatch: Record<string, string[]>;
  _loadedAt: number;
  _inflight: Promise<void> | null;
  refresh: (projectId: string, opts?: { force?: boolean }) => Promise<void>;
  setRunning: (batchId: string, nodeIds: string[]) => void;
  clearRunning: (batchId: string) => void;
}

export const useRefStatusStore = create<RefStatusState>((set, get) => ({
  byNode: {},
  runningByBatch: {},
  _loadedAt: 0,
  _inflight: null,
  refresh: (projectId, opts) => {
    if (!projectId) return Promise.resolve();
    const inflight = get()._inflight;
    if (inflight) return inflight;
    if (!opts?.force && Date.now() - get()._loadedAt < 5000) {
      return Promise.resolve();
    }
    const p = (async () => {
      try {
        const r = await apiFetch(
          `/agent-service/projects/${projectId}/refs/candidate-summary`,
        );
        if (r.ok) {
          const rows = (await r.json()) as RefCandidateSummary[];
          set({
            byNode: Object.fromEntries(rows.map((x) => [x.nodeId, x])),
            _loadedAt: Date.now(),
          });
        }
      } catch {
        // 服务重启/网络瞬断时静默：徽标保持旧值，下次 force 刷新自愈。
        // 不 catch 会变成未处理 rejection 炸到控制台（每张资产卡挂载都触发）
      } finally {
        set({ _inflight: null });
      }
    })();
    set({ _inflight: p });
    return p;
  },
  setRunning: (batchId, nodeIds) =>
    set((s) => ({ runningByBatch: { ...s.runningByBatch, [batchId]: nodeIds } })),
  clearRunning: (batchId) =>
    set((s) => {
      const next = { ...s.runningByBatch };
      delete next[batchId];
      return { runningByBatch: next };
    }),
}));
