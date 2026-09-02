"use client";

/**
 * 聊天流的结构化工具卡（open-ai-canvas AgentToolCard / AgentPendingToolCard 范式）：
 *  - BackendToolCards：给 6 个 LangGraph 后端工具注册 render-only 的同名 action，
 *    框架按工具名匹配 render（useRenderToolCall）即拦截 stock 灰盒——调用从
 *    "隐形/灰盒" 变成 带状态与结果摘要的卡片，长文本进 <details> 折叠
 *  - ApprovalCard：canvas_ops 破坏性操作的审批卡内联进聊天流（不再弹原生
 *    confirm）。挂起请求放 zustand store——聊天消息列表不会因桥组件重渲染，
 *    卡片必须自带订阅才能在用户看到的位置出现并可点击
 */

import type { ReactNode } from "react";
import { create } from "zustand";
import { useCopilotAction } from "@copilotkit/react-core";
import {
  CheckCircle2,
  CircleAlert,
  Palette,
  ListChecks,
  Loader2,
  Scissors,
  Search,
  ShieldAlert,
  Zap,
} from "lucide-react";
import { assetThumbUrl } from "@/lib/asset-thumb";

// ---------- 审批（canvas_ops 破坏性操作） ----------

interface PendingApproval {
  summary: string;
  resolve: (ok: boolean) => void;
}

interface ToolApprovalState {
  pending: PendingApproval | null;
  /** handler 调用：挂起并等用户在卡上点按钮（Promise 阻塞工具执行） */
  request: (summary: string) => Promise<boolean>;
}

export const useToolApproval = create<ToolApprovalState>()((set) => ({
  pending: null,
  request: (summary) =>
    new Promise<boolean>((resolve) => {
      set({
        pending: {
          summary,
          resolve: (ok) => {
            set({ pending: null });
            resolve(ok);
          },
        },
      });
    }),
}));

/** canvas_ops handler 里用：挂起审批，返回用户选择 */
export function requestToolApproval(summary: string): Promise<boolean> {
  return useToolApproval.getState().request(summary);
}

