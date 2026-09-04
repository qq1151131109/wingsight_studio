"use client";

/**
 * 聊天侧栏（CopilotKit v2 官方 UI 壳）：
 *  - v2 CopilotSidebar（@copilotkit/react-core/v2，与 v1 Provider 双 context 共存）：
 *    Streamdown 流式 markdown、消息悬浮工具栏（复制/重试/赞踩）、工具调用卡、
 *    打字光标等全部用官方内置——不再手搓 CSS 精修 stock DOM
 *  - v1 数据层零改动：useCopilotAction（工具卡/计划卡）经官方兼容层注册进
 *    v2 renderToolCalls，消息流里照常可见
 *  - 自定义面经 slot 接入：header=ThreadsBar（会话/导出/关闭）、
 *    input=ChatInput（@ 引用/附件/任务条）、suggestionView=空态建议 chips
 *  - 运行错误：v2 onError → session store，横幅人话 + 重试本轮
 *  - 主题：v2 的 shadcn 式语义变量在 globals.css 里整体映射到米黄纸感 token
 */

import { useEffect, useMemo, useRef } from "react";
import {
  CopilotSidebar,
  useConfigureSuggestions,
  useCopilotChatConfiguration,
  type CopilotModalHeader,
  type CopilotChatInput,
  type CopilotChatToggleButton,
  type CopilotChatSuggestionView,
} from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { Sparkles } from "lucide-react";
import ChatInput from "./ChatInput";
import CapabilitiesDialog from "./CapabilitiesDialog";
import { useChatSession } from "@/lib/chat/session";
import ChatSidebarHeader from "./ThreadsBar";

/** slot 槽位支持整组件替换（运行时 renderSlot 认任意函数组件），但 d.ts 要求
 *  带静态成员的组件类型——自绘组件按原类型断言收口 */
function asSlot<C>(component: unknown): C {
  return component as C;
}

/** 空渲染（用于从工具栏里摘掉某个内置按钮） */
function NullSlot(): null {
  return null;
}

/** 侧栏宽度记忆键（拖拽内缘调宽，globals.css 的 --sidebar-width 同源） */
const WS_WIDTH_KEY = "wingsight_sidebar_width";

const SUGGESTIONS = [
  {
    title: "✍️ 建个剧本卡",
    message: "创建一个剧本卡：写一个 90 秒都市悬疑短片的梗概，标题自拟。",
  },
  {
    title: "🎭 拆解剧本出设定图",
    message: "把画布上的剧本拆解成角色和场景资产清单，建卡后为它们生成设定图。",
  },
  {
    title: "🎬 拆整表分镜",
    message: "把画布上的剧本拆成 20 镜的标准分镜表，写回分镜表卡。",
  },
  {
    title: "📣 写宣发文案",
    message: "为画布上的剧本写一版抖音宣发文案，6 条，带话题标签。",
  },
  {
    title: "🧹 整理画布",
    message: "把画布上的卡片按类型分组整理并连好关系，最后调整视口让我看全。",
  },
];

/** 空态建议：v2 建议槽位替换（对话开始后隐藏，依据 = session hasMessages） */
function EmptyStateSuggestions({
  suggestions,
  onSelectSuggestion,
}: {
  suggestions: { title: string; message: string }[];
  onSelectSuggestion?: (s: { title: string; message: string }) => void;
}) {
  const hasMessages = useChatSession((s) => s.hasMessages);
  if (hasMessages || suggestions.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-1.5 px-1 pt-2">
      {suggestions.map((s) => (
        <button
          key={s.title}
          type="button"
          data-tip={s.message} aria-label={s.message}
          onClick={() => onSelectSuggestion?.(s)}
          className="rounded-lg border border-hairline bg-surface-2 px-2.5 py-2 text-left text-xs leading-snug text-text-2 transition-colors hover:border-accent-soft hover:bg-surface-1 hover:text-text"
        >
          {s.title}
        </button>
      ))}
    </div>
  );
}

/** 关闭态的"助手"显性入口（v2 toggleButton 槽位；开着时让位给 Header 关闭钮） */
function AssistantFab() {
  const config = useCopilotChatConfiguration();
  if (config?.isModalOpen !== false) return null;
  return (
    <button
      type="button"
      onClick={() => config?.setModalOpen(true)}
      data-tip="打开画布助手" aria-label="打开画布助手"
      className="fixed right-4 top-14 z-40 flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-2 text-xs font-medium text-white shadow-md transition-opacity hover:opacity-90"
    >
      <Sparkles className="h-3.5 w-3.5" />
      助手
    </button>
  );
}

