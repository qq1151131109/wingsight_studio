"use client";

/**
 * 后台任务事件流消费端（agent/eventbus.py → /api/v1/events/stream）。
 *
 * AG-UI 轮次流之外的常开通道，补上「任务跑完 agent 不会主动说话」的协议缺口：
 *  - 深度调研终态 → 翻译成 RESEARCH_TERMINAL_EVENT（复用 ResearchNotice 的
 *    人话浮条 + 瞬时消息；卡面轮询与事件流双源，去重在 ResearchNotice）
 *  - 调研类完成（deep_research / ref_research done）→ **自动续跑 agent**：
 *    以「（任务通知）」前缀的用户消息触发一轮 run，agent 主动汇报结果
 *    （Devin/Manus 范式：任务完成助手开口，不是等用户问）。节制三闸：
 *    页面可见 / 当前无 run 在跑 / 每个 job 只触发一次
 *  - 其余后台任务（分镜出图/拆解/审查/评审）→ 左下浮条通知即可
 *    （UI 触发的任务，结果落在卡上，不需要 agent 插话）
 */

import { useEffect, useRef, useState } from "react";
import { CircleAlert, CheckCircle2, X } from "lucide-react";
import { useCopilotChat } from "@copilotkit/react-core";
import {
  AGENT_AUTO_RUN_EVENT,
  RESEARCH_TERMINAL_EVENT,
  type AgentAutoRunDetail,
  type ResearchTerminalDetail,
} from "@/lib/canvas/events";
import {
  subscribeAgentEvents,
  type AgentJobEvent,
} from "@/lib/agent-events";
import { reconcileRefResearch } from "@/lib/canvas/refReconcile";
import { onRefCardsDeleted } from "@/lib/canvas/refDismiss";
import { unadoptRefCandidates } from "@/lib/ref-research";
import { useRefStatusStore } from "@/lib/refStatus";
import { useCanvasStore } from "@/lib/canvas/store";

/** 自动续跑消息的统一前缀（Sidebar 据此把气泡渲染成系统样式而非用户口吻） */
export const JOB_NOTICE_PREFIX = "（任务通知）";

/** 自动续跑执行桥：渲染在 ChatInput JSX 里（侧栏 chat context 内），
 *  消费 AGENT_AUTO_RUN_EVENT 并经槽位的 onSubmitMessage 发送（v2 自己构造
 *  Message 实例——appendMessage 吃裸对象会炸 isResultMessage，实测）。
 *  闸门在此：页面可见 / 当前无 run（isLoading 是本 context 的真信号）/
 *  忙时 8s 重试 ≤3 次。渲染为 null，只挂监听。 */
export function AutoRunBridge({ onSend }: { onSend?: (value: string) => void }): null {
  const { isLoading } = useCopilotChat();
  const isLoadingRef = useRef(isLoading);
  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    const send = (text: string) => {
      try {
        onSend?.(text);
      } catch (err) {
        console.error("[AutoRunBridge] 发送失败", err);
      }
    };
    const trySend = (detail: AgentAutoRunDetail, tries: number) => {
      // 页面不可见挂起等回来看；run 进行中 8s 后重试（上限 3 次）
      if (document.visibilityState !== "visible") {
        pending.set(detail.jobId, { detail, tries });
        return;
      }
      if (isLoadingRef.current) {
        if (tries >= 3) return;
        pending.set(detail.jobId, { detail, tries: tries + 1 });
        setTimeout(() => {
          const p = pending.get(detail.jobId);
          if (!p) return;
          pending.delete(detail.jobId);
          trySend(p.detail, p.tries);
        }, 8000);
        return;
      }
      pending.delete(detail.jobId);
      send(detail.text);
    };
    const pending = new Map<string, { detail: AgentAutoRunDetail; tries: number }>();
    const onAutoRun = (e: Event) => {
      const detail = (e as CustomEvent<AgentAutoRunDetail>).detail;
      if (!detail?.text || !detail.jobId) return;
      trySend(detail, 0);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      for (const [, p] of pending) trySend(p.detail, p.tries);
    };
    window.addEventListener(AGENT_AUTO_RUN_EVENT, onAutoRun);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(AGENT_AUTO_RUN_EVENT, onAutoRun);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [onSend]);
  return null;
}

function autoRunText(e: AgentJobEvent): string {
  if (e.kind === "ref_research") {
    return (
      `${JOB_NOTICE_PREFIX}参考图调研已完成（batch_id=${e.job_id}）：${e.summary}。` +
      "请用 get_reference_research_status 查询详情，用一两句话向我汇报各资产的采纳情况，" +
      "然后问我是否现在生成设定图。"
    );
  }
  return (
    `${JOB_NOTICE_PREFIX}深度调研「${e.title}」已完成` +
    `（源 ${e.sources_count ?? 0} · 事实 ${e.findings_count ?? 0}）。` +
    "请用 get_research_result 读取结果，给我 3-5 句要点汇报，" +
    "并提醒我可以在画布调研卡查看完整卷宗。"
  );
}

function noticeLine(e: AgentJobEvent): { ok: boolean; title: string; detail: string } | null {
  switch (e.kind) {
    case "ref_research":
      return { ok: e.status === "done", title: "参考图调研", detail: e.summary || e.status };
    case "shot_images":
      return { ok: e.status === "done", title: "分镜批量出图", detail: e.summary || e.status };
    case "decompose":
      return { ok: e.status === "done", title: "剧本拆解", detail: e.summary || e.status };
    case "script_review":
      return { ok: e.status === "done", title: `剧本审查「${e.title}」`, detail: e.summary || e.status };
    case "image_review":
      return { ok: e.status === "done", title: `图片评审「${e.title}」`, detail: e.summary || e.status };
    default:
      return null; // deep_research 的浮条归 ResearchNotice，这里不重复
  }
}

