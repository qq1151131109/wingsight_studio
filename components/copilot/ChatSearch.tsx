"use client";

/**
 * 会话内搜索（Cmd/Ctrl+F 或头部放大镜）：
 *  - 高亮走 CSS Custom Highlight API（不改 DOM，流式重排不打架），
 *    样式在 globals.css 的 ::highlight(ws-search*) 里
 *  - Enter / ↓ 下一处，Shift+Enter / ↑ 上一处，Esc 关闭；滚动容器内居中定位
 *  - 搜索期间长消息自动展开（useChatSearch 的 active 派生值）
 *  - 超长会话（>50 条）框架会虚拟化，只能搜到已挂载的消息——无结果时如实提示
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { langgraphAgent } from "@/app/agent-provider";
import { escapeStickToBottom, findViewport } from "@/lib/chat/scroll";
import { useChatSearch } from "@/lib/chat/search";

const HL_ALL = "ws-search";
const HL_CUR = "ws-search-current";
/** 框架虚拟化阈值（node_modules/@copilotkit/react-core 的 VIRTUALIZE_THRESHOLD） */
const VIRTUALIZE_THRESHOLD = 50;

function clearHighlights() {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  CSS.highlights.delete(HL_ALL);
  CSS.highlights.delete(HL_CUR);
}

/** 在消息区里收集所有命中的 Range（文本节点级，忽略脚本/样式/输入控件） */
function collectRanges(root: HTMLElement, query: string): Range[] {
  const q = query.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA")
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
  const [partial, setPartial] = useState(false);
  const rangesRef = useRef<Range[]>([]);
  const curRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const paint = useCallback(() => {
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
    const ranges = rangesRef.current;
    if (ranges.length === 0) {
      clearHighlights();
      return;
    }
    const i = Math.min(curRef.current, ranges.length - 1);
    // 当前命中从「全部命中」里排除——两个 highlight 覆盖同一段文字时绘制
    // 顺序不保证，accent 色可能被 dim 色盖住（实测看不出区别）
    CSS.highlights.set(
      HL_ALL,
      new Highlight(...ranges.filter((_, idx) => idx !== i)),
    );
    CSS.highlights.set(HL_CUR, new Highlight(ranges[i]));
  }, []);

  const goTo = useCallback(
    (target: number) => {
      const ranges = rangesRef.current;
      if (ranges.length === 0) return;
      const idx = ((target % ranges.length) + ranges.length) % ranges.length;
      curRef.current = idx;
      setCur(idx);
      paint();
      const vp = findViewport(document.querySelector(".copilotKitMessages"));
      const rect = ranges[idx].getBoundingClientRect();
      if (!vp) return;
      escapeStickToBottom(vp);
      vp.scrollTo({
        top: vp.scrollTop + (rect.top - vp.getBoundingClientRect().top) - vp.clientHeight / 2,
        behavior: "smooth",
      });
    },
    [paint],
  );

  const recompute = useCallback(() => {
    const q = query.trim();
    const root = document.querySelector(".copilotKitMessages");
    if (!q || !root) {
      rangesRef.current = [];
      setCount(0);
      setPartial(false);
      clearHighlights();
      return;
    }
    const ranges = collectRanges(root as HTMLElement, q);
    rangesRef.current = ranges;
    setCount(ranges.length);
    setPartial(
      ranges.length === 0 &&
        (langgraphAgent.messages?.length ?? 0) > VIRTUALIZE_THRESHOLD,
    );
    curRef.current = Math.min(curRef.current, Math.max(ranges.length - 1, 0));
    setCur(curRef.current);
    paint();
    if (ranges.length > 0) goTo(curRef.current);
  }, [query, paint, goTo]);

  // 搜索词变化：防抖重算（等长消息展开的布局落定）
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(recompute, 180);
    return () => window.clearTimeout(t);
  }, [open, recompute]);

  // 流式追加时重算（消息是外部源，回调里 setState 合规）
  useEffect(() => {
    if (!open || !query.trim()) return;
    const agent = langgraphAgent;
    if (!agent) return;
    let raf = 0;
    const update = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(recompute);
    };
    return () => {
      window.cancelAnimationFrame(raf);
      agent.subscribe({ onMessagesChanged: update, onEvent: update }).unsubscribe();
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
      <span
        data-testid="chat-search-count"
        className="shrink-0 tabular-nums text-[10px] text-text-4"
      >
        {count > 0
          ? `${cur + 1}/${count}`
          : query.trim()
            ? partial
              ? "仅搜索已加载部分"
              : "无匹配"
            : ""}
      </span>
      <button
        type="button"
        data-tip="上一处（Shift+Enter）" aria-label="上一处"
        className="shrink-0 rounded p-0.5 text-text-4 transition-colors hover:text-text"
        onClick={() => goTo(curRef.current - 1)}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        data-tip="下一处（Enter）" aria-label="下一处"
        className="shrink-0 rounded p-0.5 text-text-4 transition-colors hover:text-text"
        onClick={() => goTo(curRef.current + 1)}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        data-tip="关闭搜索（Esc）" aria-label="关闭搜索"
        data-track="chat.searchClose"
        className="shrink-0 rounded p-0.5 text-text-4 transition-colors hover:text-text"
        onClick={close}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
