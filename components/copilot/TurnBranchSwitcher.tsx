"use client";

/**
 * 「这一轮有 N 个版本」的 ‹ i/N › 切换器（ChatGPT/Claude 范式）。
 *
 * 两种动作语义都是「显示与模型上下文一起切」——服务端把会话头挪到目标版本的
 * checkpoint，再把那一版的答复回传（不重跑、不烧额度）：
 *  - 点 ‹ / ›：切到相邻版本；
 *  - 直接切到某一版：外层只暴露相邻箭头（行业共识不做下拉/树，Claude 与 ChatGPT
 *    都是两个箭头 + 计数）。
 *
 * 自动加载：组件挂载时按会话拉一次版本清单（store 内按 threadId 缓存，
 * 同会话多轮只拉一次）；重新生成/切换后由调用方 refresh。
 */
import { useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { langgraphAgent } from "@/app/agent-provider";
import { useChatBranches } from "@/lib/chat/branches";
import { useChatSession } from "@/lib/chat/session";
import { switchChatBranch } from "@/lib/projects";
import { showToast } from "@/lib/toast";

type Msg = { id?: string; role?: string; content?: unknown };

export default function TurnBranchSwitcher({ turnId }: { turnId: string }) {
  const threadId = useChatSession((s) => s.threadId);
  const versions = useChatBranches((s) => s.byTurn[turnId]);
  const refresh = useChatBranches((s) => s.refresh);

  useEffect(() => {
    if (!threadId) return;
    // 只在还没有这一轮数据时拉（同会话多轮共享一次请求）
    if (!useChatBranches.getState().byTurn[turnId]) void refresh(threadId);
  }, [threadId, turnId, refresh]);

  if (!threadId || !versions || versions.length < 2) return null;
  // 没有 active 版本（存档行还在、当前轮已不在历史里）时不渲染：把某一版
  // 谎报成「当前」比不显示更糟
  const curIdx = versions.findIndex((v) => v.active);
  if (curIdx < 0) return null;
  const cur = versions[curIdx];

  const go = async (target: number) => {
    const next = versions[target];
    if (!next) return;
    const msgs = (langgraphAgent.messages ?? []) as Msg[];
    // 本轮的界定：该轮用户消息（turnId）之后的全部消息 = 当前版本，切掉它
    const anchor = msgs.findIndex((m) => m.id === turnId);
    if (anchor < 0) {
      showToast("切换失败：本地历史里找不到这一轮，刷新后重试");
      return;
    }
    const abandoned: { id?: string; role?: string; content?: string }[] = [];
    for (let k = anchor + 1; k < msgs.length; k += 1) {
      if (msgs[k].role === "user") break;
      if (msgs[k].role === "assistant")
        abandoned.push({
          id: msgs[k].id,
          role: "assistant",
          content: String(msgs[k].content ?? ""),
        });
    }
    // 本轮的终点：下一条用户消息（本轮之后的消息要原样保留——早期实现只拼
    // 「前缀 + 目标版本」，把后面几轮整个丢了，还会被落库成事实）
    let turnEnd = msgs.length;
    for (let k = anchor + 1; k < msgs.length; k += 1) {
      if (msgs[k].role === "user") {
        turnEnd = k;
        break;
      }
    }
    if (turnEnd < msgs.length) {
      // 非末轮切换会让「界面还留着后面几轮」与「模型上下文已退回这一版」打架，
      // 上游只在末轮放切换器；真被调到这里就明报拦下，不静默造出不一致
      showToast("只能切换最后一轮的版本（更早轮次的分支切换需要整条分支模型）");
      return;
    }
    const back = await switchChatBranch(threadId, turnId, next.idx, abandoned);
    if (!back) {
      showToast("切换失败：服务端没能复原这一版，刷新后重试");
      return;
    }
    const restored = back.map((m) => ({
      id: m.id || `branch-${next.idx}-${Math.random().toString(36).slice(2, 8)}`,
      role: "assistant" as const,
      content: String(m.content ?? ""),
    }));
    langgraphAgent.setMessages?.([
      ...msgs.slice(0, anchor + 1),
      ...restored,
      ...msgs.slice(turnEnd),
    ] as never);
    void refresh(threadId);
  };

  return (
    <span
      className="ws-branch-nav"
      data-testid="chat-branch-nav"
      data-turn-id={turnId}
      data-branch-idx={cur?.idx ?? 0}
    >
      <button
        type="button"
        aria-label="上一个版本"
        data-track="chat.branchPrev"
        disabled={curIdx === 0}
        onClick={() => void go(curIdx - 1)}
        className="ws-branch-btn"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="tabular-nums text-[11px] text-text-4">
        {curIdx + 1}/{versions.length}
      </span>
      <button
        type="button"
        aria-label="下一个版本"
        data-track="chat.branchNext"
        disabled={curIdx === versions.length - 1}
        onClick={() => void go(curIdx + 1)}
        className="ws-branch-btn"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}