export default function TaskEvents() {
  const projectId = useCanvasStore((s) => s.projectId);
  // 自动续跑去重（每 job 只触发一次）；可见性/loading 闸在 AutoRunBridge
  const ranJobs = useRef<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ ok: boolean; title: string; detail: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 调研产物对账（打开项目时一次）：简报落资产卡 / 已采纳图物化成参考卡 /
  // 考证报告落报告卡。此前这些只在前端轮询窗口里写，agent 从聊天发起的调研
  // 没人写 batchId 锚 → 产物永远留在库里画布上看不见（见 refReconcile 注释）。
  // 等装载完成（hydration 前对账会把不属于当前画布的产物写进来）。
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const run = async (tries: number) => {
      if (cancelled) return;
      if (!useCanvasStore.getState().hydrated) {
        if (tries < 20) setTimeout(() => void run(tries + 1), 500);
        return;
      }
      try {
        const r = await reconcileRefResearch(projectId);
        if (r.refsCreated || r.report === "created") {
          console.info(
            `[调研对账] 参考卡 +${r.refsCreated} · 报告卡 ${r.report} · 简报 ${r.briefsWritten}`,
          );
        }
      } catch (err) {
        // 对账失败不拦任何事：下轮打开/调研完成事件会再试一次
        console.warn("[调研对账] 失败，下次打开项目重试", err);
      }
    };
    void run(0);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // 删掉考据参考卡 = 这张参考不要了：去服务端取消采纳，否则下次打开项目
  // 对账又会把它建回来（store 只广播事件，见 lib/canvas/refDismiss.ts）
  useEffect(() => {
    if (!projectId) return;
    return onRefCardsDeleted((drops) => {
      const byNode = new Map<string, string[]>();
      for (const d of drops) {
        byNode.set(d.assetNodeId, [...(byNode.get(d.assetNodeId) ?? []), d.candidateId]);
      }
      void Promise.all(
        [...byNode.entries()].map(([nodeId, ids]) =>
          unadoptRefCandidates(projectId, nodeId, ids)
            .then(() =>
              useRefStatusStore.getState().refresh(projectId, { force: true }),
            )
            .catch((err) => console.warn("[参考卡] 取消采纳失败", nodeId, err)),
        ),
      );
    });
  }, [projectId]);

  useEffect(() => {
    const requestAutoRun = (e: AgentJobEvent) => {      if (ranJobs.current.has(e.job_id)) return;
      ranJobs.current.add(e.job_id);
      window.dispatchEvent(
        new CustomEvent(AGENT_AUTO_RUN_EVENT, { detail: { text: autoRunText(e), jobId: e.job_id } }),
      );
    };

    const handle = (e: AgentJobEvent) => {
      // 事件不带 project_id（历史调用点）或与本画布同项目才处理
      if (e.project_id && projectId && e.project_id !== projectId) return;
      if (e.kind === "deep_research") {
        // 卡面锚 researchId → 定位节点；卡已删时仍自动续跑（卷宗还在库里）
        const node = useCanvasStore
          .getState()
          .nodes.find((n) => (n.data as { researchId?: string } | undefined)?.researchId === e.job_id);
        if (node) {
          const detail: ResearchTerminalDetail = {
            nodeId: node.id,
            jobId: e.job_id,
            title: e.title,
            status: (e.status === "interrupted" ? "interrupted" : e.status) as ResearchTerminalDetail["status"],
            error: e.error ?? "",
            sourcesCount: e.sources_count ?? 0,
            findingsCount: e.findings_count ?? 0,
          };
          window.dispatchEvent(new CustomEvent(RESEARCH_TERMINAL_EVENT, { detail }));
        }
        if (e.status === "done") requestAutoRun(e);
        return;
      }
      if (e.kind === "ref_research" && e.status === "done") {
        // 先对账再续跑：让 agent 汇报时画布上报告卡/参考卡已经就位（汇报里
        // 说的产物用户看得到）；对账失败不拦续跑
        reconcileRefResearch(projectId ?? "").catch((err) => {
          console.warn("[调研对账] 失败，下次打开项目重试", err);
        });
        requestAutoRun(e);
      }
      const line = noticeLine(e);
      if (!line) return;
      setNotice(line);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setNotice(null), 12000);
    };

    const unsubscribe = subscribeAgentEvents(handle);
    // dev/headless E2E 注入口（浏览器侧无法伪造 SSE 帧，从此处进同一条链路）
    (window as unknown as { __wsJobEvent?: (e: AgentJobEvent) => void }).__wsJobEvent = handle;
    return () => {
      unsubscribe();
      delete (window as unknown as { __wsJobEvent?: unknown }).__wsJobEvent;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [projectId]);

  if (!notice) return null;
  const Icon = notice.ok ? CheckCircle2 : CircleAlert;
  return (
    <div
      className="ws-toast-in fixed bottom-16 left-4 z-[1250] flex max-w-[340px] items-center gap-2 rounded-xl bg-surface-1 px-3 py-2.5 ws-elev-popover"
      data-testid="task-events-notice"
    >
      <Icon className={`h-4 w-4 shrink-0 ${notice.ok ? "text-good" : "text-warn"}`} strokeWidth={2} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-text">
          {notice.ok ? "" : "失败 · "}
          {notice.title}
        </div>
        <div className="truncate text-[10px] text-text-3">{notice.detail}</div>
      </div>
      <button
        type="button"
        aria-label="关闭通知"
        data-tip="关闭"
        className="shrink-0 rounded-md p-1.5 text-text-4 transition-[scale,background-color,border-color,color] duration-150 ease-out hover:bg-surface-2 hover:text-text-2 active:not-disabled:scale-[0.96]"
        onClick={() => setNotice(null)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