/** 审批卡：内联在 canvas_ops 执行中的工具卡位置（自带 store 订阅，可点击） */
export function ApprovalCard() {
  const pending = useToolApproval((s) => s.pending);
  if (!pending) return null;
  return (
    <div className="my-1 rounded-lg border border-accent-soft bg-surface-1 px-3 py-2 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-text">
        <ShieldAlert className="h-3.5 w-3.5 text-accent" />
        允许助手修改画布？
      </p>
      <p className="mt-1 leading-relaxed text-text-2">{pending.summary}</p>
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={() => pending.resolve(true)}
          className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
        >
          允许执行
        </button>
        <button
          type="button"
          onClick={() => pending.resolve(false)}
          className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1 text-[11px] text-text-2 transition-colors hover:text-text"
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

// ---------- 卡片骨架 ----------

export function ToolCard({
  icon,
  title,
  ok,
  detail,
  children,
}: {
  icon: ReactNode;
  title: string;
  /** undefined=成功中性展示；false=有失败项，标警色 */
  ok?: boolean;
  /** 长文本结果：折叠进「详情」 */
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <div className="my-1 rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-xs">
      <div
        className={`flex items-center gap-1.5 font-medium ${
          ok === false ? "text-warn" : ok ? "text-good" : "text-text-2"
        }`}
      >
        {ok === false ? (
          <CircleAlert className="h-3.5 w-3.5" />
        ) : ok ? (
          <CheckCircle2 className="h-3.5 w-3.5" />
        ) : (
          <span className="text-text-3">{icon}</span>
        )}
        <span className="min-w-0">{title}</span>
      </div>
      {children}
      {detail ? (
        <details className="mt-1 text-[11px] text-text-4">
          <summary className="cursor-pointer select-none">详情</summary>
          <div className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all leading-relaxed">
            {detail}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export function RunningRow({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-1.5 py-1 text-xs text-text-3">
      <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      <Loader2 className="h-3 w-3 motion-safe:animate-spin" />
      {title}…
    </div>
  );
}

// ---------- 参数/结果解析 ----------

function parseAssetsJson(raw: unknown): unknown[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 出图结果行里的图片 URL（✓ 行携带 image_url=...） */
function resultImageUrls(text: string): string[] {
  return [...text.matchAll(/image_url=(\S+)/g)]
    .map((m) => m[1])
    .filter((u) => u.startsWith("/"));
}

// ---------- 后端工具注册（render-only：不设 handler，不参与前端执行） ----------

export default function BackendToolCards() {
  useCopilotAction({
    name: "generate_asset_images",
    // render-only：disabled=不转发给模型/不参与前端执行，只拦聊天里的调用渲染
    available: "disabled",
    render: ({ status, args, result }) => {
      if (status !== "complete") {
        const n = parseAssetsJson((args as { assets_json?: unknown })?.assets_json).length;
        return (
          <RunningRow
            icon={<Palette />}
            title={n > 0 ? `正在生成 ${n} 项设定图（并发执行，每张约 1 分钟）` : "正在生成设定图"}
          />
        );
      }
      const text = typeof result === "string" ? result : "";
      const ok = (text.match(/✓/g) ?? []).length;
      const bad = (text.match(/✗/g) ?? []).length;
      const cancelled = /已取消 (\d+) 张/.exec(text)?.[1];
      const urls = resultImageUrls(text);
      return (
        <ToolCard
          icon={<Palette />}
          title={`设定图生成完成：成功 ${ok}${bad ? `，失败 ${bad}` : ""}${
            cancelled ? `，取消 ${cancelled}` : ""
          }`}
          ok={bad > 0 ? false : true}
          detail={text || undefined}
        >
          {urls.length > 0 ? (
            <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
              {urls.slice(0, 8).map((u) => (
                <a
                  key={u}
                  href={u}
                  target="_blank"
                  rel="noreferrer"
                  data-tip="查看原图" aria-label="查看原图"
                  className="block shrink-0 overflow-hidden rounded-md border border-hairline transition-shadow hover:shadow-md"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={assetThumbUrl(u)} alt="设定图" className="h-16 w-24 object-cover" />
                </a>
              ))}
            </div>
          ) : null}
        </ToolCard>
      );
    },
  });

  useCopilotAction({
    name: "decompose_script",
    // render-only：disabled=不转发给模型/不参与前端执行，只拦聊天里的调用渲染
    available: "disabled",
    render: ({ status, result }) =>
      status !== "complete" ? (
        <RunningRow icon={<Scissors />} title="正在拆解剧本，提取角色 / 场景 / 道具" />
      ) : (
        <ToolCard
          icon={<Scissors />}
          title="剧本拆解完成"
          detail={typeof result === "string" ? result : undefined}
        />
      ),
  });

  useCopilotAction({
    name: "run_langflow_skill",
    // render-only：disabled=不转发给模型/不参与前端执行，只拦聊天里的调用渲染
    available: "disabled",
    render: ({ status, args, result }) => {
      const skill = String((args as { skill?: unknown })?.skill ?? "");
      if (status !== "complete") {
        return <RunningRow icon={<Zap />} title={skill ? `正在执行技能「${skill}」` : "正在执行技能"} />;
      }
      return (
        <ToolCard
          icon={<Zap />}
          title={skill ? `技能「${skill}」执行完成` : "技能执行完成"}
          detail={typeof result === "string" ? result : undefined}
        />
      );
    },
  });

  useCopilotAction({
    name: "research_asset_references",
    // render-only：disabled=不转发给模型/不参与前端执行，只拦聊天里的调用渲染
    available: "disabled",
    render: ({ status, args, result }) => {
      const n = parseAssetsJson((args as { assets_json?: unknown })?.assets_json).length;
      if (status !== "complete") {
        return <RunningRow icon={<Search />} title={`正在发起参考图调研（${n} 项资产）`} />;
      }
      return (
        <ToolCard
          icon={<Search />}
          title={`参考图调研已发起（${n} 项资产，后台执行）`}
          detail={typeof result === "string" ? result : undefined}
        />
      );
    },
  });

  useCopilotAction({
    name: "get_reference_research_status",
    // render-only：disabled=不转发给模型/不参与前端执行，只拦聊天里的调用渲染
    available: "disabled",
    render: ({ status, result }) => {
      if (status !== "complete") {
        return <RunningRow icon={<ListChecks />} title="正在查询调研进度" />;
      }
      const text = typeof result === "string" ? result : "";
      return (
        <ToolCard
          icon={<ListChecks />}
          title={text.split("\n")[0]?.slice(0, 60) || "调研进度"}
          detail={text || undefined}
        />
      );
    },
  });

  useCopilotAction({
    name: "list_langflow_skills",
    // render-only：disabled=不转发给模型/不参与前端执行，只拦聊天里的调用渲染
    available: "disabled",
    render: ({ status, result }) =>
      status !== "complete" ? (
        <RunningRow icon={<ListChecks />} title="正在查询可用技能" />
      ) : (
        <ToolCard
          icon={<ListChecks />}
          title="已获取技能清单"
          detail={typeof result === "string" ? result : undefined}
        />
      ),
  });

  return null;
}
