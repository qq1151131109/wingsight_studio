"use client";

/**
 * 自定义聊天输入框（替换 CopilotSidebar 默认 Input）：
 *  - "@"引用画布卡片：候选下拉（角色/图片优先）→ 引用变 chip，发送时把
 *    引用卡内容（id/类型/标题/正文摘要）拼进消息，agent 可直接按 id 操作
 *  - 附件：📎 选择 / 粘贴 / 拖放；图片视频音频上传后作为 AG-UI 多模态
 *    part（url source）随消息发送——换视觉模型后服务端自动透传；文本类
 *    文档（txt/md/json/csv/srt ≤64KB）直接内联进消息，纯文本模型也能用
 *  - Enter 发送 / Shift+Enter 换行 / IME 组合输入安全（composing 时不发送）
 *  - 运行中显示停止按钮；复用 stock 的 .copilotKitInput 系列样式保持原生观感
 * mention 检测与候选排序和画布 PromptBar 同款逻辑。
 */

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { InputProps } from "@copilotkit/react-ui";
import { useCopilotChatHeadless_c } from "@copilotkit/react-core";
import {
  ArrowUp,
  FileText,
  Film,
  ImageIcon,
  Music,
  Paperclip,
  Square,
  X,
} from "lucide-react";
import { NODE_META, useCanvasStore, type WingNode } from "@/lib/canvas/store";
import { uploadAsset } from "@/lib/projects";

/** caret 前最后一个 @提及片段（"雨夜@女侠" → q="女侠"） */
function detectMention(
  text: string,
  caret: number,
): { start: number; q: string } | null {
  const m = text.slice(0, caret).match(/@([^\s@]{0,20})$/);
  if (!m) return null;
  return { start: caret - m[0].length, q: m[1] };
}

/** 候选排序：角色最前（一致性主场景），其次有媒体的卡 */
const TYPE_ORDER: Record<string, number> = {
  character: 0,
  image: 1,
  video: 2,
  storyboard: 3,
  script: 4,
  note: 5,
};

const NODE_TYPE_LABEL: Record<string, string> = {
  note: "便签",
  script: "剧本",
  character: "角色",
  image: "图片",
  video: "视频",
  storyboard: "分镜",
};

// ---------- 附件 ----------

type AttachmentKind = "image" | "video" | "audio" | "document";

interface Attachment {
  key: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  status: "uploading" | "ready" | "error" | "inline";
  /** 上传完成后的同源 URL（inline 文本类没有） */
  url?: string;
  /** 图片本地预览（objectURL，仅展示用） */
  previewUrl?: string;
  /** 文本类文件内联内容（发送时进正文，纯文本模型可直接读） */
  inlineText?: string;
}

const TEXT_LIKE_EXT = [".txt", ".md", ".json", ".csv", ".srt", ".xml", ".log"];
const INLINE_TEXT_MAX = 64 * 1024; // 文件本体上限
const INLINE_TEXT_CHARS = 8000; // 拼进消息正文的字符上限

const ACCEPT_ATTR =
  "image/*,video/*,audio/*,.pdf,.txt,.md,.json,.csv,.srt,.docx,.doc,.rtf,.xml,.log";

function kindOf(mime: string, name: string): AttachmentKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  if (TEXT_LIKE_EXT.includes(ext) || mime.startsWith("text/")) return "document";
  return "document";
}

const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  document: "文档",
};

/** AG-UI 多模态 content part（@ag-ui/core 0.0.57 UserMessage 支持） */
type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "image" | "video" | "audio";
      source: { type: "url"; value: string; mimeType?: string };
    };

let attachSeq = 0;

