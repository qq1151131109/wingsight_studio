"use client";

/**
 * 生成输入条（生成输入面板的主体）：描述 + "@"引用画布卡片 → 点生成
 *   → GENERATE_EVENT → CanvasAgentBridge 组装指令发给 agent。
 * 引用以 chip 形式挂在输入条上（可删），不进正文——纯 textarea 实现。
 * 拖画布媒体到面板上 = 快捷加引用（ADD_REF_EVENT，nodes.tsx 的 mediaDragProps 发出）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Star, X } from "lucide-react";
import { NODE_META, useCanvasStore, type WingNode } from "@/lib/canvas/store";
import {
  ADD_REF_EVENT,
  FOCUS_NODES_EVENT,
  PROMPT_PICK_EVENT,
  type AddRefDetail,
  type PromptPickDetail,
} from "@/lib/canvas/events";
import { toggleFavorite } from "@/lib/prompt-library";
import { Lightbox } from "./Lightbox";

/** 卡片输入条上的"直接生成"事件 */
export const GENERATE_EVENT = "wingsight:generate";

export type GenerateDetail = {
  nodeId: string;
  /** text=撰写/续写正文（note/script），image/video=媒体生成（结果回填对应
   *  URL 字段），shotlist=对话式修改分镜表（重生成/增删行） */
  kind: "image" | "video" | "text" | "shotlist";
  prompt: string;
  refIds: string[];
  /** image 生成时的候选张数（1/2/4，缺省 1） */
  count?: number;
};