export default function ThemedSidebar() {
  // 空态建议喂进 v2 core（视图经 suggestionView 槽位消费）
  const suggestionsConfig = useMemo(() => ({ suggestions: SUGGESTIONS }), []);
  useConfigureSuggestions(suggestionsConfig);

  // 侧栏内缘拖拽调宽：改 --ws-chat-w（globals.css 骨架优先读它、以 v2 自带的
  // --sidebar-width 兜底——v2 把该变量设在 aside 元素上，root 同名会被遮蔽），
  // localStorage 记忆；命令式 DOM 操作不走 React 状态
  const resizerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const saved = window.localStorage.getItem(WS_WIDTH_KEY);
    if (saved) {
      document.documentElement.style.setProperty("--ws-chat-w", saved);
      // 侧栏常驻 DOM（关闭仅 aria-hidden），稍等首帧后还原内联宽度
      const t = window.setTimeout(() => {
        (document.querySelector("aside.copilotKitSidebar") as HTMLElement | null)
          ?.style.setProperty("width", saved, "important");
      }, 400);
      return () => window.clearTimeout(t);
    }
    const el = resizerRef.current;
    if (!el) return;
    const clamp = (w: number) =>
      Math.min(Math.max(w, 340), Math.min(760, window.innerWidth * 0.95));
    // v2 经 adopted stylesheet 打的 !important 宽度规则会吃掉任何文档层
    // 选择器（特异性提档也没用）；内联 !important 是唯一稳定赢面（实测），
    // 同时写 root 变量让 .ws-chat-resizer 条同步贴边
    const apply = (w: number) => {
      const px = `${Math.round(w)}px`;
      document.documentElement.style.setProperty("--ws-chat-w", px);
      (document.querySelector("aside.copilotKitSidebar") as HTMLElement | null)
        ?.style.setProperty("width", px, "important");
    };
    let dragging = false;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      el.classList.add("dragging");
      el.setPointerCapture(e.pointerId);
      apply(clamp(window.innerWidth - e.clientX));
    };
    const onMove = (e: PointerEvent) => {
      if (dragging) apply(clamp(window.innerWidth - e.clientX));
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove("dragging");
      el.releasePointerCapture(e.pointerId);
      const w = clamp(window.innerWidth - e.clientX);
      apply(w);
      window.localStorage.setItem(WS_WIDTH_KEY, `${Math.round(w)}px`);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, []);

  return (
    <div className="contents">
      <div ref={resizerRef} className="ws-chat-resizer" aria-hidden="true" />
      <CopilotSidebar
        agentId="default"
        defaultOpen={false}
        position="right"
        width={420}
        labels={{
          modalHeaderTitle: "Wingsight 助手",
          welcomeMessageText: "你好，我是画布助手。可以让我建卡片、连角色和剧本，或调用宣发 / 资产出图技能。",
          chatInputPlaceholder: "问点什么…",
          assistantMessageToolbarCopyMessageLabel: "复制",
          assistantMessageToolbarRegenerateLabel: "重新生成",
          assistantMessageToolbarThumbsUpLabel: "回答不错",
          assistantMessageToolbarThumbsDownLabel: "回答不佳",
          userMessageToolbarCopyMessageLabel: "复制",
          chatDisclaimerText: "",
        }}
        header={asSlot<typeof CopilotModalHeader>(ChatSidebarHeader)}
        input={asSlot<typeof CopilotChatInput>(ChatInput)}
        toggleButton={asSlot<typeof CopilotChatToggleButton>(AssistantFab)}
        suggestionView={asSlot<typeof CopilotChatSuggestionView>(EmptyStateSuggestions)}
        messageView={{
          // 复制按钮暂不需要（且按钮在本工程层叠下偏大）：user/assistant 两侧
          // 都替换成空渲染；重新生成/赞踩等其余工具栏保留
          assistantMessage: {
            copyButton: asSlot<never>(NullSlot),
          },
          userMessage: {
            copyButton: asSlot<never>(NullSlot),
          },
        }}
        onError={(ev) => {
          if (!("error" in ev)) return;
          const raw = typeof ev.error?.message === "string" ? ev.error.message : "";
          if (process.env.NODE_ENV !== "production") console.error("[chat]", ev.error);
          useChatSession.getState().setRunError(friendlyError(raw));
        }}
      />
      <CapabilitiesDialog />
    </div>
  );
}

/** 原始报错 → 人话（v1 时代同款映射；细节横幅只给人话，原文进 console） */
function friendlyError(message: string): string {
  const m = message.toLowerCase();
  if (
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("load failed")
  )
    return "连不上助手服务（网络中断或服务未启动），检查后重试";
  if (m.includes("401") || m.includes("unauthorized") || m.includes("credential"))
    return "登录已过期，请重新登录后再试";
  if (m.includes("429") || m.includes("rate limit") || m.includes("too many"))
    return "请求太频繁或额度限流，稍等几秒再试";
  if (
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("abort") ||
    m.includes("cancelled")
  )
    return "请求超时或已中止";
  if (m.includes("insufficient") || m.includes("balance") || m.includes("quota"))
    return "模型额度/余额不足";
  if (
    m.includes("server error") ||
    m.includes("internal error") ||
    /\b50[0234]\b/.test(m)
  )
    return "服务暂时不可用，稍后重试";
  return "本次响应出错";
}
