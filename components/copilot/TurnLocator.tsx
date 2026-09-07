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
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { langgraphAgent } from "@/app/agent-provider";

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

/** 可视滚动区：从消息列表向上爬到第一个真正带溢出的祖先（v2 的滚动容器
 *  是无类名 DIV，类名不稳定不能当选择器；判据稳定） */
function findViewport(el: Element | null): HTMLElement | null {
  let cur: Element | null = el;
  for (let i = 0; i < 12 && cur && cur !== document.body; i++) {
    if (i > 0 && cur.scrollHeight > cur.clientHeight + 2)
      return cur as HTMLElement;
    cur = cur.parentElement;
  }
  return null;
}

/** 跳转闪圈：accent 描边 1.2s 淡出（keyframes 在 globals.css） */
function flash(el: Element) {
  el.classList.remove("ws-turn-flash");
  // 重新触发同一次连续跳两轮的动画
  void (el as HTMLElement).offsetWidth;
  el.classList.add("ws-turn-flash");
}

type Region = { top: number; height: number; right: number };

export default function TurnLocator() {
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [region, setRegion] = useState<Region | null>(null);
  // rAF 合并：订阅每帧都触发（流式），量 rect 不必跟着每帧走
  const measureScheduled = useRef(false);

  const measure = () => {
    if (measureScheduled.current) return;
    measureScheduled.current = true;
    window.requestAnimationFrame(() => {
      measureScheduled.current = false;
      const vp = findViewport(document.querySelector(".copilotKitMessages"));
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
      setRegion((prev) => {
        const next = {
          top: Math.round(rect.top),
          height: Math.round(rect.height),
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
  };

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
  }, []);

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
    const list = document.querySelector(".copilotKitMessages");
    const aside = document.querySelector("aside.copilotKitSidebar");
    if (list) attach(list);
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
  }, [noRegion]);

  const jump = (id: string) => {
    const list = document.querySelector(".copilotKitMessages");
    const q = `[data-turn-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`;
    const el = list?.querySelector(q);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      flash(el);
      return;
    }
    // >50 条消息 v2 虚拟化卸载了目标轮：按序位比例估滚 → 挂载后精跳
    const vp = findViewport(list);
    const idx = anchors.findIndex((a) => a.id === id);
    if (!vp || idx < 0) return;
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
        right: `${Math.max(window.innerWidth - region.right + 4, 0)}px`,
      }}
    >
      <div className="group pointer-events-auto flex items-center justify-end">
        {/* 标签面板：悬停/聚焦轨道时展开（juben 同款右贴边左展开） */}
        <div className="mr-1.5 hidden max-h-[300px] w-52 flex-col overflow-hidden rounded-xl border border-hairline bg-surface-1/95 py-2 shadow-lg backdrop-blur group-focus-within:flex group-hover:flex">
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
        {/* 圆点轨：末轮加宽 accent（最新一轮的视觉锚），悬停展宽 */}
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
                  e.currentTarget.blur();
                }}
                className="rounded-full transition-all duration-200 hover:w-5 focus-visible:w-5"
                style={{
                  height: `${dotCls.h}px`,
                  marginBottom: i < anchors.length - 1 ? `${dotCls.gap}px` : 0,
                  width: last ? 18 : 10,
                  background: last ? "var(--color-accent)" : "var(--color-text-4)",
                  opacity: last ? 1 : 0.55,
                }}
              />
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
