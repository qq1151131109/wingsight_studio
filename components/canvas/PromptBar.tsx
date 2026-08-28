"use client";

/**
 * 图片/视频卡占位态的生成输入条（角色一致性入口，对标影策/AIGCCanvasFlow 的 @引用）：
 *   输入画面描述 + "@"引用画布卡片（角色/场景优先）→ 点生成
 *   → GENERATE_EVENT → CanvasAgentBridge 组装指令（含引用卡内容摘要）发给 agent。
 * 引用以 chip 形式挂在输入条上（可删），不进正文——纯 textarea 实现，避免 contentEditable。
 */

import { useMemo, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { NODE_META, useCanvasStore, type WingNode } from "@/lib/canvas/store";

/** 卡片输入条上的"直接生成"事件 */
export const GENERATE_EVENT = "wingsight:generate";

export type GenerateDetail = {
  nodeId: string;
  kind: "image" | "video";
  prompt: string;
  refIds: string[];
};

/** caret 前最后一个 @提及片段（"雨夜@女侠" → q="女侠"） */
function detectMention(
  text: string,
  caret: number,
): { start: number; q: string } | null {
  const m = text.slice(0, caret).match(/@([^\s@]{0,20})$/);
  if (!m) return null;
  return { start: caret - m[0].length, q: m[1] };
}

/** 候选排序：角色最前（一致性主场景），其次有图的卡 */
const TYPE_ORDER: Record<string, number> = {
  character: 0,
  image: 1,
  storyboard: 2,
  script: 3,
  note: 4,
};

export default function PromptBar({
  nodeId,
  kind,
}: {
  nodeId: string;
  kind: "image" | "video";
}) {
  const nodes = useCanvasStore((s) => s.nodes);
  const [text, setText] = useState("");
  const [refs, setRefs] = useState<WingNode[]>([]);
  const [mention, setMention] = useState<{ start: number; q: string } | null>(
    null,
  );
  const [hi, setHi] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLowerCase();
    return nodes
      .filter(
        (n) =>
          n.id !== nodeId &&
          n.data?.nodeType &&
          n.data.nodeType !== "group" &&
          !refs.some((r) => r.id === n.id),
      )
      .filter(
        (n) =>
          !q ||
          (n.data.title ?? "").toLowerCase().includes(q) ||
          (n.data.body ?? "").slice(0, 120).toLowerCase().includes(q),
      )
      .sort(
        (a, b) =>
          (TYPE_ORDER[a.data.nodeType] ?? 9) - (TYPE_ORDER[b.data.nodeType] ?? 9),
      )
      .slice(0, 6);
  }, [nodes, mention, nodeId, refs]);

  const pick = (n: WingNode) => {
    if (!mention) return;
    // 抠掉 "@查询词" 文本，引用变成 chip
    setText(
      text.slice(0, mention.start) +
        text.slice(mention.start + 1 + mention.q.length),
    );
    setRefs((r) => [...r, n]);
    setMention(null);
    taRef.current?.focus();
  };

  const submit = () => {
    const prompt = text.trim();
    if (!prompt && refs.length === 0) return;
    window.dispatchEvent(
      new CustomEvent<GenerateDetail>(GENERATE_EVENT, {
        detail: { nodeId, kind, prompt, refIds: refs.map((r) => r.id) },
      }),
    );
    setText("");
    setRefs([]);
    setMention(null);
  };

  return (
    <div className="nodrag nowheel mt-1.5 rounded-md border border-hairline bg-surface-2/60 p-1.5">
      {refs.length > 0 ? (
        <div className="mb-1 flex flex-wrap gap-1">
          {refs.map((r) => (
            <span
              key={r.id}
              className="inline-flex items-center gap-1 rounded border border-hairline bg-surface-1 px-1.5 py-0.5 text-[10px] text-text-2"
            >
              <span
                className="ws-card-dot"
                style={{ background: NODE_META[r.data.nodeType]?.dot }}
              />
              <span className="max-w-24 truncate">
                @{r.data.title?.slice(0, 10) || "无题"}
              </span>
              <button
                type="button"
                title="移除引用"
                className="text-text-4 hover:text-danger"
                onClick={() => setRefs((rs) => rs.filter((x) => x.id !== r.id))}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="relative flex items-end gap-1">
        <textarea
          ref={taRef}
          value={text}
          rows={2}
          placeholder="描述画面，@ 引用画布卡片保持一致"
          className="w-full resize-none bg-transparent px-1 py-0.5 text-xs leading-relaxed text-text outline-none placeholder:text-text-4"
          onChange={(e) => {
            setText(e.target.value);
            const m = detectMention(e.target.value, e.target.selectionStart);
            setMention(m);
            setHi(0);
          }}
          onClick={(e) => {
            const m = detectMention(e.currentTarget.value, e.currentTarget.selectionStart);
            setMention(m);
            setHi(0);
          }}
          onKeyDown={(e) => {
            if (mention && candidates.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHi((h) => (h + 1) % candidates.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHi((h) => (h - 1 + candidates.length) % candidates.length);
                return;
              }
              if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                pick(candidates[hi]);
                return;
              }
              if (e.key === "Escape") {
                e.stopPropagation();
                setMention(null);
                return;
              }
            }
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          title="生成（Ctrl+Enter）"
          className="mb-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md border border-hairline bg-surface-1 text-text-2 transition-colors hover:border-accent hover:text-text"
          onClick={submit}
        >
          <Sparkles className="h-3.5 w-3.5" />
        </button>
        {mention && candidates.length > 0 ? (
          <div className="absolute bottom-full left-0 z-20 mb-1 max-h-44 w-56 overflow-auto rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
            {candidates.map((c, i) => (
              <button
                key={c.id}
                type="button"
                // 阻止 mousedown 抢焦点导致 textarea 失焦闪烁
                onMouseDown={(e) => e.preventDefault()}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs ${
                  i === hi ? "bg-surface-2 text-text" : "text-text-2"
                }`}
                onClick={() => pick(c)}
                onMouseEnter={() => setHi(i)}
              >
                <span
                  className="ws-card-dot shrink-0"
                  style={{ background: NODE_META[c.data.nodeType]?.dot }}
                />
                <span className="truncate">{c.data.title || "（无标题）"}</span>
                <span className="ml-auto shrink-0 text-[10px] text-text-4">
                  {NODE_META[c.data.nodeType]?.label}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
