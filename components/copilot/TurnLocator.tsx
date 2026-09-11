"use client";

/**
 * 对话轮次快速索引（juben TurnLocator 范式移植）：消息区右侧一条竖向
 * 圆点导航轨——每颗点 = 用户一轮发言，悬停/聚焦展开「对话轮次」标签面板
 * （18 字摘要 + 轮次号），点击滚动到该轮并闪一圈 accent 描边。
 *
 * 锚定方式：v2 消息列表的 DOM 全在框架壳里，槽位没有一个落在消息区内侧
 * ——rail 经 createPortal 挂 body，fixed 定位贴着「可视滚动区」右缘（从
 * .copilotKitMessages 向上爬到第一个 scrollHeight>clientHeight 的祖先即
 * 是，实测是无类名 DIV）。宽度拖拽/开关动画/头部高度变化由 RO+resize+
 * transitionend 三路订阅重测。
 *
 * 数据源：langgraphAgent.messages（与 ChatPersistence 同款订阅——虚拟化
 * 卸载远处消息时 DOM 不全，锚点清单必须来自消息数据而非 DOM）。跳转两段
 * 式：元素在 DOM（<50 条不虚拟化，常态）直接 scrollIntoView；被虚拟化
 * 卸载时按轮次序位比例估滚，等挂载后再精跳。
 *
 * 命中区（2026-09-09 review）：圆点此前就是按钮本体（10×4~6px），基本点不中；
 * 现每个按钮撑成 24px 宽 ×（点高+间距）的连续列，圆点退化为列内居中的 span
 * ——整条轨都是命中区。
 *
 * 两个「位置口径」（2026-09-11 用户反馈「挡字 + 有点靠下」）：
 *  - **横向**：右侧 42px 专用槽（globals.css 的内缩规则）——圆点右缘落在
 *    r-22，正文右缘 r-42、滚动条 r-20…r，三者各留 2px，不再叠字。旧版是
 *    20px 内缩配 +24 偏移，圆点稳定压住正文最后一列 14px。
 *  - **纵向**：以**可读带**居中而非滚动视口——输入条是 absolute bottom-0 浮层，
 *    压在视口下沿之上，用视口整高居中会整体偏低（实测 60px）。
 *
 * 动效（2026-09-11，keyframes 在 globals.css「轮次轨动效」节）：标签面板右滑
 * 淡入（ws-turn-panel-in）、新轮圆点从右缘弹入（ws-turn-dot-in，只挂末点——
 * 锚点按 id keyed，新轮只在尾部挂载）、点击即时脉冲（ws-turn-dot-pulse，补
 * smooth 滚动到落点闪圈之间的反馈空窗）、轨道整体淡入、落点闪圈升级为 accent
 * 竖条+底色冲刷；prefers-reduced-motion 由 globals.css 的全局钳制兜住。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { langgraphAgent } from "@/app/agent-provider";
import { escapeStickToBottom, findViewport } from "@/lib/chat/scroll";

type ChatMsg = { id?: string; role?: string; content?: unknown };

/** AG-UI content → 纯文本（与 UserBubble 的 parts 解析同口径） */
function plainText(content: unknown): string {
  const parts: string[] = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content))
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      const p = b as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
    }
  return parts.join("\n").replace(/\s+/g, " ").trim();
}

/** 轮次标签：juben compactUserPrompt 同款 18 字截断 */
function turnLabel(text: string): string {
  return text.length <= 18 ? text : `${text.slice(0, 18)}…`;
}

type Anchor = { id: string; label: string };

/** 用户轮锚点：瞬时 progress_* / 系统代发的（任务通知）不算用户的轮次 */
function buildAnchors(messages: ChatMsg[]): Anchor[] {
  const out: Anchor[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (typeof m.id !== "string" || m.id.startsWith("progress_")) continue;
    const text = plainText(m.content);
    if (!text || text.startsWith("（任务通知）")) continue;
    out.push({ id: m.id, label: turnLabel(text) || "（媒体消息）" });
  }
  return out;
}

/** 跳转闪圈：accent 竖条 + 底色冲刷 1.2s 淡出（keyframes 在 globals.css） */
function flash(el: Element) {
  el.classList.remove("ws-turn-flash");
  // 重新触发同一次连续跳两轮的动画
  void (el as HTMLElement).offsetWidth;
  el.classList.add("ws-turn-flash");
}

/** 点击即时反馈：命中列里的圆点 scaleX 脉冲一下。smooth 滚动要 300-500ms
 *  才到位、落点闪圈在那之后才出现，脉冲补「点了有没有生效」的空窗 */
function pulse(btn: HTMLElement) {
  const dot = btn.firstElementChild;
  if (!dot) return;
  dot.classList.remove("ws-turn-dot-pulse");
  void (dot as HTMLElement).offsetWidth;
  dot.classList.add("ws-turn-dot-pulse");
}

type Region = { top: number; height: number; right: number };

