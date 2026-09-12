"use client";

/**
 * run 级自动重试（2026-09-12 P0，对标 codex「Reconnecting n/m」范式）。
 *
 * 差距实证：一次 `net::ERR_INCOMPLETE_CHUNKED_ENCODING`（SSE 传输中断）就把
 * 整轮对话打成「本次响应出错」——业界三家标配自动重试（codex 流 5 次指数
 * 退避 + 连接级无限重试 + 传输降级；opencode HTTP 层 2 次；gemini-cli 10 次
 * 封顶），我们此前为零。
 *
 * 通道语义决定重试边界（不需要判状态码）：
 *  - **observable error 通道** = 传输层失败（fetch 拒绝、SSE 中途截断）——
 *    服务端还没给出语义结论，重试安全：LangGraph 从 checkpoint 续跑，已
 *    完成的工具不重执行，最多重跑未完成的那一步 LLM 调用。
 *  - **RUN_ERROR 事件** = 服务端已判定失败（如 DeepSeek 400，确定性错误）——
 *    走事件通道不走 error 通道，天然不重试，照常上错误横幅。
 *
 * 停止/卸载不重试：用户点停止（AbortError）与组件卸载的 abort 必须立即
 * 传播，重试它们等于拒绝停止。
 *
 * 重试前剥掉本次失败尝试的流式残片（run 开始后新出现的消息）：残片留着
 * 会与重试成功后同内容的新 id 消息重复成两条气泡；剥掉后界面回到 run 前
 * 状态，重连流式从头渲染（用户感知 = 「重连中」，与 codex 一致）。
 *
 * 回归：pnpm dlx tsx scripts/run-retry-test.mjs（纯函数）+ 浏览器 route
 * abort 首次 POST 的端到端（见 AGENTS.md 记录）。
 */

import { retry, timer } from "rxjs";
import type { AbstractAgent, MiddlewareFunction } from "@ag-ui/client";
import { showToast } from "@/lib/toast";

const MAX_RETRIES = 2; // 共 3 次尝试（首次 + 2 重连），codex 同档保守侧
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5_000;

/** 停止/卸载类错误不重试（重试它们 = 拒绝停止） */
export function isRetryableRunError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? "";
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/abort/i.test(name) || /abort|unmount/i.test(msg)) return false;
  return true;
}

/** 退避表：1s → 2s（封顶 5s）——本地/同机代理场景无需长退避 */
export function retryDelayMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
}

/** 纯函数：剥掉 run 之后新增的流式残片（重试前回到 run 前的消息面） */
export function keepBaselineMessages<T extends { id?: string }>(
  baselineIds: Set<string>,
  messages: T[],
): T[] {
  return messages.filter((m) => m.id == null || baselineIds.has(m.id));
}

/** 给 HttpAgent 挂 run 级重试中间件（须在快照稳定中间件之外层：错误在快照
 *  map 透传后才被 retry 接住，重连时快照中间件的 defer 链随之重发） */
export function attachRunRetry(agent: AbstractAgent): void {
  const middleware: MiddlewareFunction = (input, next) => {
    const baselineIds = new Set(
      (agent.messages as unknown as { id?: string }[])
        .map((m) => m.id)
        .filter((id): id is string => id != null),
    );
    return next.run(input).pipe(
      retry({
        count: MAX_RETRIES,
        delay: (err, attempt) => {
          if (!isRetryableRunError(err)) throw err;
          const current = agent.messages as unknown as { id?: string }[];
          const kept = keepBaselineMessages(baselineIds, current);
          if (kept.length !== current.length) {
            agent.setMessages(kept as never);
          }
          const delay = retryDelayMs(attempt);
          showToast(`连接中断，${Math.round(delay / 1000)} 秒后自动重连（第 ${attempt}/${MAX_RETRIES} 次）…`);
          console.warn(`[run-retry] 传输中断，${delay}ms 后第 ${attempt}/${MAX_RETRIES} 次重连`, err);
          return timer(delay);
        },
      }),
    );
  };
  agent.use(middleware);
}
