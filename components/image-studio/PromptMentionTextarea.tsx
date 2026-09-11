"use client";

/**
 * 自由生图提示词输入（juben PromptWithReferenceMentions 移植，2026-09-07）：
 * `@` 弹出参考图候选（过滤 图N/文件名，↑↓/Enter 拾取），选中插入 `@图N `；
 * `@图N` 本体以高亮胶囊呈现——透明 textarea + 同版式高亮层 overlay（高亮层
 * 禁止额外占宽，否则与光标错位）。弹层锚在**光标处**（juben 同款：高亮层
 * 在 caret 偏移处埋零宽锚点 span，弹层 portal 到 body 按 anchor 定位）；
 * Backspace 两次删除实体（第一次选中整颗 `@图N`）。
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { assetThumbUrl } from "@/lib/asset-thumb";

export interface PromptRefItem {
  url: string;
  filename: string;
}

/** 与后端 `_parse_reference_annotations` 对齐：只识别 `@图N` 本体为实体 */
const REF_ENTITY_RE = /@图(\d+)/g;

const LISTBOX_ID = "free-image-ref-picker";
const ENTITY_CLASS =
  "rounded-[5px] font-semibold text-accent-2 [box-shadow:inset_0_0_0_999px_var(--color-accent-dim)]";

type Token = { kind: "text"; text: string } | { kind: "entity"; text: string; index: number };

function tokenize(text: string): Token[] {
  if (!text) return [];
  const tokens: Token[] = [];
  let last = 0;
  for (const m of text.matchAll(REF_ENTITY_RE)) {
    const start = m.index ?? 0;
    if (start > last) tokens.push({ kind: "text", text: text.slice(last, start) });
    tokens.push({ kind: "entity", text: m[0], index: Number(m[1]) });
    last = start + m[0].length;
  }
  if (last < text.length) tokens.push({ kind: "text", text: text.slice(last) });
  return tokens;
}

function findAtTrigger(value: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "@") {
      const prev = value[i - 1];
      // 与 email / 标识符区分：@ 左侧不能是词字符
      if (i === 0 || !/\w/.test(prev ?? "")) {
        const query = value.slice(i + 1, caret);
        if (!/^[\w一-鿿.]*$/.test(query)) break;
        return { start: i, query };
      }
      break;
    }
    if (/\s/.test(ch)) break;
    i -= 1;
  }
  return null;
}

/** 高亮层渲染：caretOffset 非空时在该偏移处埋零宽锚点 span（弹层定位用） */
function renderHighlighted(
  tokens: Token[],
  references: PromptRefItem[],
  caretOffset: number | null,
  setAnchorEl: (el: HTMLSpanElement | null) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  let acc = 0;
  const anchorEl =
    caretOffset !== null ? (
      <span
        key="__caret_anchor__"
        ref={setAnchorEl}
        aria-hidden="true"
        className="inline-block h-[1em] w-0 align-baseline"
      />
    ) : null;

  const piece = (tk: Token, sliceText: string, key: string): ReactNode => {
    if (!sliceText) return null;
    if (tk.kind === "entity") {
      const ref = references[tk.index - 1];
      const title = ref ? `${tk.text} · ${ref.filename}` : tk.text;
      return (
        <span key={key} className={ENTITY_CLASS} title={title}>
          {sliceText}
        </span>
      );
    }
    return <span key={key}>{sliceText}</span>;
  };

  let inserted = false;
  tokens.forEach((tk, i) => {
    const nextAcc = acc + tk.text.length;
    if (!inserted && caretOffset !== null && caretOffset >= acc && caretOffset <= nextAcc) {
      const local = caretOffset - acc;
      out.push(<Fragment key={`pre-${i}`}>{piece(tk, tk.text.slice(0, local), `pre-${i}`)}</Fragment>);
      if (anchorEl) out.push(anchorEl);
      out.push(<Fragment key={`post-${i}`}>{piece(tk, tk.text.slice(local), `post-${i}`)}</Fragment>);
      inserted = true;
    } else {
      out.push(<Fragment key={`t-${i}`}>{piece(tk, tk.text, `t-${i}`)}</Fragment>);
    }
    acc = nextAcc;
  });
  if (!inserted && anchorEl && caretOffset !== null && caretOffset >= acc) out.push(anchorEl);
  return out;
}

