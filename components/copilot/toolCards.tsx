"use client";

/**
 * 聊天流的结构化工具卡（open-ai-canvas AgentToolCard / AgentPendingToolCard 范式）：
 *  - BackendToolCards：给 7 个 LangGraph 后端工具注册 render-only 的同名 action，
 *    框架按工具名匹配 render（useRenderToolCall）即拦截 stock 灰盒——调用从
 *    "隐形/灰盒" 变成 带状态与结果摘要的卡片，长文本进 <details> 折叠
 *  - ApprovalCard：canvas_ops 破坏性操作的审批卡内联进聊天流（不再弹原生
 *    confirm）。挂起请求放 zustand store——聊天消息列表不会因桥组件重渲染，
 *    卡片必须自带订阅才能在用户看到的位置出现并可点击
 */

import { useState, type ReactNode } from "react";
import { create } from "zustand";
import { useCopilotAction } from "@copilotkit/react-core";
import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Palette,
  ListChecks,
  Loader2,
  Scissors,
  Search,
  ShieldAlert,
  Zap,
} from "lucide-react";
import { Lightbox } from "@/components/canvas/Lightbox";
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
    <div className="rounded-lg border border-accent-soft bg-surface-1 px-3 py-2 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-text">
        <ShieldAlert className="h-3.5 w-3.5 text-accent" strokeWidth={2} />
        允许助手修改画布？
      </p>
      <p className="mt-1 leading-relaxed text-text-2">{pending.summary}</p>
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={() => pending.resolve(true)}
          className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-[scale,opacity] duration-150 ease-out hover:opacity-90 active:not-disabled:scale-[0.96]"
        >
          允许执行
        </button>
        <button
          type="button"
          onClick={() => pending.resolve(false)}
          className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1 text-[11px] text-text-2 transition-[scale,background-color,border-color,color] duration-150 ease-out active:not-disabled:scale-[0.96] hover:text-text"
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
    <div
      // 会话内搜索跳过整个工具卡子树：搜索口径是「消息正文」，工具卡是 UI 部件
      // （结果 JSON/文件清单不是对话内容）。计数走数据源时天然不含它们，这里
      // 保持一致——避免「计数 12 却高亮 15 处」
      data-ws-toolcard="1"
      className="rounded-lg border border-hairline bg-surface-3 px-3 py-2 text-xs"
    >
      <div
        className={`flex items-center gap-1.5 font-medium ${
          ok === false ? "text-warn" : ok ? "text-good" : "text-text-2"
        }`}
      >
        {/* 三个分支必须同尺寸：中性分支此前是裸 <span>{icon}</span>，调用方又都传
            <X /> 不带 className，于是走 lucide 出厂 24px —— 实测渲染 24×24 而卡片
            标题只有 12px，卡高被撑到 61px，同列卡图标忽大忽小。另外该行是
            font-medium（500），按 better-ui 的表要 2 档笔画 */}
        {ok === false ? (
          <CircleAlert className="h-3.5 w-3.5" strokeWidth={2} />
        ) : ok ? (
          <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
        ) : (
          <span className="text-text-3 [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:stroke-2">{icon}</span>
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

/**
 * 过程类工具卡的单行紧凑形态（2026-09-12「满屏都是卡」走查）：读手册/查进度/
 * 发起调研这类过程调用只值一行——整卡 + 「详情」行让一轮 11 张卡占满整屏，
 * 有信息量的产物卡反而被淹没（ChatGPT「已搜索」/Claude 时间线同口径：过程收
 * 一行、产物才占卡）。仍保留「rounded-lg border bg-surface-3」卡类与
 * data-ws-toolcard 标记：前者让 globals.css 的「卡与卡堆叠 10px」间距规则照常
 * 命中（不然后卡顶槽变 0），后者让会话搜索继续跳过工具卡子树。
 * 标题即 <summary>：折叠=一行，展开=结果全文，不再单占一行「详情」。
 */
export function ToolCardSlim({
  icon,
  title,
  failed,
  detail,
}: {
  icon: ReactNode;
  title: string;
  /** true=该过程有失败语义，标题转警色（正常过程一律中性弱化，不打绿勾） */
  failed?: boolean;
  detail?: string;
}) {
  return (
    <details
      data-ws-toolcard="1"
      className="group rounded-lg border border-hairline bg-surface-3 px-2.5 py-1 text-xs text-text-3"
    >
      <summary className="flex cursor-pointer select-none list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden">
        <span
          className={`[&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:stroke-2 ${
            failed ? "text-warn" : "text-text-4"
          }`}
        >
          {icon}
        </span>
        <span className={`min-w-0 flex-1 truncate ${failed ? "font-medium text-warn" : ""}`}>
          {title}
        </span>
        {detail ? (
          <ChevronRight className="h-3 w-3 shrink-0 text-text-4 transition-transform duration-150 group-open:rotate-90" />
        ) : null}
      </summary>
      {detail ? (
        <div className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all border-t border-hairline-soft pt-1 text-[11px] leading-relaxed text-text-4">
          {detail}
        </div>
      ) : null}
    </details>
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
  // 设定图卡缩略图放大（Lightbox；曾只能新标签页开原图）
  const [zoom, setZoom] = useState<{ urls: string[]; index: number } | null>(null);
  useCopilotAction({
    name: "read_skill",
    // render-only：disabled=不转发给模型/不参与前端执行，只拦聊天里的调用渲染
    available: "disabled",
    render: ({ status, args, result }) => {
      const name = String((args as { name?: unknown })?.name ?? "");
      if (status !== "complete")
        return (
          <RunningRow
            icon={<ListChecks />}
            title={name ? `正在读取技能手册「${name}」` : "正在读取技能手册"}
          />
        );
      return (
        <ToolCardSlim
          icon={<ListChecks />}
          title={name ? `已读取技能手册「${name}」` : "已读取技能手册"}
          detail={typeof result === "string" ? result.slice(0, 400) : undefined}
        />
      );
    },
  });

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
                <button
                  key={u}
                  type="button"
                  data-tip="查看大图" aria-label="查看大图"
                  onClick={() => setZoom({ urls, index: urls.indexOf(u) })}
                  className="block shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-hairline transition-shadow hover:shadow-md"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={assetThumbUrl(u)} alt="设定图" className="h-16 w-24 bg-surface-2 object-contain" />
                </button>
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
        <ToolCardSlim
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
        <ToolCardSlim
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
        <ToolCardSlim
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
        <ToolCardSlim
          icon={<ListChecks />}
          title="已获取技能清单"
          detail={typeof result === "string" ? result : undefined}
        />
      ),
  });

  return (
    zoom ? (
      <Lightbox
        images={zoom.urls.map((u) => ({ src: u, title: "设定图" }))}
        index={zoom.index}
        onIndex={(i) => setZoom({ urls: zoom.urls, index: i })}
        onClose={() => setZoom(null)}
      />
    ) : null
  );
}