export default function TurnLocator() {
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [region, setRegion] = useState<Region | null>(null);
  // rAF 合并：订阅每帧都触发（流式），量 rect 不必跟着每帧走
  const measureScheduled = useRef(false);
  /** 滚动视口元素 pin（2026-09-07「上下跳」事故的根因）：爬升判据
   *  （scrollHeight>clientHeight）在流式重排帧里会瞬时翻脸——真滚动容器在
   *  内容塌陷帧不满足判据、climb 落到内容级包装（rect 高达数千 px）上，rail
   *  的 region 随之爆炸再翻回，点列被甩上甩下。真容器本身身份稳定（实测流式
   *  全程 isConnected），解析一次认到底，只在断连（v2 重挂）时重解析 */
  const vpRef = useRef<HTMLElement | null>(null);
  // 只闭包 stable 的 ref，引用恒定——effect 依赖收得干净，无需 disable
  const resolveViewport = useCallback((): HTMLElement | null => {
    const cur = vpRef.current;
    if (cur && cur.isConnected) return cur;
    vpRef.current = findViewport(document.querySelector(".copilotKitMessages"));
    return vpRef.current;
  }, []);

  const measure = useCallback(() => {
    if (measureScheduled.current) return;
    measureScheduled.current = true;
    window.requestAnimationFrame(() => {
      measureScheduled.current = false;
      const vp = resolveViewport();
      if (!vp) {
        setRegion(null);
        return;
      }
      const rect = vp.getBoundingClientRect();
      // 关闭/滑出态（translate-x 动画中）不出轨
      if (rect.width <= 0 || rect.right > window.innerWidth + 40) {
        setRegion(null);
        return;
      }
      // 纵向以**可读带**为准，不是滚动视口：输入条是 absolute bottom-0 的浮层
      // （.copilotKitInputContainer 挂在 .cpk:absolute.cpk:bottom-0 里），压在
      // 滚动视口下沿之上——视口 rect 一直伸到窗口底，直接用它居中会把轨道压到
      // 浮层上（实测圆点中心 541 vs 可读带中心 481，偏低 60px，「有点靠下」）。
      // 拿不到输入条时（理论上不会）退回首版口径 = 视口整高。
      const composer = document.querySelector(".copilotKitInputContainer");
      const bandBottom = composer
        ? Math.min(rect.bottom, composer.getBoundingClientRect().top)
        : rect.bottom;
      setRegion((prev) => {
        const next = {
          top: Math.round(rect.top),
          height: Math.round(Math.max(bandBottom - rect.top, 0)),
          right: Math.round(rect.right),
        };
        return prev &&
          prev.top === next.top &&
          prev.height === next.height &&
          prev.right === next.right
          ? prev
          : next;
      });
    });
  }, [resolveViewport]);

  // 锚点清单：消息数据订阅（虚拟化时 DOM 不全，清单不能靠查 DOM）
  useEffect(() => {
    const agent = langgraphAgent;
    if (!agent) return;
    const update = () => {
      setAnchors(buildAnchors([...((agent.messages ?? []) as ChatMsg[])]));
      measure();
    };
    Promise.resolve().then(update);
    return agent.subscribe({ onMessagesChanged: update, onEvent: update })
      .unsubscribe;
  }, [measure]);

  // 几何订阅：滚动区自身的尺寸 + 拖宽侧栏（body 让位）/窗口变化 + 开关动画。
  // 无 region → 有 region 翻转时重挂（首轮 DOM 可能还没消息列表）
  const noRegion = region === null;
  useEffect(() => {
    const ros: ResizeObserver[] = [];
    const attach = (target: Element) => {
      const ro = new ResizeObserver(measure);
      ro.observe(target);
      ros.push(ro);
    };
    // 观察对象含 pin 住的滚动视口本体（头部/输入区高度变化只动它的 rect，
    //  list 是内容级、aside 是整体固定高，都探不到这类挪位）
    const vp = resolveViewport();
    if (vp) attach(vp);
    const list = document.querySelector(".copilotKitMessages");
    const aside = document.querySelector("aside.copilotKitSidebar");
    // 输入条高度变化（多行输入/排队 chips/附件行）会挪动可读带下界——视口本身
    // 高度不变，只有它自己的 RO 探得到（2s 轮询能兜住但会「先歪一拍」）
    const composer = document.querySelector(".copilotKitInputContainer");
    if (list) attach(list);
    if (composer) attach(composer);
    if (aside) attach(aside);
    attach(document.body);
    window.addEventListener("resize", measure);
    // v2 开/关是 transform 过渡，RO 不报——收尾补一拍
    aside?.addEventListener("transitionend", measure);
    // 头部页签行高度变化会让滚动区挪位（不变形，RO 不报），轮询兜底轻量校准
    const timer = window.setInterval(measure, 2000);
    return () => {
      ros.forEach((ro) => ro.disconnect());
      window.removeEventListener("resize", measure);
      aside?.removeEventListener("transitionend", measure);
      window.clearInterval(timer);
    };
  }, [noRegion, measure, resolveViewport]);

  const jump = (id: string) => {
    const list = document.querySelector(".copilotKitMessages");
    const q = `[data-turn-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`;
    const el = list?.querySelector(q);
    const vp = resolveViewport();
    if (el) {
      escapeStickToBottom(vp);
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      flash(el);
      return;
    }
    // >50 条消息 v2 虚拟化卸载了目标轮：按序位比例估滚 → 挂载后精跳
    const idx = anchors.findIndex((a) => a.id === id);
    if (!vp || idx < 0) return;
    escapeStickToBottom(vp);
    vp.scrollTop = Math.round(
      (vp.scrollHeight - vp.clientHeight) *
        (idx / Math.max(anchors.length - 1, 1)),
    );
    window.setTimeout(() => {
      const el2 = list?.querySelector(q);
      if (el2) {
        el2.scrollIntoView({ behavior: "smooth", block: "start" });
        flash(el2);
      }
    }, 200);
  };

  const dotCls = useMemo(() => {
    const n = anchors.length;
    // 长对话点列收紧防溢出（标签面板才是主索引，点列只是概览）
    if (n <= 16) return { h: 6, gap: 10 };
    if (n <= 36) return { h: 4, gap: 6 };
    return { h: 4, gap: 3 };
  }, [anchors.length]);

  if (anchors.length === 0 || !region || region.height < 120) return null;

  return createPortal(
    <div
      data-testid="chat-turn-rail"
      aria-label="对话轮次索引"
      className="pointer-events-none z-[1250] flex items-center justify-end"
      style={{
        position: "fixed",
        top: `${region.top + 14}px`,
        height: `${Math.max(region.height - 28, 0)}px`,
        /* +22：右侧 42px 专用槽里居中——圆点（10/末点 18px）右缘落在 r-22，
           与正文右缘（r-42）和 20px 滚动条（r-20…r）各留 2px 净空。
           此前是 +24 配 20px 内缩，轨道整个压在正文最后一列字上（用户反馈「挡字」） */
        right: `${Math.max(window.innerWidth - region.right + 22, 0)}px`,
      }}
    >
      <div className="group pointer-events-auto flex items-center justify-end">
        {/* 标签面板：悬停/聚焦轨道时展开（juben 同款右贴边左展开）；
            ws-turn-panel-in = 右滑淡入入场（display 翻转时重放） */}
        <div className="ws-turn-panel-in mr-1.5 hidden max-h-[300px] w-52 flex-col overflow-hidden rounded-xl border border-hairline bg-surface-1/95 py-2 shadow-lg backdrop-blur group-focus-within:flex group-hover:flex">
          <p className="px-3 pb-1.5 text-[10px] font-medium tracking-wide text-text-4">
            对话轮次 · {anchors.length}
          </p>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5">
            {anchors.map((a, i) => (
              <button
                key={a.id}
                type="button"
                title={a.label}
                data-track="chat.turnJump"
                onClick={(e) => {
                  jump(a.id);
                  e.currentTarget.blur();
                }}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
              >
                <span className="min-w-0 truncate">{a.label}</span>
                <span className="shrink-0 text-[10px] text-text-4">
                  {i + 1}
                </span>
              </button>
            ))}
          </div>
        </div>
        {/* 圆点轨：末轮加宽 accent（最新一轮的视觉锚），悬停展宽+变 accent。
            按钮 = 24px 宽 ×（点高+间距）的命中列，圆点是列内居中的 span
            ——此前按钮本体只有 10×4~6px，实际点不中（2026-09-09 review）。
            宽度/透明度写在 inline style（E2E 按此断言末点形态），悬停态必须
            用 `!` 后缀的工具类压过 inline——初版裸类 group-hover/dot:w-5 被
            inline width 永远压住，是从来没有生效过的死代码（2026-09-11） */}
        <div className="flex flex-col items-end justify-center py-1.5">
          {anchors.map((a, i) => {
            const last = i === anchors.length - 1;
            return (
              <button
                key={a.id}
                type="button"
                aria-label={`跳到第 ${i + 1} 轮：${a.label}`}
                data-track="chat.turnJump"
                onClick={(e) => {
                  jump(a.id);
                  pulse(e.currentTarget);
                  e.currentTarget.blur();
                }}
                className="group/dot flex w-6 items-center justify-end"
                style={{
                  height: `${dotCls.h + (i < anchors.length - 1 ? dotCls.gap : 0)}px`,
                }}
              >
                <span
                  className={[
                    "ws-turn-dot rounded-full transition-all duration-200",
                    // 回弹曲线：10px 小点直线过渡没有手感，back-out 微过冲
                    "ease-[cubic-bezier(0.34,1.4,0.64,1)]",
                    "group-hover/dot:bg-accent! group-hover/dot:opacity-100!",
                    // 悬停展宽按末点分档（两颗 ! 宽度类并存会靠样式表排序碰运气）
                    last
                      ? "ws-turn-dot-in group-hover/dot:w-6! group-focus-visible/dot:w-6!"
                      : "group-hover/dot:w-5! group-focus-visible/dot:w-5!",
                  ].join(" ")}
                  style={{
                    height: `${dotCls.h}px`,
                    width: last ? 18 : 10,
                    background: last ? "var(--color-accent)" : "var(--color-text-4)",
                    opacity: last ? 1 : 0.55,
                  }}
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
