"use client";

/**
 * 计划先行（对标 novanova onPlanTaskStatus / open-storyboard agentPlan）：
 *  - propose_plan：多步任务先把计划呈现给用户确认（内联计划卡，阻塞等待），
 *    确认后才逐步执行；拒绝则不执行、由 agent 问清要调整什么
 *  - update_plan：agent 每完成一步调它打勾——计划卡订阅 zustand store，
 *    勾选状态实时原地更新（不靠消息重渲染）
 *
 * 框架事实同 toolCards.tsx：propose_plan 是前端工具（available:"remote"），
 * 模型发起 → 本轮 END → 浏览器 handler 阻塞等确认 → ToolMessage 回传开新轮；
 * update_plan 同理，每步一次快速往返。planId 由 handler 铸造、经 ToolMessage
 * 回给模型，模型在 update_plan 里原样带回。
 */

import { create } from "zustand";
import { useCopilotAction } from "@copilotkit/react-core";
import { CheckCircle2, Circle, ClipboardList, CircleAlert } from "lucide-react";

// ---------- 计划状态（渲染与打勾的事实源） ----------

export interface PlanRecord {
  title: string;
  steps: string[];
  /** 已完成的最高步序号（1-based；0=未开始） */
  done: number;
  /** null=等确认 / true=已确认 / false=已暂缓 */
  confirmed: boolean | null;
}

interface PlanState {
  plans: Record<string, PlanRecord>;
  /** 最近一次提出的计划（propose_plan 执行中的卡片还没有 planId，用它兜底） */
  latestId: string | null;
  upsert: (id: string, title: string, steps: string[]) => void;
  settle: (id: string, ok: boolean) => void;
  markStep: (id: string, step: number) => boolean;
}

/** confirm 解析器不进响应式状态（卡片经 settle 间接触发） */
const resolvers = new Map<string, (ok: boolean) => void>();

export const usePlanStore = create<PlanState>()((set, get) => ({
  plans: {},
  latestId: null,
  upsert: (id, title, steps) =>
    set((s) => ({
      plans: { ...s.plans, [id]: { title, steps, done: 0, confirmed: null } },
      latestId: id,
    })),
  settle: (id, ok) => {
    const rec = get().plans[id];
    if (!rec || rec.confirmed !== null) return;
    set((s) => ({ plans: { ...s.plans, [id]: { ...rec, confirmed: ok } } }));
    resolvers.get(id)?.(ok);
    resolvers.delete(id);
  },
  markStep: (id, step) => {
    const rec = get().plans[id];
    if (!rec || !Number.isInteger(step) || step < 1 || step > rec.steps.length)
      return false;
    if (step > rec.done)
      set((s) => ({ plans: { ...s.plans, [id]: { ...rec, done: step } } }));
    return true;
  },
}));

/** propose_plan handler 用：登记计划并阻塞等用户在卡上点按钮 */
function requestPlanConfirm(
  id: string,
  title: string,
  steps: string[],
): Promise<boolean> {
  usePlanStore.getState().upsert(id, title, steps);
  return new Promise<boolean>((resolve) => {
    resolvers.set(id, resolve);
  });
}

function normalizeSteps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => (typeof s === "string" ? s.trim() : String((s as { title?: unknown })?.title ?? "").trim()))
    .filter(Boolean)
    .slice(0, 12);
}

// ---------- 计划卡 ----------

