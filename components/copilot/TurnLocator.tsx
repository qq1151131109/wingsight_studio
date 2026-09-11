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
 *
 * 「读到哪」= scroll-sync（2026-09-11，此前轨道只标「最新一轮」）：滚动/流式/
 * 尺寸变化都走 measure → syncActive，按可读带上部 1/3 的阅读线判定当前轮。
 * 视觉语义——**实心 accent 加宽 = 你正在读的这一轮**，**accent 空心环 = 最新一轮
 * （还没读到）**，灰点 = 其余；面板展开时当前轮那行同步高亮并滚进面板视口。
 * 键盘：Alt+↑/↓ 上/下一轮、Alt+Home/End 首/末轮（侧栏打开时接管）。
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
  /** 正在读的那一轮（scroll-sync 判定，见 syncActive） */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 锚点清单的镜像：syncActive 每帧要读「真正的末轮」，但它不能把 anchors 收进
   *  依赖（那会连带 measure 的依赖变化 → 几何订阅随流式反复重挂），故用 ref 转发 */
  const anchorsRef = useRef<Anchor[]>([]);
  useEffect(() => {
    anchorsRef.current = anchors;
  }, [anchors]);
  /** 面板里当前轮那一行：面板展开时滚进可视区（否则长对话里高亮在面板外） */
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
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

  /** 当前阅读位置那一轮（scroll-sync，2026-09-11）。轨道此前只标「最新一轮」，
   *  19 轮对话翻到中间时给不出任何位置感——而「高亮跟随阅读位置」正是第三方
   *  导航扩展（Flex & Nav for Gemini / Chat Index Navigator）的核心卖点。
   *
   *  判据两条（缺一不可，实测各补过一次错）：
   *  ① **末轮的提问已进入可视带**（它的 top 在带底之上）→ 当前轮就是末轮。
   *     贴底读最新答复是最常见姿态，而末轮往往很长、提问气泡早已滚出带上沿；
   *     只按阅读线判会把「正在读最新一轮」错报成倒数第 N 轮（实测贴底判成第 5 轮）。
   *     跳末轮时若因内容到底无法顶到带上沿，这条同样兜住。
   *     **必须认「真正的末轮」而不是最后一个已挂载的锚**：长对话虚拟化时视口附近
   *     挂着的那几轮里，最后一个是视口下方某一轮，拿它当末轮会把当前轮顶到那里
   *     （anchorsRef 取消息数据里的末轮，DOM 里找不到就说明它未挂载 = 不在视口）。
   *  ② 否则按**阅读线**（可视带上部 25%）取最后一个越过它的轮次——跳转到某一轮
   *     后该轮起点贴在带上沿，取 %25 而不是 %50 才不会把「上一轮」算成当前。
   *  虚拟化把锚点整段卸载时（els 为空）保留上一次判定——宁可不动也不要闪。 */
  const syncActive = useCallback(() => {
    const vp = resolveViewport();
    if (!vp) return;
    const els = [
      ...document.querySelectorAll<HTMLElement>(
        ".copilotKitMessages [data-turn-id]",
      ),
    ];
    if (els.length === 0) return;
    const rect = vp.getBoundingClientRect();
    const composer = document.querySelector(".copilotKitInputContainer");
    const bandBottom = composer
      ? Math.min(rect.bottom, composer.getBoundingClientRect().top)
      : rect.bottom;
    const lastId = anchorsRef.current.at(-1)?.id ?? null;
    const lastEl = lastId
      ? document.querySelector<HTMLElement>(
          `.copilotKitMessages [data-turn-id="${window.CSS && CSS.escape ? CSS.escape(lastId) : lastId}"]`,
        )
      : null;
    let found: string | null;
    if (lastEl && lastEl.getBoundingClientRect().top <= bandBottom) {
      found = lastId;
    } else {
      const line = rect.top + (bandBottom - rect.top) * 0.25;
      found = null;
      for (const el of els) {
        // DOM 顺序 == 轮次顺序；最后一个越过阅读线的锚就是「正在读的轮」
        if (el.getBoundingClientRect().top <= line) found = el.dataset.turnId ?? null;
        else break;
      }
      // 全部在阅读线下方（刚进会话）→ 取第一个挂载的锚
      if (!found) found = els[0].dataset.turnId ?? null;
    }
    setActiveId((prev) => (prev === found ? prev : found));
  }, [resolveViewport]);

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
      // 同一帧里顺带更新「读到哪」——滚动、流式重排、窗口变化都走这条
      syncActive();
    });
  }, [resolveViewport, syncActive]);

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
    // 滚动 = 阅读位置变化：同一条 measure 里顺带同步「读到哪」（rAF 合并，
    // passive 不阻塞滚动）
    vp?.addEventListener("scroll", measure, { passive: true });
    // v2 开/关是 transform 过渡，RO 不报——收尾补一拍
    aside?.addEventListener("transitionend", measure);
    // 头部页签行高度变化会让滚动区挪位（不变形，RO 不报），轮询兜底轻量校准
    const timer = window.setInterval(measure, 2000);
    return () => {
      ros.forEach((ro) => ro.disconnect());
      window.removeEventListener("resize", measure);
      vp?.removeEventListener("scroll", measure);
      aside?.removeEventListener("transitionend", measure);
      window.clearInterval(timer);
    };
  }, [noRegion, measure, resolveViewport]);

  const jump = useCallback(
    (id: string) => {
      const list = document.querySelector(".copilotKitMessages");
      const q = `[data-turn-id="${window.CSS && CSS.escape ? CSS.escape(id) : id}"]`;
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
    },
    [anchors, resolveViewport],
  );

  // 键盘导航（2026-09-11）：Alt+↑/↓ 上/下一轮、Alt+Home/End 首/末轮。三家 CLI
  // 都有对应键位（codex Ctrl+U/D、gemini-cli ctrl+home/end），Web 侧扩展生态统一
  // 补 Alt+↑/↓。只在侧栏打开时接管（与搜索的 Cmd+F 同一守卫口径）。
  useEffect(() => {
    if (anchors.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const aside = document.querySelector("aside.copilotKitSidebar");
      if (aside?.getAttribute("aria-hidden") !== "false") return;
      // 尚未判定出当前轮（刚进会话还没滚过）→ 记 -1，让 ↓ 落到第一轮而不是第二
      const at = anchors.findIndex((a) => a.id === activeId);
      const cur = at < 0 ? -1 : at;
      let target: string | undefined;
      if (e.key === "ArrowDown") target = anchors[Math.min(cur + 1, anchors.length - 1)]?.id;
      else if (e.key === "ArrowUp") target = anchors[Math.max(cur - 1, 0)]?.id;
      else if (e.key === "Home") target = anchors[0]?.id;
      else if (e.key === "End") target = anchors[anchors.length - 1]?.id;
      else return;
      if (!target) return;
      e.preventDefault();
      jump(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anchors, activeId, jump]);

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
      <div
        className="group pointer-events-auto flex items-center justify-end"
        // 展开面板时把「正在读的那一轮」滚进面板可视区——长对话里高亮若在
        // 面板外，scroll-sync 的意义就丢了一半（面板本身可滚）
        onMouseEnter={() => activeRowRef.current?.scrollIntoView({ block: "nearest" })}
      >
        {/* 标签面板：悬停/聚焦轨道时展开（juben 同款右贴边左展开）；
            ws-turn-panel-in = 右滑淡入入场（display 翻转时重放） */}
        <div className="ws-turn-panel-in mr-1.5 hidden max-h-[300px] w-52 flex-col overflow-hidden rounded-xl border border-hairline bg-surface-1/95 py-2 shadow-lg backdrop-blur group-focus-within:flex group-hover:flex">
          <p className="px-3 pb-1.5 text-[10px] font-medium tracking-wide text-text-4">
            对话轮次 · {anchors.length}
          </p>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5">
            {anchors.map((a, i) => {
              const isActive = a.id === activeId;
              return (
                <button
                  key={a.id}
                  ref={isActive ? activeRowRef : undefined}
                  type="button"
                  title={a.label}
                  data-track="chat.turnJump"
                  data-active={isActive ? "1" : "0"}
                  onClick={(e) => {
                    jump(a.id);
                    e.currentTarget.blur();
                  }}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-2 hover:text-text ${
                    isActive ? "bg-surface-2 text-text" : "text-text-2"
                  }`}
                >
                  <span className="min-w-0 truncate">{a.label}</span>
                  <span className="shrink-0 text-[10px] text-text-4">
                    {i + 1}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        {/* 圆点轨：**当前阅读轮 = 实心 accent 加宽**（scroll-sync 的「我在哪」），
            **最新一轮（非当前）= accent 空心环**（还没读到那里的「最新」标记）；
            其余灰点。悬停展宽+变 accent。
            按钮 = 24px 宽 ×（点高+间距）的命中列，圆点是列内居中的 span
            ——此前按钮本体只有 10×4~6px，实际点不中（2026-09-09 review）。
            宽度/透明度写在 inline style（E2E 按此断言圆点形态），悬停态必须
            用 `!` 后缀的工具类压过 inline——初版裸类 group-hover/dot:w-5 被
            inline width 永远压住，是从来没有生效过的死代码（2026-09-11） */}
        <div className="flex flex-col items-end justify-center py-1.5">
          {anchors.map((a, i) => {
            const last = i === anchors.length - 1;
            const isActive = a.id === activeId;
            return (
              <button
                key={a.id}
                type="button"
                aria-label={`跳到第 ${i + 1} 轮：${a.label}`}
                data-track="chat.turnJump"
                aria-current={isActive ? "true" : undefined}
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
                    // 入场动画只挂最新一点（锚点按 id keyed，新轮只在尾部挂载）
                    last ? "ws-turn-dot-in" : "",
                    // 悬停展宽分档：当前/最新点已宽（改 24），普通点 10 → 20
                    // （两颗 ! 宽度类并存会靠样式表排序碰运气，故按档只挂一颗）
                    isActive || last
                      ? "group-hover/dot:w-6! group-focus-visible/dot:w-6!"
                      : "group-hover/dot:w-5! group-focus-visible/dot:w-5!",
                  ].join(" ")}
                  style={{
                    height: `${dotCls.h}px`,
                    // 当前轮最宽（位置锚）> 最新轮次之 > 普通点
                    width: isActive ? 18 : last ? 14 : 10,
                    background: isActive
                      ? "var(--color-accent)"
                      : last
                        ? "transparent"
                        : "var(--color-text-4)",
                    // 最新轮的「空心环」：小点上用 inset 阴影比 border 稳
                    boxShadow:
                      last && !isActive
                        ? "inset 0 0 0 2px var(--color-accent)"
                        : undefined,
                    opacity: isActive || last ? 1 : 0.55,
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