export default function ChatInput({
  inProgress,
  onSend,
  onStop,
}: InputProps) {
  const nodes = useCanvasStore((s) => s.nodes);
  const { sendMessage } = useCopilotChatHeadless_c();
  const [text, setText] = useState("");
  const [refs, setRefs] = useState<WingNode[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [mention, setMention] = useState<{ start: number; q: string } | null>(
    null,
  );
  const [hi, setHi] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 进行中的上传（submit 时 await 全部完成；count 驱动按钮禁用态） */
  const uploadsRef = useRef<Map<string, Promise<void>>>(new Map());
  const [uploadingCount, setUploadingCount] = useState(0);

  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLowerCase();
    return nodes
      .filter(
        (n) =>
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
  }, [nodes, mention, refs]);

  const autoGrow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const pick = (n: WingNode) => {
    if (!mention) return;
    // 抠掉 "@查询词" 文本，引用变成 chip
    setText(
      text.slice(0, mention.start) +
        text.slice(mention.start + 1 + mention.q.length),
    );
    setRefs((r) => [...r, n]);
    setMention(null);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  // ---------- 附件：添加 / 上传 / 内联读取 ----------

  const addFiles = (files: FileList | File[]) => {
    const added: Attachment[] = [];
    for (const f of Array.from(files)) {
      if (attachments.length + added.length >= 6) break; // 一条消息最多 6 个附件
      const kind = kindOf(f.type, f.name);
      const a: Attachment = {
        key: `att_${Date.now()}_${++attachSeq}`,
        name: f.name || "未命名文件",
        mime: f.type || "application/octet-stream",
        kind,
        status: "uploading",
        ...(kind === "image" ? { previewUrl: URL.createObjectURL(f) } : {}),
      };
      added.push(a);
      setUploadingCount((n) => n + 1);
      const upload = (async () => {
        // 文本类小文件：直接内联，不上传
        if (kind === "document" && f.size <= INLINE_TEXT_MAX) {
          const t = await f.text().catch(() => "");
          setAttachments((list) =>
            list.map((x) =>
              x.key === a.key && t.trim()
                ? { ...x, status: "inline", inlineText: t.slice(0, INLINE_TEXT_CHARS) }
                : x,
            ),
          );
          return;
        }
        const url = await uploadAsset(f, f.type, f.name);
        setAttachments((list) =>
          list.map((x) =>
            x.key === a.key
              ? url
                ? { ...x, status: "ready", url }
                : { ...x, status: "error" }
              : x,
          ),
        );
      })().finally(() => {
        uploadsRef.current.delete(a.key);
        setUploadingCount((n) => Math.max(0, n - 1));
      });
      uploadsRef.current.set(a.key, upload);
    }
    if (added.length > 0) setAttachments((list) => [...list, ...added]);
  };

  const removeAttachment = (key: string) => {
    setAttachments((list) => list.filter((x) => x.key !== key));
  };

  // ---------- 发送 ----------

  const submit = async () => {
    const prompt = text.trim();
    if (inProgress || (!prompt && refs.length === 0 && attachments.length === 0))
      return;
    // 等所有上传收尾（含失败的——失败项只进文本清单不阻塞发送）
    await Promise.allSettled([...uploadsRef.current.values()]);

    const current = attachments;
    const refLines = refs
      .map((r) => {
        const label = NODE_TYPE_LABEL[r.data.nodeType] ?? r.data.nodeType;
        return `- @${r.id} ${label}「${r.data.title ?? ""}」：${(r.data.body ?? "").slice(0, 200)}`;
      })
      .join("\n");
    const attLines: string[] = [];
    const mediaParts: ContentPart[] = [];
    for (const a of current) {
      if (a.status === "inline" && a.inlineText) {
        attLines.push(`- 文档「${a.name}」内容：\n<<<\n${a.inlineText}\n>>>`);
      } else if (a.status === "ready" && a.url) {
        attLines.push(
          `- ${KIND_LABEL[a.kind]}「${a.name}」：${a.url}${a.kind === "image" ? "（可作生成参考图）" : ""}`,
        );
        if (a.kind !== "document") {
          mediaParts.push({
            type: a.kind,
            source: { type: "url", value: a.url, mimeType: a.mime },
          });
        }
      } else if (a.status === "error") {
        attLines.push(`- ${KIND_LABEL[a.kind]}「${a.name}」上传失败，未附带`);
      }
    }
    const textPart = [
      prompt || "（见附件与引用的画布卡片）",
      refLines ? `引用的画布卡片（可按 id 用 canvas_ops 操作）：\n${refLines}` : "",
      attLines.length > 0 ? `附件：\n${attLines.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    if (mediaParts.length > 0) {
      // 多模态消息：text part + 媒体 part（视觉模型服务端透传；文本模型自动降级）
      void sendMessage(
        {
          id: `u_${Date.now()}`,
          role: "user",
          content: [{ type: "text", text: textPart }, ...mediaParts],
        } as never,
      );
    } else {
      void onSend(textPart);
    }
    setText("");
    setRefs([]);
    setAttachments([]);
    setMention(null);
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const uploading = uploadingCount > 0;
  const canSend =
    !inProgress && (!!text.trim() || refs.length > 0 || attachments.length > 0);

  return (
    <div
      className="copilotKitInputContainer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        if (e.dataTransfer.files?.length) {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }
      }}
    >
      <div className="copilotKitInput relative flex flex-col">
        {refs.length > 0 || attachments.length > 0 ? (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {refs.map((r) => (
              <span
                key={r.id}
                className="inline-flex items-center gap-1 rounded border border-hairline bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-2"
              >
                <span
                  className="ws-card-dot"
                  style={{ background: NODE_META[r.data.nodeType]?.dot }}
                />
                <span className="max-w-28 truncate">
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
            {attachments.map((a) => (
              <span
                key={a.key}
                className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
                  a.status === "error"
                    ? "border-danger/40 bg-danger/10 text-danger"
                    : "border-hairline bg-surface-2 text-text-2"
                }`}
              >
                {a.kind === "image" && a.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={a.previewUrl}
                    alt={a.name}
                    className="h-4 w-4 rounded-sm object-cover"
                  />
                ) : a.kind === "image" ? (
                  <ImageIcon className="h-3 w-3" />
                ) : a.kind === "video" ? (
                  <Film className="h-3 w-3" />
                ) : a.kind === "audio" ? (
                  <Music className="h-3 w-3" />
                ) : (
                  <FileText className="h-3 w-3" />
                )}
                <span className="max-w-28 truncate">
                  {a.name.slice(0, 16)}
                  {a.status === "uploading" ? "（上传中…）" : ""}
                  {a.status === "error" ? "（失败）" : ""}
                  {a.status === "inline" ? "（内联）" : ""}
                </span>
                <button
                  type="button"
                  title="移除附件"
                  className="text-text-4 hover:text-danger"
                  onClick={() => removeAttachment(a.key)}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          ref={taRef}
          value={text}
          rows={1}
          placeholder="问点什么…@ 引用画布卡片，可粘贴/拖入附件"
          onChange={(e) => {
            setText(e.target.value);
            const m = detectMention(e.target.value, e.target.selectionStart);
            setMention(m);
            setHi(0);
            autoGrow();
          }}
          onClick={(e) => {
            const m = detectMention(e.currentTarget.value, e.currentTarget.selectionStart);
            setMention(m);
            setHi(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (e.clipboardData.files?.length) {
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }
          }}
        />

        <div className="copilotKitInputControls mt-1.5 self-end">
          <button
            type="button"
            className="copilotKitInputControlButton"
            title="添加附件（图片 / 视频 / 文档）"
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip className="h-4 w-4" />
          </button>
          {inProgress ? (
            <button
              type="button"
              className="copilotKitInputControlButton"
              title="停止生成"
              onClick={() => onStop?.()}
            >
              <Square className="h-3 w-3 fill-current motion-safe:animate-pulse" />
            </button>
          ) : (
            <button
              type="button"
              className="copilotKitInputControlButton"
              title={uploading ? "附件上传中，稍候…" : "发送（Enter 换行 Shift+Enter）"}
              disabled={!canSend || uploading}
              onClick={() => void submit()}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>

        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = ""; // 允许重复选同一个文件
          }}
        />

        {mention && candidates.length > 0 ? (
          <div className="absolute bottom-full left-0 z-20 mb-1 max-h-44 w-60 overflow-auto rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
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
