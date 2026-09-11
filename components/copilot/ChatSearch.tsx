"use client";

/**
 * 会话内搜索（Cmd/Ctrl+F 或头部放大镜）。
 *
 * **命中计数走数据源，DOM 只负责「画」**（2026-09-11 重构）：此前在
 * `.copilotKitMessages` 里走 DOM 文本节点，而框架对 >50 条消息做虚拟化——
 * 未挂载的消息搜不到，只能诚实提示「仅搜索已加载部分」（生产实测 14 个会话
 * 里 2 个已越阈值，最长 70 条 / 19 轮）。现在：
 *  - 命中清单 = 扫 `langgraphAgent.messages` 的正文（count 天然是全集，
 *    `cur/total` 是可信数字，不随滚动变化）；
 *  - 每条命中记 (消息 id, 该消息内第几处)；跳转时按 id 找容器
 *    （`[data-ws-msg-id]`，AssistantMessage 与用户气泡都盖章）；
 *  - 目标消息被虚拟化卸载时：按消息序位估滚 → 挂载后精定位（与 TurnLocator
 *    的轮次跳转同一手法）；
 *  - 高亮仍用 CSS Custom Highlight API（不改 DOM，流式重排不打架）。
 * 口径：只搜**消息正文**，不搜工具卡（结果 JSON/文件清单是 UI 部件，不是对话
 * 内容）；渲染层与数据层的 markdown 差异（链接地址、列表符号）可能让某条命中
 * 定位不到，此时退化为该消息的首处命中。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { langgraphAgent } from "@/app/agent-provider";
import { escapeStickToBottom, findViewport } from "@/lib/chat/scroll";
import { visibleUserText } from "@/lib/chat/messageContext";
import { useChatSearch } from "@/lib/chat/search";

const HL_ALL = "ws-search";
const HL_CUR = "ws-search-current";

type ChatMsg = { id?: string; role?: string; content?: unknown };

/** AG-UI content → 用户可见文本：**只算用户自己说的话**，附件正文/引用行（消息
 *  里的上下文段，见 lib/chat/messageContext.ts）不参与搜索——界面上根本没渲染
 *  它，搜出来的命中会无处高亮。与轮次轨摘要、气泡渲染共用一份口径 */
function plainText(content: unknown): string {
  return visibleUserText(content).replace(/\s+/g, " ").trim();
}

/** 一条命中：消息 id + 该消息内的第几处（1-based） */
type Hit = { msgId: string; occ: number };

/** 扫数据源得命中清单（含虚拟化未挂载的消息——这正是重构的目的） */
function collectHits(messages: ChatMsg[], query: string): Hit[] {
  const q = query.toLowerCase();
  const out: Hit[] = [];
  for (const m of messages) {
    const id = typeof m.id === "string" ? m.id : "";
    // 瞬时进度消息（progress_*）不是会话正文，跳过（与轮次索引同口径）
    if (!id || id.startsWith("progress_")) continue;
    const text = plainText(m.content);
    if (!text) continue;
    const lower = text.toLowerCase();
    let from = 0;
    let occ = 0;
    for (;;) {
      const i = lower.indexOf(q, from);
      if (i === -1) break;
      occ += 1;
      out.push({ msgId: id, occ });
      from = i + q.length;
    }
  }
  return out;
}

function clearHighlights() {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  CSS.highlights.delete(HL_ALL);
  CSS.highlights.delete(HL_CUR);
}

/** 在给定容器内收集所有命中的 Range（文本节点级，跳过脚本/样式/控件/工具卡） */
function collectRanges(root: HTMLElement, query: string): Range[] {
  const q = query.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA")
        return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest("[data-ws-toolcard]"))
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue ?? "";
    const lower = text.toLowerCase();
    for (let from = 0; ; ) {
      const i = lower.indexOf(q, from);
      if (i === -1) break;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + q.length);
      ranges.push(r);
      from = i + q.length;
    }
  }
  return ranges;
}