function PlanCard({
  status,
  argTitle,
  argSteps,
  resultText,
}: {
  status: string;
  argTitle: string;
  argSteps: string[];
  /** status=complete 时的 ToolMessage 文本（从中解析 planId） */
  resultText: string;
}) {
  const plans = usePlanStore((s) => s.plans);
  const latestId = usePlanStore((s) => s.latestId);
  const settle = usePlanStore((s) => s.settle);

  const resultId = /planId=([a-z0-9]+)/.exec(resultText)?.[1] ?? null;
  const rec = plans[resultId ?? latestId ?? ""];
  const steps = rec?.steps.length ? rec.steps : argSteps;
  const title = rec?.title || argTitle;
  const confirmed = rec?.confirmed ?? null;
  const done = rec?.done ?? 0;
  const awaitingConfirm = status !== "complete" && confirmed === null && steps.length > 0;

  let label = "执行计划";
  if (awaitingConfirm) label = "计划待确认";
  else if (confirmed === false) label = "已暂缓，未执行";
  else if (done >= steps.length && steps.length > 0) label = "计划已执行完";
  else if (confirmed) label = `执行中 · ${done}/${steps.length}`;

  return (
    <div className="my-1 rounded-lg border border-accent-soft bg-surface-1 px-3 py-2 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-text">
        <ClipboardList className="h-3.5 w-3.5 text-accent" />
        {label}：
        <span className="min-w-0 truncate">{title}</span>
      </p>
      <ol className="mt-1.5 space-y-1">
        {steps.map((s, i) => {
          const isDone = i < done;
          return (
            <li key={i} className="flex items-start gap-1.5 leading-relaxed">
              {isDone ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
              ) : (
                <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-4" />
              )}
              <span className={isDone ? "text-text-4 line-through" : "text-text-2"}>
                {i + 1}. {s}
              </span>
            </li>
          );
        })}
      </ol>
      {steps.length === 0 ? (
        <p className="mt-1 flex items-center gap-1 text-text-4">
          <CircleAlert className="h-3 w-3" /> 计划内容为空
        </p>
      ) : null}
      {awaitingConfirm ? (
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            onClick={() => settle(resultId ?? latestId ?? "", true)}
            className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
          >
            开始执行
          </button>
          <button
            type="button"
            onClick={() => settle(resultId ?? latestId ?? "", false)}
            className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1 text-[11px] text-text-2 transition-colors hover:text-text"
          >
            暂缓
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------- 工具注册 ----------

let planSeq = 0;

export default function PlanTools() {
  useCopilotAction({
    name: "propose_plan",
    description:
      "把多步任务的执行计划呈现给用户确认（卡片内联在聊天里，阻塞等用户点「开始执行」或「暂缓」）。" +
      "≥3 步的任务必须先出计划；用户确认前绝不执行任何步骤。",
    available: "remote",
    parameters: [
      {
        name: "title",
        type: "string",
        required: true,
        description: "计划标题（如「都市悬疑短片全链路」）",
      },
      {
        name: "steps",
        type: "string[]",
        required: true,
        description: "执行步骤列表，每步一句动词开头的短句（可独立验证是否完成），最多 12 步",
      },
    ],
    handler: async (args: { title?: unknown; steps?: unknown }) => {
      const title = String(args?.title ?? "").trim() || "执行计划";
      const steps = normalizeSteps(args?.steps);
      const id = `plan${Date.now().toString(36)}${++planSeq}`;
      const ok = await requestPlanConfirm(id, title, steps);
      return ok
        ? `用户已确认计划（planId=${id}）。现在按顺序执行：每完成一步就调用 update_plan(planId="${id}", step=步程序号) 打勾后再继续下一步；全部完成后简短汇报结果。`
        : `用户暂缓了这个计划（planId=${id}）。不要执行任何步骤；先简短问清用户想调整什么。`;
    },
    render: ({ status, args, result }) => (
      <PlanCard
        status={String(status)}
        argTitle={String((args as { title?: unknown })?.title ?? "").trim() || "执行计划"}
        argSteps={normalizeSteps((args as { steps?: unknown })?.steps)}
        resultText={typeof result === "string" ? result : ""}
      />
    ),
  });

  useCopilotAction({
    name: "update_plan",
    description:
      "计划被用户确认后，每完成一步调用它打勾（计划卡上的勾选会实时更新）。计划被暂缓时不要调用。",
    available: "remote",
    parameters: [
      {
        name: "planId",
        type: "string",
        required: true,
        description: "propose_plan 结果里返回的 planId",
      },
      {
        name: "step",
        type: "number",
        required: true,
        description: "刚完成的步骤序号（从 1 开始）",
      },
    ],
    handler: async (args: { planId?: unknown; step?: unknown }) => {
      const id = String(args?.planId ?? "");
      const step = Number(args?.step);
      const ok = usePlanStore.getState().markStep(id, step);
      return ok
        ? `已记录：第 ${step} 步完成。继续执行下一步。`
        : `计划不存在或步骤序号无效（planId=${id}, step=${step}）。直接继续执行，不要再调 update_plan。`;
    },
    render: () => <></>,
  });

  return null;
}