export default function PromptMentionTextarea({
  id,
  value,
  onChange,
  onKeyDown,
  references,
  maxLength,
  placeholder,
  ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  references: PromptRefItem[];
  maxLength: number;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [atStart, setAtStart] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [anchorEl, setAnchorEl] = useState<HTMLSpanElement | null>(null);
  const [textareaEl, setTextareaEl] = useState<HTMLTextAreaElement | null>(null);

  const tokens = useMemo(() => tokenize(value), [value]);

  // 已引用实体 chips 行（去重、按首现顺序；缩略图 + 图N）
  const mentioned = useMemo(() => {
    const seen = new Set<number>();
    const out: { index: number; item: PromptRefItem }[] = [];
    for (const tk of tokens) {
      if (tk.kind !== "entity" || seen.has(tk.index)) continue;
      const item = references[tk.index - 1];
      if (!item) continue;
      seen.add(tk.index);
      out.push({ index: tk.index, item });
    }
    return out;
  }, [tokens, references]);

  const filtered = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return references
      .map((item, i) => ({ item, n: i + 1 }))
      .filter(
        ({ item, n }) =>
          !q ||
          `图${n}`.includes(q) ||
          String(n) === q ||
          item.filename.toLowerCase().includes(q),
      );
  }, [references, pickerQuery]);
  const clampedActive = Math.min(activeIndex, Math.max(0, filtered.length - 1));

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setPickerQuery("");
    setAtStart(null);
    setActiveIndex(0);
    setAnchorEl(null);
  }, []);

  const updatePicker = useCallback(
    (nextValue: string, cursor: number) => {
      if (references.length === 0) {
        closePicker();
        return;
      }
      const trigger = findAtTrigger(nextValue, cursor);
      if (!trigger) {
        closePicker();
        return;
      }
      setAtStart(trigger.start);
      // 仅 query 真变化时重置高亮（↑↓ 的 keyup 也走这里，不能打回 0）
      setPickerQuery((prev) => {
        if (prev !== trigger.query) setActiveIndex(0);
        return trigger.query;
      });
      setPickerOpen(true);
    },
    [closePicker, references.length],
  );

  const insertReference = useCallback(
    (n: number) => {
      const ta = taRef.current;
      const start = atStart;
      if (!ta || start === null) {
        closePicker();
        return;
      }
      const cursor = ta.selectionStart ?? value.length;
      const insert = `@图${n} `;
      onChange(`${value.slice(0, start)}${insert}${value.slice(cursor)}`);
      closePicker();
      requestAnimationFrame(() => {
        ta.focus();
        const pos = start + insert.length;
        ta.setSelectionRange(pos, pos);
      });
    },
    [atStart, closePicker, onChange, value],
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    onChange(next);
    updatePicker(next, e.target.selectionStart ?? next.length);
  };

  const handleCursorUpdate = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    updatePicker(ta.value, ta.selectionStart ?? ta.value.length);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
        const hit = filtered[clampedActive];
        if (hit) {
          e.preventDefault();
          insertReference(hit.n);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closePicker();
        return;
      }
    }
    // Backspace 两次删除：第一次选中整个 `@图N` 实体
    if (e.key === "Backspace") {
      const ta = e.currentTarget;
      const start = ta.selectionStart ?? 0;
      const end = ta.selectionEnd ?? 0;
      if (start === end) {
        const scanFrom = Math.max(0, start - 16);
        const slice = value.slice(scanFrom, start);
        for (const m of slice.matchAll(REF_ENTITY_RE)) {
          const absoluteStart = scanFrom + (m.index ?? 0);
          const absoluteEnd = absoluteStart + m[0].length;
          if (absoluteEnd === start) {
            e.preventDefault();
            ta.setSelectionRange(absoluteStart, absoluteEnd);
            return;
          }
        }
      }
    }
    onKeyDown?.(e);
  };

  const handleScroll = () => {
    if (preRef.current && taRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  const staticNodes = useMemo(
    () => renderHighlighted(tokens, references, null, () => {}),
    [tokens, references],
  );

  return (
    <div>
      {mentioned.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="已引用的参考图">
          {mentioned.map(({ index, item }) => (
            <li
              key={`${index}:${item.url}`}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-accent-soft bg-accent-dim py-0.5 pl-0.5 pr-2 text-[11px] font-medium text-accent-2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={assetThumbUrl(item.url)} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" />
              <span className="truncate" title={item.filename}>
                图{index}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="relative overflow-hidden rounded-md border border-hairline bg-surface-2 focus-within:border-accent">
        <pre
          ref={preRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words px-2.5 py-2 font-editorial text-[13px] leading-relaxed text-text"
        >
          {pickerOpen ? renderHighlighted(tokens, references, atStart, setAnchorEl) : staticNodes}
          {value.endsWith("\n") ? "​" : null}
        </pre>
        <textarea
          ref={(el) => {
            taRef.current = el;
            setTextareaEl(el);
          }}
          id={id}
          value={value}
          rows={4}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-label={ariaLabel}
          role="combobox"
          aria-expanded={pickerOpen}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          spellCheck={false}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onKeyUp={(e) => {
            if (!["ArrowUp", "ArrowDown", "Enter", "Escape", "Tab"].includes(e.key))
              handleCursorUpdate(e);
          }}
          onClick={handleCursorUpdate}
          onBlur={() => window.setTimeout(closePicker, 120)}
          onScroll={handleScroll}
          className="relative z-[1] min-h-24 w-full resize-y overflow-hidden bg-transparent px-2.5 py-2 font-editorial text-[13px] leading-relaxed text-transparent caret-[var(--color-text)] outline-none placeholder:text-text-4"
        />
      </div>

      <RefPicker
        open={pickerOpen}
        query={pickerQuery}
        items={filtered}
        activeIndex={clampedActive}
        anchorElement={anchorEl ?? textareaEl}
        onSelect={insertReference}
        onHover={setActiveIndex}
      />
    </div>
  );
}

function RefPicker({
  open,
  query,
  items,
  activeIndex,
  anchorElement,
  onSelect,
  onHover,
}: {
  open: boolean;
  query: string;
  items: { item: PromptRefItem; n: number }[];
  activeIndex: number;
  anchorElement: HTMLElement | null;
  onSelect: (n: number) => void;
  onHover: (i: number) => void;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchorElement) return;
    const place = () => {
      const r = anchorElement.getBoundingClientRect();
      setPos({ left: Math.min(r.left, window.innerWidth - 300), top: Math.max(8, r.top - 8) });
    };
    // 首帧与跟随都走异步回调（setState 不落在 effect 体内）；
    // 400ms 轮询 = 光标移动/滚动期间的粗粒度跟随
    const raf = requestAnimationFrame(place);
    const t = window.setInterval(place, 400);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(t);
    };
  }, [open, anchorElement]);

  useEffect(() => {
    if (!open) return;
    const active = document.getElementById(`${LISTBOX_ID}-option-${items[activeIndex]?.n ?? ""}`);
    active?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, items]);

  if (!open || !pos) return null;
  return createPortal(
    <div
      role="listbox"
      id={LISTBOX_ID}
      aria-label="选择参考图"
      className="fixed z-[1250] w-72 overflow-hidden rounded-lg bg-surface-1 ws-elev-popover"
      style={{ left: pos.left, top: pos.top, transform: "translateY(-100%)" }}
    >
      <div className="border-b border-hairline-soft bg-surface-1 px-3 py-1.5 text-[10px] font-semibold tracking-wide text-text-4">
        参考图{query ? <span className="ml-1 font-normal">「{query}」</span> : null}
      </div>
      <div className="max-h-60 overflow-y-auto py-1">
        {items.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-text-4">
            {query ? "没有匹配的参考图" : "先上传参考图，再打 @ 引用"}
          </div>
        ) : (
          items.map(({ item, n }, flatIndex) => {
            const active = flatIndex === activeIndex;
            return (
              <button
                key={`${n}:${item.url}`}
                id={`${LISTBOX_ID}-option-${n}`}
                type="button"
                role="option"
                aria-selected={active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => activeIndex !== flatIndex && onHover(flatIndex)}
                onClick={() => onSelect(n)}
                className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors ${
                  active ? "bg-accent-dim" : "hover:bg-surface-2"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={assetThumbUrl(item.url)}
                  alt=""
                  className="h-9 w-9 shrink-0 rounded-md object-cover"
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate font-medium ${active ? "text-accent-2" : "text-text-2"}`}
                  >
                    图{n}
                  </span>
                  <span className="block truncate text-[10.5px] leading-4 text-text-4" title={item.filename}>
                    {item.filename}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>,
    document.body,
  );
}