export default function ChatSearch() {
  const open = useChatSearch((s) => s.open);
  const query = useChatSearch((s) => s.query);
  const setQuery = useChatSearch((s) => s.setQuery);
  const close = useChatSearch((s) => s.close);

  const [count, setCount] = useState(0);
  const [cur, setCur] = useState(0);
  const hitsRef = useRef<Hit[]>([]);
  const curRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 每个已挂载消息容器内的 Range 缓存（同一次查询内复用；recompute 时清空） */
  const rangesCache = useRef(new Map<string, Range[]>());

  const containerOf = useCallback((msgId: string): HTMLElement | null => {
    const root = document.querySelector(".copilotKitMessages");
    if (!root) return null;
    const esc = window.CSS && CSS.escape ? CSS.escape(msgId) : msgId;
    return root.querySelector<HTMLElement>(`[data-ws-msg-id="${esc}"]`);
  }, []);

  const rangesFor = useCallback(
    (msgId: string): Range[] => {
      const cached = rangesCache.current.get(msgId);
      if (cached) return cached;
      const c = containerOf(msgId);
      const rs = c ? collectRanges(c, query.trim()) : [];
      rangesCache.current.set(msgId, rs);
      return rs;
    },
    [containerOf, query],
  );

  /** 一条命中对应的 DOM Range。occ 落空时退该消息首处——数据层命中数与渲染层
   *  可能不等（markdown 差异：链接地址、列表符号、代码围栏在渲染后变了样），
   *  这时宁可在该消息里指出第一处，也不要「计数有它、高亮没有」。 */
  const rangeOf = useCallback(
    (hit: Hit): Range | null => {
      const rs = rangesFor(hit.msgId);
      return rs[hit.occ - 1] ?? rs[0] ?? null;
    },
    [rangesFor],
  );

  const paint = useCallback(() => {
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
    const hits = hitsRef.current;
    if (hits.length === 0) {
      clearHighlights();
      return;
    }
    const i = Math.min(curRef.current, hits.length - 1);
    const others: Range[] = [];
    hits.forEach((h, idx) => {
      if (idx === i) return;
      const r = rangeOf(h);
      if (r) others.push(r);
    });
    // 当前命中从「全部命中」里排除——两个 highlight 覆盖同一段文字时绘制
    // 顺序不保证，accent 色可能被 dim 色盖住（实测看不出区别）
    CSS.highlights.set(HL_ALL, new Highlight(...others));
    const curRange = rangeOf(hits[i]);
    if (curRange) CSS.highlights.set(HL_CUR, new Highlight(curRange));
    else CSS.highlights.delete(HL_CUR);
  }, [rangeOf]);

  const scrollTo = useCallback((r: Range) => {
    const vp = findViewport(document.querySelector(".copilotKitMessages"));
    if (!vp) return;
    escapeStickToBottom(vp);
    const rect = r.getBoundingClientRect();
    vp.scrollTo({
      top: vp.scrollTop + (rect.top - vp.getBoundingClientRect().top) - vp.clientHeight / 2,
      behavior: "smooth",
    });
  }, []);

  /** 目标消息被虚拟化卸载：按消息序位估滚 → 轮询等挂载 → 精定位 */
  const jumpToUnmounted = useCallback(
    (hit: Hit) => {
      const vp = findViewport(document.querySelector(".copilotKitMessages"));
      const msgs = ((langgraphAgent?.messages ?? []) as ChatMsg[]).slice();
      const idx = msgs.findIndex((m) => m.id === hit.msgId);
      if (!vp || idx < 0) return;
      escapeStickToBottom(vp);
      vp.scrollTop = Math.round(
        (vp.scrollHeight - vp.clientHeight) * (idx / Math.max(msgs.length - 1, 1)),
      );
      const t0 = Date.now();
      const tick = () => {
        // 等待期间用户关掉搜索（Esc）→ 立刻收手：否则回落时 paint 会把刚清掉的
        // 高亮重新注册回去（「Esc 后高亮诈尸」）
        if (!useChatSearch.getState().open) return;
        if (containerOf(hit.msgId)) {
          // 挂载成功：DOM 变了，缓存与命中清单重算，再按 (id, occ) 认回当前位置
          rangesCache.current.clear();
          hitsRef.current = collectHits(
            (langgraphAgent?.messages ?? []) as ChatMsg[],
            query.trim(),
          );
          const back = hitsRef.current.findIndex(
            (x) => x.msgId === hit.msgId && x.occ === hit.occ,
          );
          if (back >= 0) {
            curRef.current = back;
            setCur(back);
          }
          setCount(hitsRef.current.length);
          paint();
          const r = rangeOf(hit);
          if (r) scrollTo(r);
          return;
        }
        if (Date.now() - t0 > 1500) return; // 挂不上就放弃（不长期空转）
        window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    },
    [containerOf, paint, query, rangeOf, scrollTo],
  );

  const goTo = useCallback(
    (target: number) => {
      const hits = hitsRef.current;
      if (hits.length === 0) return;
      const idx = ((target % hits.length) + hits.length) % hits.length;
      curRef.current = idx;
      setCur(idx);
      const hit = hits[idx];
      const r = rangeOf(hit);
      paint();
      if (r) {
        scrollTo(r);
        return;
      }
      // 没有 Range 只有两种可能：消息未挂载（去把它滚出来）或渲染层与数据层
      // 对不上（markdown 差异，paint 已退到首处）。后者仍去估滚是乱跳，拦掉。
      if (!containerOf(hit.msgId)) jumpToUnmounted(hit);
    },
    [containerOf, jumpToUnmounted, paint, rangeOf, scrollTo],
  );

  /** 重算命中清单。`navigate` 只在**用户显式动作**（改词/回车）时为真：
   *  流式追加也走这条重算，若顺带 goTo 就会每来一段文字调一次
   *  escapeStickToBottom（合成 wheel 向上）——等于不停告诉贴底跟随「用户上滚了」，
   *  自动跟随被自己打断（2026-09-11 review 抓到），还附带每段一次平滑滚动。 */
  const recompute = useCallback(
    (navigate: boolean) => {
      const q = query.trim();
      rangesCache.current.clear();
      if (!q) {
        hitsRef.current = [];
        setCount(0);
        clearHighlights();
        return;
      }
      hitsRef.current = collectHits(
        (langgraphAgent?.messages ?? []) as ChatMsg[],
        q,
      );
      setCount(hitsRef.current.length);
      // 改词从第一处起（输入框 onChange 已把 curRef 归零）；流式重算保持当前位置
      if (navigate) curRef.current = 0;
      else
        curRef.current = Math.max(
          Math.min(curRef.current, hitsRef.current.length - 1),
          0,
        );
      setCur(curRef.current);
      paint();
      // 显式动作才导航；流式重算只把当前命中重新上色（不碰滚动）
      if (navigate && hitsRef.current.length > 0) goTo(0);
    },
    [query, paint, goTo],
  );

  // 搜索词变化：防抖重算（等长消息展开的布局落定）；改词是显式动作 → 导航到首处
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => recompute(true), 180);
    return () => window.clearTimeout(t);
  }, [open, recompute]);

  // 流式追加时重算（消息是外部源，回调里 setState 合规）——只刷新命中与高亮，
  // 不导航（否则每段文字都会打断贴底跟随，见 recompute 注释）
  //
  // 注意订阅必须建立在 effect **体**里：旧实现把 `agent.subscribe(...)` 写在
  // 返回的清理函数里，于是「建立时从不订阅、每次清理才订阅并立刻退订」——
  // 这条「消息变了就重算」的链其实一直是断的（只有改词才重算，故一直没被发现，
  // 2026-09-11 review 的 C8 断言才把它逼出来）
  useEffect(() => {
    if (!open || !query.trim()) return;
    const agent = langgraphAgent;
    if (!agent) return;
    let raf = 0;
    const update = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => recompute(false));
    };
    const sub = agent.subscribe({ onMessagesChanged: update, onEvent: update });
    return () => {
      window.cancelAnimationFrame(raf);
      sub.unsubscribe();
    };
  }, [open, query, recompute]);

  // 展开搜索条即聚焦（纯 DOM 操作，不 setState）
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  // 侧栏开着时接管 Cmd/Ctrl+F（画布上的原生查找不受影响）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" && e.key !== "F") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const aside = document.querySelector("aside.copilotKitSidebar");
      if (aside?.getAttribute("aria-hidden") !== "false") return;
      e.preventDefault();
      useChatSearch.getState().setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 关闭时清掉高亮（清理函数里做 DOM 清理，不 setState）
  useEffect(() => {
    if (open) return;
    clearHighlights();
  }, [open]);

  if (!open) return null;

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-hairline bg-surface-2 px-2 py-1">
      <Search className="h-3.5 w-3.5 shrink-0 text-text-4" />
      <input
        ref={inputRef}
        value={query}
        aria-label="在对话里搜索"
        data-testid="chat-search-input"
        placeholder="在对话里搜索…"
        className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-text-4"
        onChange={(e) => {
          curRef.current = 0;
          setCur(0);
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            close();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            goTo(curRef.current + (e.shiftKey ? -1 : 1));
          }
        }}
      />
      {/* 计数来自数据源（全量正文），不再是「已挂载部分里的第几处」——
          虚拟化卸载的消息也计入，跳转时先估滚再挂载精定位 */}
      <span
        data-testid="chat-search-count"
        className="shrink-0 tabular-nums text-[10px] text-text-4"
      >
        {count > 0 ? `${cur + 1}/${count}` : query.trim() ? "无匹配" : ""}
      </span>
      <button
        type="button"
        data-tip="上一处（Shift+Enter）" aria-label="上一处"
        className="shrink-0 rounded p-1.5 text-text-4 transition-[scale,background-color,border-color,color] duration-150 ease-out hover:text-text active:not-disabled:scale-[0.96]"
        onClick={() => goTo(curRef.current - 1)}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        data-tip="下一处（Enter）" aria-label="下一处"
        className="shrink-0 rounded p-1.5 text-text-4 transition-[scale,background-color,border-color,color] duration-150 ease-out hover:text-text active:not-disabled:scale-[0.96]"
        onClick={() => goTo(curRef.current + 1)}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        data-tip="关闭搜索（Esc）" aria-label="关闭搜索"
        data-track="chat.searchClose"
        className="shrink-0 rounded p-1.5 text-text-4 transition-[scale,background-color,border-color,color] duration-150 ease-out hover:text-text active:not-disabled:scale-[0.96]"
        onClick={close}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
