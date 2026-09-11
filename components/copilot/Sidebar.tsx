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

import { useEffect, useMemo, useRef, useState } from "react";
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
import { Check, Copy, Megaphone, Music, Pencil, Sparkles, Video, type LucideIcon } from "lucide-react";
import { TYPE_ICONS } from "@/lib/canvas/type-icons";
import ChatInput from "./ChatInput";
import AssistantMessage from "./AssistantMessage";
import CapabilitiesDialog from "./CapabilitiesDialog";
import TurnLocator from "./TurnLocator";
import { useChatSession } from "@/lib/chat/session";
import ChatSidebarHeader from "./ThreadsBar";
import { CHAT_EDIT_MESSAGE_EVENT } from "@/lib/canvas/events";
import { assetThumbUrl } from "@/lib/asset-thumb";

/** slot 槽位支持整组件替换（运行时 renderSlot 认任意函数组件），但 d.ts 要求
 *  带静态成员的组件类型——自绘组件按原类型断言收口 */
function asSlot<C>(component: unknown): C {
  return component as C;
}

/** 空渲染（用于从工具栏里摘掉某个内置按钮） */
/** 自定义用户气泡：hover 出铅笔 = 编辑重发（v2 有 onEditMessage 槽但框架
 *  不接线，自接：把原文回填输入条，提交时截断该消息之后的历史再重发）。
 *  content 形态按我们 ChatInput 实际发送的 AG-UI parts 解析（text part +
 *  image/video/audio 的 source:{type:"url",value}）——v2 原厂的附件渲染随
 *  本槽位一起被替换，媒体缩略图/芯片这里自己出 */