const KIND_PLACEHOLDER: Record<GenerateDetail["kind"], string> = {
  image: "描述画面，@ 引用画布卡片保持一致",
  video: "描述镜头内容，@ 引用画布卡片保持一致",
  text: "想让 AI 写什么？@ 引用画布卡片补充设定",
  shotlist: "想让 AI 改这页分镜？如：按剧本重新生成 / 压缩到 6 镜 / 给第 3 镜加雨戏",
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

/** 参考实体缩略（竞品通行的实体化 chip：viedeo-workflow/open-ai-canvas）：
 *  有图用缩略图，无图（文本/视频/音频）降级为类型首字徽标 */
function RefThumb({ node, size = 20 }: { node: WingNode; size?: number }) {
  const url = node.data.imageUrl as string | undefined;
  const meta = NODE_META[node.data.nodeType];
  if (url)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        className="shrink-0 rounded-sm bg-surface-2 object-contain"
        style={{ width: size, height: size }}
      />
    );
  return (
    <span
      className="grid shrink-0 place-items-center rounded-sm bg-surface-2 text-[9px] font-medium"
      style={{ width: size, height: size, color: meta?.dot }}
      title={meta?.label}
    >
      {meta?.label?.slice(0, 1) ?? "?"}
    </span>
  );
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
  placeholder,
  variant = "inline",
}: {
  nodeId: string;
  kind: "image" | "video" | "text" | "shotlist";
  placeholder?: string;
  /** floating = 选中卡下方的独立大面板（libtv 范式）；inline = 卡内紧凑 */
  variant?: "inline" | "floating";
}) {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const [text, setText] = useState("");
  const [refs, setRefs] = useState<WingNode[]>([]);
  const [mention, setMention] = useState<{ start: number; q: string } | null>(
    null,
  );
  const [hi, setHi] = useState(0);
  const [count, setCount] = useState(1);
  const [favSaved, setFavSaved] = useState(false);
  // 引用 chip 缩略图点击 → 大图预览（灯箱翻页仅限有图的引用）
  const [preview, setPreview] = useState<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 连线即引用（open-ai-canvas「已连接素材」/ novanova「mention 来自连线」）：
  // 上游连进来的卡本来就参与生成（桥接层 upstreamLines 注入），这里如实亮出
  // 来。连线引用不可删（移除=画布断线），与手动 @ 引用合并展示
  const connectedRefs = useMemo(() => {
    const out: WingNode[] = [];
    for (const e of edges) {
      if (e.target !== nodeId) continue;
      const n = nodes.find((x) => x.id === e.source);
      if (
        !n ||
        n.id === nodeId ||
        n.data.nodeType === "group" ||
        out.some((x) => x.id === n.id)
      )
        continue;
      out.push(n);
    }
    return out;
  }, [edges, nodes, nodeId]);
  const connectedIds = useMemo(
    () => new Set(connectedRefs.map((n) => n.id)),
    [connectedRefs],
  );
  // 合并展示：连线引用在前，手动 @ 在后（同 id 以连线版为准）
  const shownRefs = [
    ...connectedRefs,
    ...refs.filter((r) => !connectedIds.has(r.id)),
  ];
  const previewImgs = shownRefs
    .filter((r) => Boolean(r.data.imageUrl))
    .map((r) => ({ src: r.data.imageUrl as string, title: r.data.title ?? "" }));

  // 提示词库点选 → 追加到输入框
  useEffect(() => {
    const onPick = (e: Event) => {
      const { text } = (e as CustomEvent<PromptPickDetail>).detail;
      if (!text) return;
      setText((prev) => (prev.trim() ? `${prev.trimEnd()}, ${text}` : text));
      taRef.current?.focus();
    };
    window.addEventListener(PROMPT_PICK_EVENT, onPick);
    return () => window.removeEventListener(PROMPT_PICK_EVENT, onPick);
  }, []);

  // 拖画布媒体到面板 = 快捷把该卡加为引用（对标 viedeo-workflow 的 drag-to-chat）
  useEffect(() => {
    const onAddRef = (e: Event) => {
      const refId = (e as CustomEvent<AddRefDetail>).detail?.nodeId;
      if (!refId || refId === nodeId) return;
      setRefs((rs) => {
        if (rs.some((r) => r.id === refId)) return rs;
        const n = useCanvasStore.getState().nodes.find((x) => x.id === refId);
        return n ? [...rs, n] : rs;
      });
    };
    window.addEventListener(ADD_REF_EVENT, onAddRef);
    return () => window.removeEventListener(ADD_REF_EVENT, onAddRef);
  }, [nodeId]);

  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLowerCase();
    return nodes
      .filter(
        (n) =>
          n.id !== nodeId &&
          n.data?.nodeType &&
          n.data.nodeType !== "group" &&
          !refs.some((r) => r.id === n.id) &&
          !connectedIds.has(n.id),
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
  }, [nodes, mention, nodeId, refs, connectedIds]);

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
        detail: {
          nodeId,
          kind,
          prompt,
          refIds: refs.map((r) => r.id),
          ...(kind === "image" && count > 1 ? { count } : {}),
        },
      }),
    );
    setText("");
    setRefs([]);
    setMention(null);
  };

  const floating = variant === "floating";
  return (
    <div
      className={`ws-detail nodrag nowheel rounded-md border border-hairline bg-surface-2/60 ${
        floating ? "border-0 bg-transparent p-0" : "mt-1.5 p-1.5"
      }`}
    >
      {shownRefs.length > 0 ? (
        <div className={`flex flex-wrap gap-1 ${floating ? "mb-1.5" : "mb-1"}`}>
          {shownRefs.map((r, i) => {
            const hasImg = Boolean(r.data.imageUrl);
            const connected = connectedIds.has(r.id);
            // 该引用在可预览图片序列里的位次（前面的有图引用数）
            const imgIdx = shownRefs
              .slice(0, i)
              .filter((x) => Boolean(x.data.imageUrl)).length;
            return (
              <span
                key={r.id}
                className={`inline-flex items-center gap-1 rounded border bg-surface-1 py-0.5 pl-0.5 pr-1 text-[10px] text-text-2 ${
                  connected ? "border-dashed border-hairline" : "border-hairline"
                }`}
                title={
                  (connected ? "连线引用：此卡已连入本卡、参与本次生成（断开连线即移除）" : "") +
                  ((r.data.body ?? "").trim()
                    ? `\n${(r.data.body as string).slice(0, 80)}`
                    : "")
                }
              >
                {hasImg ? (
                  <button
                    type="button"
                    title="预览参考图"
                    className="shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPreview(imgIdx);
                    }}
                  >
                    <RefThumb node={r} />
                  </button>
                ) : (
                  <RefThumb node={r} />
                )}
                <button
                  type="button"
                  title="定位到画布卡片"
                  className="max-w-24 truncate transition-colors hover:text-accent"
                  onClick={(e) => {
                    e.stopPropagation();
                    const st = useCanvasStore.getState();
                    st.selectNodes([r.id]);
                    window.dispatchEvent(
                      new CustomEvent(FOCUS_NODES_EVENT, {
                        detail: { ids: [r.id] },
                      }),
                    );
                  }}
                >
                  @{r.data.title?.slice(0, 10) || "无题"}
                </button>
                {connected ? null : (
                  <button
                    type="button"
                    title="移除引用"
                    className="text-text-4 hover:text-danger"
                    onClick={() => setRefs((rs) => rs.filter((x) => x.id !== r.id))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      ) : null}
      {kind === "image" && floating ? (
        <div className="mb-1 flex items-center gap-1 px-1">
          <span className="text-[10px] text-text-4">候选</span>
          {[1, 2, 4].map((n) => (
            <button
              key={n}
              type="button"
              className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                count === n
                  ? "border-accent bg-accent-dim text-text"
                  : "border-hairline text-text-3 hover:text-text"
              }`}
              onClick={() => setCount(n)}
            >
              {n} 张
            </button>
          ))}
        </div>
      ) : null}
      <div className="relative flex items-end gap-1">
        <textarea
          ref={taRef}
          value={text}
          rows={floating ? 3 : 2}
          placeholder={placeholder ?? KIND_PLACEHOLDER[kind]}
          className={`w-full resize-none bg-transparent leading-relaxed text-text outline-none placeholder:text-text-4 ${
            floating ? "px-1 py-1 text-sm" : "px-1 py-0.5 text-xs"
          }`}
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
          title={favSaved ? "已收藏" : "收藏当前输入到提示词库"}
          className={`mb-0.5 grid shrink-0 place-items-center rounded-md border border-hairline bg-surface-1 transition-colors hover:border-accent hover:text-text ${
            floating ? "h-8 w-8" : "h-7 w-7"
          } ${favSaved ? "text-warn" : "text-text-2"}`}
          onClick={() => {
            const t = text.trim();
            if (!t) return;
            toggleFavorite(t);
            setFavSaved(true);
            setTimeout(() => setFavSaved(false), 1500);
          }}
        >
          <Star className={`h-3.5 w-3.5 ${favSaved ? "fill-current text-warn" : ""}`} />
        </button>
        <button
          type="button"
          title={
            kind === "text"
              ? "让 AI 撰写（Ctrl+Enter）"
              : kind === "shotlist"
                ? "让 AI 修改分镜表（Ctrl+Enter）"
                : "生成（Ctrl+Enter）"
          }
          className={`mb-0.5 grid shrink-0 place-items-center rounded-md border border-hairline bg-surface-1 text-text-2 transition-colors hover:border-accent hover:text-text ${
            floating ? "h-8 w-8" : "h-7 w-7"
          }`}
          onClick={submit}
        >
          <Sparkles className={floating ? "h-4 w-4" : "h-3.5 w-3.5"} />
        </button>
        {mention && candidates.length > 0 ? (
          <div className="absolute bottom-full left-0 z-20 mb-1 max-h-44 w-64 overflow-auto rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">            {candidates.map((c, i) => (
              <button
                key={c.id}
                type="button"
                // 阻止 mousedown 抢焦点导致 textarea 失焦闪烁
                onMouseDown={(e) => e.preventDefault()}
                className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs ${
                  i === hi ? "bg-surface-2 text-text" : "text-text-2"
                }`}
                onClick={() => pick(c)}
                onMouseEnter={() => setHi(i)}
              >
                <RefThumb node={c} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {c.data.title || "（无标题）"}
                  </span>
                  {(c.data.body ?? "").trim() ? (
                    <span className="block truncate text-[9px] leading-tight text-text-4">
                      {(c.data.body as string).slice(0, 48)}
                    </span>
                  ) : null}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-text-4">
                  {NODE_META[c.data.nodeType]?.label}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {preview !== null && previewImgs.length > 0 ? (
        <Lightbox
          images={previewImgs}
          index={Math.min(preview, previewImgs.length - 1)}
          onIndex={setPreview}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}