function UserBubble({ message }: { message?: { id?: string; content?: unknown } }) {
  const [copied, setCopied] = useState(false);
  const textParts: string[] = [];
  const media: { kind: "image" | "video" | "audio"; url: string }[] = [];
  const c = message?.content;
  if (typeof c === "string") textParts.push(c);
  else if (Array.isArray(c))
    for (const b of c) {
      if (!b || typeof b !== "object") continue;
      const p = b as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") textParts.push(p.text);
      else if (
        (p.type === "image" || p.type === "video" || p.type === "audio") &&
        typeof p.source === "object" &&
        p.source !== null
      ) {
        const src = p.source as { type?: unknown; value?: unknown };
        if (src.type === "url" && typeof src.value === "string")
          media.push({ kind: p.type, url: src.value });
      }
    }
  const text = textParts.join("\n");
  // 系统代发的消息走中性样式：任务通知（TaskEvents 自动续跑）与中断标记
  // （ChatInput 停止按钮落的「（用户中断了这一轮生成）」，Claude Code
  // "[Request interrupted]" 范式）都是系统的嘴不是用户的口吻——改了重发
  // 没有意义，也不该盖轮次跳转锚
  const isSystemNotice =
    text.startsWith("（任务通知）") || text.startsWith("（用户中断");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板被拒时静默（非安全上下文等） */
    }
  };
  return (
    // 用户气泡的真实口径就在这里（px-3 py-2 / text-sm / leading-relaxed /
    // max-w-[88%]）；whitespace-pre-wrap 保住换行、break-words 折长 URL
    // ——v2 原厂用户组件（含其 pre-wrap）被本槽位整个替换，漏了就是换行坍缩。
    // data-turn-id：TurnLocator 轮次跳转的 DOM 锚（系统代发的通知不盖章）
    <div
      className="group flex justify-end px-1"
      // 会话内搜索的定位锚：系统代发的通知也盖章（与 data-turn-id 的轮次锚
      // 语义分开——通知不进轮次索引，但它仍是可搜索的消息正文）
      data-ws-msg-id={typeof message?.id === "string" ? message.id : undefined}
      data-turn-id={
        !isSystemNotice &&
        typeof message?.id === "string" &&
        !message.id.startsWith("progress_") &&
        text
          ? message.id
          : undefined
      }
    >
      <div className="relative max-w-[88%]">
        {media.length > 0 ? (
          <div className="mb-1 flex flex-wrap justify-end gap-1">
            {media.map((m, i) =>
              m.kind === "image" ? (
                <a key={`${i}:${m.url}`} href={m.url} target="_blank" rel="noreferrer" aria-label="查看原图">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={assetThumbUrl(m.url)} alt="附件" className="h-14 w-14 rounded-lg object-cover" />
                </a>
              ) : (
                <a
                  key={`${i}:${m.url}`}
                  href={m.url}
                  target="_blank"
                  rel="noreferrer"
                  data-tip={m.kind === "video" ? "查看视频" : "播放音频"}
                  aria-label={m.kind === "video" ? "查看视频" : "播放音频"}
                  className="flex h-14 items-center gap-1.5 rounded-lg border border-hairline bg-surface-1 px-2.5 text-xs text-text-2 transition-colors hover:text-text"
                >
                  {m.kind === "video" ? <Video className="h-4 w-4" /> : <Music className="h-4 w-4" />}
                  {m.kind === "video" ? "视频" : "音频"}
                </a>
              ),
            )}
          </div>
        ) : null}
        {text ? (
          isSystemNotice ? (
            <div className="whitespace-pre-wrap break-words rounded-[14px_14px_4px_14px] border border-hairline bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-text-2">
              {text}
            </div>
          ) : (
            <div className="whitespace-pre-wrap break-words rounded-[14px_14px_4px_14px] bg-accent px-3 py-2 text-sm leading-relaxed text-white">
              {text}
            </div>
          )
        ) : null}
        {message?.id ? (
          <div className="absolute -left-8 top-1 flex flex-col gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              data-tip={copied ? "已复制" : "复制"} aria-label={copied ? "已复制" : "复制"}
              onClick={() => void copy()}
              className="rounded-md p-1 text-text-4 transition-colors hover:bg-surface-2 hover:text-text"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            {isSystemNotice ? null : (
              <button
                type="button"
                data-tip="编辑并重发" aria-label="编辑并重发"
                data-track="chat.editResend"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent(CHAT_EDIT_MESSAGE_EVENT, {
                      detail: { id: message.id!, text },
                    }),
                  )
                }
                className="rounded-md p-1 text-text-4 transition-colors hover:bg-surface-2 hover:text-text"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 侧栏宽度记忆键（拖拽内缘调宽，globals.css 的 --ws-chat-w 同源；
 *  页面让位宽度由 v2 实测 aside 宽度后回灌 body margin，无需我们同步） */
const WS_WIDTH_KEY = "wingsight_sidebar_width";

/** 侧栏开合记忆键：默认展开（用户拍板 2026-09-08「3」），用户手动收起后记住，
 *  下次加载仍收起——v2 的 defaultOpen 只在挂载时当初始值，运行时没有受控
 *  open 属性，所以持久化只能自己接（见 AssistantFab 里的观察 effect）。
 *  ThemedSidebar 由 AuthGate 门控、只在客户端挂载，读 localStorage 无 SSR 问题 */
const WS_OPEN_KEY = "wingsight_chat_open";
function readChatOpenPref(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(WS_OPEN_KEY) !== "0";
  } catch {
    return true; // 隐私模式/禁用存储：按默认展开，不拦
  }
}
function writeChatOpenPref(open: boolean): void {
  try {
    window.localStorage.setItem(WS_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* 写不进去就只影响记忆，不影响当次开合 */
  }
}

/** 默认宽度：必须经内联 style 落地，不能只靠 globals.css 的兜底——
 *  v2 自己的 adopted stylesheet 按 `--sidebar-width`（= 它量回来的实测值）
 *  写宽度且层叠在后，文档层同分规则赢不了它；不传 width prop 后它的初值
 *  DEFAULT_SIDEBAR_WIDTH=480 会直接成为实际宽度（实测：无存档时侧栏 480px） */
const DEFAULT_CHAT_WIDTH = "420px";

/** 活动栏宽（components/shell/ActivityBar 的 w-14）与画布最小可用宽：
 *  侧栏上限由这两个数反推，不是拍一个 760 了事 */
const ACTIVITY_W = 56;
const CANVAS_MIN = 420;

/**
 * 侧栏宽度 clamp：下限 340（再窄输入条/卡片就堆叠），上限不只「别超屏」——
 * 还要给画布留最小可用宽。否则窄窗口里侧栏拖到 760（或带着 760 的存值换到
 * 窄窗口）会把画布挤成两百来 px：顶栏「分享」被挤成两行竖排、左上工具条
 * 顶到侧栏底下（实测视口 1100 时画布 285px）
 */
function clampChatWidth(w: number): number {
  // 上限不得低于下限 340：窄窗口里「给画布留 420」算出来不足 340 时，画布
  // 让位优先于画布宽度（否则侧栏被压到自己内容都放不下，输入条直接碎掉）
  const upper = Math.max(
    340,
    Math.min(760, window.innerWidth - ACTIVITY_W - CANVAS_MIN),
  );
  return Math.min(Math.max(w, 340), upper);
}

/* 示例入口带图标：此前是 emoji 前缀（✍️🎭🎬📣🧹），而全站图标体系是 lucide
   ——emoji 是 OS 定色的字形，笔画与光学尺寸都跟不上正文，同一块界面里混两套
   图标语言（better-ui「one icon library per surface」）。四条正好对应节点类型，
   直接复用 lib/canvas/type-icons 的 TYPE_ICONS，与卡片徽标同源 */
const SUGGESTIONS = [
  {
    title: "建个剧本卡",
    icon: TYPE_ICONS.script,
    message: "创建一个剧本卡：写一个 90 秒都市悬疑短片的梗概，标题自拟。",
  },
  {
    title: "拆解剧本出设定图",
    icon: TYPE_ICONS.character,
    message: "把画布上的剧本拆解成角色和场景资产清单，建卡后为它们生成设定图。",
  },
  {
    title: "拆整表分镜",
    icon: TYPE_ICONS.shotlist,
    message: "把画布上的剧本拆成 20 镜的标准分镜表，写回分镜表卡。",
  },
  {
    title: "写宣发文案",
    icon: Megaphone,
    message: "为画布上的剧本写一版抖音宣发文案，6 条，带话题标签。",
  },
  {
    title: "整理画布",
    icon: TYPE_ICONS.group,
    message: "把画布上的卡片按类型分组整理并连好关系，最后调整视口让我看全。",
  },
];

/** 空态（助手身份说明 + 建议词）：v2 建议槽位替换（对话开始后隐藏，依据
 *  = session hasMessages）。顶部先给一句「我能干什么」，再列最近会话与
 *  建议词——v2 自带的 WelcomeScreen 在本工程永不渲染（它闸在
 *  `!hasExplicitThreadId`，而 agent-provider.tsx 给 CopilotKit 传了 threadId
 *  做多会话），所以 labels.welcomeMessageText 是死配置（已删），身份文案
 *  由本槽位自己说 */
function EmptyStateSuggestions({
  suggestions,
  onSelectSuggestion,
}: {
  suggestions: { title: string; message: string; icon?: LucideIcon }[];
  onSelectSuggestion?: (s: { title: string; message: string }) => void;
}) {
  const hasMessages = useChatSession((s) => s.hasMessages);
  if (hasMessages || suggestions.length === 0) return null;
  return (
    <div>
      <div className="px-1 pt-3">
        <p className="text-sm font-semibold text-text">画布助手</p>
        <p className="mt-1 text-xs leading-relaxed text-text-3">
          建卡、连关系、拆剧本与分镜、按设定出图都能做：说人话就行，也可以点下面任意一条示例起步。
        </p>
      </div>
      <div className="grid grid-cols-2 gap-1.5 px-1 pt-2">
        {suggestions.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.title}
              type="button"
              data-tip={s.message} aria-label={s.message}
              onClick={() => onSelectSuggestion?.(s)}
              className="flex items-start gap-1.5 rounded-lg border border-hairline bg-surface-2 px-2.5 py-2 text-left text-xs leading-snug text-text-2 transition-colors hover:border-accent-soft hover:bg-surface-1 hover:text-text"
            >
              {Icon ? <Icon className="mt-px h-3.5 w-3.5 shrink-0" /> : null}
              <span>{s.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 关闭态的"助手"显性入口（v2 toggleButton 槽位；开着时让位给 Header 关闭钮） */
function AssistantFab() {
  const config = useCopilotChatConfiguration();
  const open = config?.isModalOpen;
  // 开合记忆：这个槽位在侧栏开/关两种状态下都挂着（v2 把 toggleButton 渲染在
  // aside 之外），所以由它观察 isModalOpen 落盘——展开/收起的所有路径（FAB、
  // header 关闭钮、Esc、抽屉）都经 setModalOpen，一处收口
  useEffect(() => {
    if (typeof open !== "boolean") return;
    writeChatOpenPref(open);
  }, [open]);
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
  // 外层 v2 配置（<CopilotKit> 的上下文桥）：v2 的 sidebar provider 会采纳
  // 父级 isModalOpen（父级默认 true），所以「上次收起」必须推到父级才生效
  const outerConfig = useCopilotChatConfiguration();
  useEffect(() => {
    if (!outerConfig || typeof outerConfig.isModalOpen !== "boolean") return;
    const pref = readChatOpenPref();
    if (outerConfig.isModalOpen !== pref) outerConfig.setModalOpen(pref);
    // 只在挂载时推一次：之后的开合以用户操作为准（FAB/关闭钮都会同步父级）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 空态建议喂进 v2 core（视图经 suggestionView 槽位消费）
  const suggestionsConfig = useMemo(() => ({ suggestions: SUGGESTIONS }), []);
  useConfigureSuggestions(suggestionsConfig);

  // 侧栏内缘拖拽调宽：改 --ws-chat-w（globals.css 骨架的唯一宽度事实源，
  // 兜底 420px；不再读 v2 自带的 --sidebar-width——它现在由 v2 从实测宽度回写，
  // 读它会形成回显自锁），localStorage 记忆；命令式 DOM 操作不走 React 状态。
  // move/up 挂 window：指针捕获万一丢失（浏览器差异/中断）拖拽也不死 mid-way，
  // 且 dragging 态放在 html 上，任何收尾路径（up/cancel/blur）都能复位
  const resizerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const saved = window.localStorage.getItem(WS_WIDTH_KEY);
    // 装载也 clamp：存着 760px 的人在 1100 宽的窗口打开，不该把画布挤成 284px
    //（clamp 原本只在拖拽时生效，拖完/换窗口不会自己回来）
    const want = parseInt(saved || DEFAULT_CHAT_WIDTH, 10);
    const initial = `${clampChatWidth(Number.isFinite(want) ? want : 420)}px`;
    const timers: number[] = [];
    document.documentElement.style.setProperty("--ws-chat-w", initial);
    // 内联宽度立即写一次（防 480→420 闪一屏）+ 首帧后再写一次（防 v2 在
    // 自己的 layout effect 里回写盖掉）。侧栏常驻 DOM（关闭仅 aria-hidden）
    // 注意：此分支绝不早退——曾因 return 跳过下面的监听器挂载，
    // 「刷新后有存值 → 拖拽永久失灵」就是这个坑
    const applyInitial = () =>
      (document.querySelector("aside.copilotKitSidebar") as HTMLElement | null)?.style.setProperty(
        "width",
        initial,
        "important",
      );
    applyInitial();
    timers.push(window.setTimeout(applyInitial, 400));
    const el = resizerRef.current;
    const cleanupRestore = () => timers.forEach((t) => window.clearTimeout(t));
    if (!el) return cleanupRestore;
    const clamp = clampChatWidth;
    // v2 经 adopted stylesheet 打的 !important 宽度规则会吃掉任何文档层
    // 选择器（特异性提档也没用）；内联 !important 是唯一稳定赢面（实测），
    // 同时写 root 变量让 .ws-chat-resizer 条同步贴边
    //
    // 但一次内联写入不够：v2 会在自己下一次 render 里把「它记得的宽度」重新
    // 提交成内联 style，把命令式写入覆盖回去（实测：窗口 1100→820 后
    // --ws-chat-w=344px 而 aside 仍 624px，body 让位跟着 624，画布被挤成
    // 140px）。故补两拍重写（下一帧 + 400ms），与装载时 applyInitial 的双写
    // 同一手法。applyGen 让新的 apply 作废旧补写（拖拽期间每帧都在改，不能
    // 回灌陈旧值）；disposed 防卸载后再写 DOM
    let applyGen = 0;
    let disposed = false;
    const apply = (w: number) => {
      const px = `${Math.round(w)}px`;
      document.documentElement.style.setProperty("--ws-chat-w", px);
      const write = () =>
        (document.querySelector("aside.copilotKitSidebar") as HTMLElement | null)?.style.setProperty(
          "width",
          px,
          "important",
        );
      write();
      const gen = ++applyGen;
      const retry = () => {
        if (disposed || gen !== applyGen) return;
        write();
      };
      window.requestAnimationFrame(retry);
      timers.push(window.setTimeout(retry, 400));
    };
    let dragging = false;
    const startDrag = () => {
      dragging = true;
      document.documentElement.classList.add("ws-chat-dragging");
    };
    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      document.documentElement.classList.remove("ws-chat-dragging");
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* 未捕获时忽略 */
      }
      // blur（切窗口 / 失焦）也走这条收尾，但 FocusEvent 没有 clientX：
      // innerWidth - undefined = NaN，会把「NaNpx」写进 localStorage（下次
      // 装载只能靠 isFinite 兜回默认值）。失焦时按当前宽度重新 clamp
      const fromPointer = Number.isFinite(e.clientX);
      const w = clamp(
        fromPointer
          ? window.innerWidth - e.clientX
          : parseFloat(
              getComputedStyle(document.documentElement).getPropertyValue("--ws-chat-w"),
            ) || parseInt(DEFAULT_CHAT_WIDTH, 10),
      );
      apply(w);
      window.localStorage.setItem(WS_WIDTH_KEY, `${Math.round(w)}px`);
    };
    const onDown = (e: PointerEvent) => {
      startDrag();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败也照常拖：window 级 move/up 兜底 */
      }
      apply(clamp(window.innerWidth - e.clientX));
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      e.preventDefault();
      apply(clamp(window.innerWidth - e.clientX));
    };
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("blur", endDrag as EventListener);
    // 窗口变窄后不重算的话，「先拖宽、再缩窗口」会让画布被陈旧宽度挤没
    //（clamp 只在拖拽时生效，拖完不会自己回来）。这里只视觉 clamp，
    // 不回写 localStorage——用户重新拉宽窗口时他选的宽度还在
    const onResize = () => {
      if (dragging) return;
      const cur =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue("--ws-chat-w"),
        ) || parseInt(DEFAULT_CHAT_WIDTH, 10);
      apply(clamp(cur));
    };
    window.addEventListener("resize", onResize);
    return () => {
      disposed = true;
      if (typeof cleanupRestore === "function") cleanupRestore();
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("blur", endDrag as EventListener);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div className="contents">
      <div ref={resizerRef} className="ws-chat-resizer" aria-hidden="true" />
      <CopilotSidebar
        agentId="default"
        // 默认展开；上次手动收起过则保持收起（localStorage 记忆，见 WS_OPEN_KEY）
        defaultOpen={readChatOpenPref()}
        position="right"
        // 故意不传 width：v2 只在 width 缺省时才挂 ResizeObserver 量 aside 实测
        // 宽度、再据此写 body 的 margin-inline-end（页面让位）。传了就把让位
        // 钉死在传入值，而实际宽度由可拖的 --ws-chat-w 决定（存 localStorage），
        // 两者一不等侧栏就盖住画布右缘——顶栏「主题/分享/账户」被裁、小地图被
        // 吃一条、底坞与空态中心偏右（拖宽侧栏必现）
        labels={{
          modalHeaderTitle: "Wingsight 助手",
          // welcomeMessageText 不填：v2 的 WelcomeScreen 闸在 !hasExplicitThreadId，
          // 而我们显式管 threadId（多会话）→ 该屏永不渲染，填了是死配置。
          // 空态身份文案见 EmptyStateSuggestions
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
          // 助手消息视图自绘（components/copilot/AssistantMessage.tsx）：
          // 复制/重新生成按钮 + 长回复折叠。此前只把 copyButton 换成空渲染，
          // 而 v2 工具栏是条件渲染（无 handler 的按钮不渲染）——结果助手消息
          // 一个操作按钮都没有，长回复只能手动拖选（2026-09-09 review）
          assistantMessage: asSlot<never>(AssistantMessage),
          userMessage: asSlot<never>(UserBubble),
        }}
        onError={(ev) => {
          if (!("error" in ev)) return;
          const raw = typeof ev.error?.message === "string" ? ev.error.message : "";
          if (process.env.NODE_ENV !== "production") console.error("[chat]", ev.error);
          useChatSession.getState().setRunError(friendlyError(raw));
        }}
      />
      <CapabilitiesDialog />
      {/* 对话轮次索引轨（juben TurnLocator 范式）：portal 挂 body 贴消息区右缘 */}
      <TurnLocator />
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
