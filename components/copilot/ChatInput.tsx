"use client";

/**
 * 自定义聊天输入框（替换 CopilotSidebar 默认 Input）：
 *  - "@"引用画布卡片：MentionInput 内联 chip（与画布面板同款，open-ai-canvas
 *    结构化 token 范式）——chip 落在正文光标处，改名/删除实时同步，发送时把
 *    引用卡内容（id/类型/标题/正文摘要）拼进消息，agent 可直接按 id 操作
 *  - 附件：📎 选择 / 粘贴 / 拖放；图片视频音频上传后作为 AG-UI 多模态
 *    part（url source）随消息发送——换视觉模型后服务端自动透传；文本类
 *    文档（txt/md/json/csv/srt ≤64KB）直接内联进消息，纯文本模型也能用
 *  - Enter 发送 / Shift+Enter 换行 / IME 组合输入安全（composing 时不发送）
 *  - 运行中显示停止按钮；复用 stock 的 .copilotKitInput 系列样式保持原生观感
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useCopilotChat } from "@copilotkit/react-core";
import { langgraphAgent } from "@/app/agent-provider";
import {
  ArrowUp,
  Brain,
  FileText,
  Film,
  ImageIcon,
  Loader2,
  Music,
  Palette,
  Paperclip,
  Square,
  X,
} from "lucide-react";
import { useCanvasStore, type WingNode } from "@/lib/canvas/store";
import { useChatSession } from "@/lib/chat/session";
import MentionInput, {
  type MentionInputHandle,
  type MentionRead,
} from "@/components/canvas/MentionInput";
import {
  uploadAsset,
  cancelChatRun,
  cancelChatJob,
  listChatJobs,
  type ChatJob,
} from "@/lib/projects";
import { apiFetch } from "@/lib/auth";
import { CHAT_INSERT_TEXT_EVENT } from "@/lib/canvas/events";

/** caret 前的 /slash 片段（行首或空格后的 "/xxx"）→ 技能菜单 */
function detectSlash(
  text: string,
  caret: number,
): { start: number; q: string } | null {
  const m = text.slice(0, caret).match(/(^|\s)\/([^\s/]{0,20})$/);
  if (!m) return null;
  return { start: caret - m[2].length - 1, q: m[2] };
}

// ---------- 技能（slash 菜单数据源，/agent-service/skills） ----------

interface SkillMeta {
  name: string;
  description: string;
  params: { name: string; desc: string }[];
}

const NODE_TYPE_LABEL: Record<string, string> = {
  note: "文本",
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

/** v2 input 槽位绑定 props（用不到的 value/onChange 忽略：编辑器非受控自管） */
interface ChatInputSlotProps {
  isRunning?: boolean;
  onSubmitMessage?: (value: string) => void;
  onStop?: () => void;
}

export default function ChatInput({
  isRunning: inProgress,
  onSubmitMessage: onSend,
  onStop,
}: ChatInputSlotProps) {
  const nodes = useCanvasStore((s) => s.nodes);
  // 开源 headless 面（appendMessage = 入列 + 触发 run；多模态 content parts 同路）
  const { appendMessage: sendMessage } = useCopilotChat();
  // 内联引用编辑器（与画布面板同款）：display 文本镜像 + 序列化结果
  const edRef = useRef<MentionInputHandle>(null);
  const [lastRead, setLastRead] = useState<MentionRead | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [slash, setSlash] = useState<{ start: number; q: string } | null>(null);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [hi, setHi] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 进行中的上传（submit 时 await 全部完成；count 驱动按钮禁用态） */
  const uploadsRef = useRef<Map<string, Promise<void>>>(new Map());
  const [uploadingCount, setUploadingCount] = useState(0);

  // 长任务条：轮询会话在途后端任务（出图/拆解/技能），可逐任务取消。
  // 聊天进度消息会滚走，这里常驻；无任务时整条隐藏
  const threadId = useChatSession((s) => s.threadId);
  const [jobs, setJobs] = useState<ChatJob[]>([]);

  // 思考中指示条（novanova ThinkingBlock 范式）：@copilotkit/core 的事件转换器
  // 不处理 REASONING_* 事件（hook 的 messages 里没有），所以直接订阅注册的
  // HttpAgent——它自己会物化 role="reasoning" 的消息。运行中实时展示、出正文后收起
  const agent = langgraphAgent;
  const [thinking, setThinking] = useState("");
  const agentRef = useRef<typeof agent | null>(null);
  useEffect(() => {
    // useAgent 可能每次渲染给新对象：同一实例只订阅一次，避免解绑风暴丢事件
    if (!agent || agentRef.current === agent) return;
    agentRef.current = agent;
    let streaming = false;
    let buffer = "";
    return agent.subscribe({
      // 包装 agent 只分发 core 认识的回调，但 raw onEvent 能看到全部事件
      // （含 REASONING_*）——思考文本在这里自己攒
      onEvent: (p) => {
        const ev = (p as {
          event?: {
            type?: string;
            event?: { event?: string; data?: { chunk?: { additional_kwargs?: { reasoning_content?: string }; content?: unknown } } };
          };
        }).event;
        const t = String(ev?.type ?? "");
        // 思考增量藏在 RAW 包装的 on_chat_model_stream 流事件里
        //（core 不认识 REASONING_* 与 langchain 流事件，统一打成 RAW）
        if (t === "RUN_FINISHED" || t === "RUN_ERROR") {
          streaming = false;
          setThinking("");
          return;
        }
        if (t !== "RAW") return;
        const stream = ev?.event;
        if (stream?.event !== "on_chat_model_stream") return;
        const chunk = stream.data?.chunk;
        const reasoning = chunk?.additional_kwargs?.reasoning_content;
        if (process.env.NODE_ENV !== "production")
          console.log(
            "[ticker] stream:",
            stream.event,
            "rc:",
            typeof reasoning === "string" ? reasoning.length : String(reasoning),
            "content:",
            typeof chunk?.content === "string" ? chunk.content.length : "-",
            "streaming:",
            streaming,
          );
        if (typeof reasoning === "string" && reasoning) {
          if (!streaming) {
            streaming = true;
            buffer = "";
          }
          buffer += reasoning;
          setThinking(buffer.slice(-160));
        } else if (chunk?.content) {
          // 正文开始输出 → 思考结束，指示条收起
          streaming = false;
          setThinking("");
        }
      },
    }).unsubscribe;
  }, [agent]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const list = threadId ? await listChatJobs(threadId) : [];
      if (alive) setJobs(list);
    };
    void tick();
    const timer = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [threadId]);

  // 技能清单：挂载拉一次（slash 菜单数据源），失败静默（菜单只是不出现）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await apiFetch("/agent-service/skills");
        if (r.ok && alive) setSkills((await r.json()) as SkillMeta[]);
      } catch {
        /* 服务离线：slash 菜单不可用即可 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const slashCandidates = useMemo(() => {
    if (!slash) return [];
    const q = slash.q.toLowerCase();
    return skills
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [skills, slash]);

  const pickSkill = (s: SkillMeta) => {
    if (!slash) return;
    // 抠掉 "/查询词"，填入技能模板（用户接着补任务描述与参数）
    edRef.current?.deleteBeforeCaret(slash.q.length + 1);
    edRef.current?.insertAtCaret(`调用技能「${s.name}」处理：`);
    setSlash(null);
  };

  // 能力面板（CapabilitiesDialog）点了示例句/技能 → 插入输入条并聚焦
  useEffect(() => {
    const onInsert = (e: Event) => {
      const { text } = (e as CustomEvent<{ text: string }>).detail;
      if (text) edRef.current?.insertAtCaret(text);
    };
    window.addEventListener(CHAT_INSERT_TEXT_EVENT, onInsert);
    return () => window.removeEventListener(CHAT_INSERT_TEXT_EVENT, onInsert);
  }, []);

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
    const r = lastRead;
    const prompt = r?.display.trim() ?? "";
    const mentioned = (r?.mentionIds ?? [])
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is WingNode => Boolean(n));
    if (inProgress || (!prompt && mentioned.length === 0 && attachments.length === 0))
      return;
    // 等所有上传收尾（含失败的——失败项只进文本清单不阻塞发送）
    await Promise.allSettled([...uploadsRef.current.values()]);

    const current = attachments;
    const refLines = mentioned
      .map((r2) => {
        const label = NODE_TYPE_LABEL[r2.data.nodeType] ?? r2.data.nodeType;
        return `- @${r2.id} ${label}「${r2.data.title ?? ""}」：${(r2.data.body ?? "").slice(0, 200)}`;
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
      if (onSend) void onSend(textPart);
    }
    edRef.current?.setValue("");
    setAttachments([]);
    setSlash(null);
  };

  // slash 菜单键盘导航（capture 阶段拦下，避免 MentionInput 的 Enter 提交抢先）
  const onSlashKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(slash && slashCandidates.length > 0)) return;
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setHi((h) => (h + 1) % slashCandidates.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setHi((h) => (h - 1 + slashCandidates.length) % slashCandidates.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      pickSkill(slashCandidates[hi]);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setSlash(null);
    }
  };

  const uploading = uploadingCount > 0;
  const canSend =
    !inProgress &&
    (Boolean(lastRead?.display.trim()) ||
      (lastRead?.mentionIds.length ?? 0) > 0 ||
      attachments.length > 0);

  return (
    <div
      className="copilotKitInputContainer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        // 画布卡拖进来 = @ 引用（novanova 拖拽引用范式）：把手携带节点 id，
        // 落成 chip（appendMention 自带去重），不当作文件附件
        const nodeRaw = e.dataTransfer.getData("application/x-wingsight-node");
        if (nodeRaw) {
          e.preventDefault();
          try {
            const { id } = JSON.parse(nodeRaw) as { id?: string };
            if (id && useCanvasStore.getState().nodes.some((n) => n.id === id)) {
              edRef.current?.appendMention(id);
            }
          } catch {
            /* 非法载荷忽略 */
          }
          return;
        }
        if (e.dataTransfer.files?.length) {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }
      }}
    >
      <div className="copilotKitInput relative flex flex-col">
        {thinking ? (
          <div className="ws-thinking-row mb-1.5 flex items-center gap-1.5 rounded-md border border-accent-soft bg-surface-1 px-2 py-1 text-[11px] text-text-3">
            <Brain className="h-3 w-3 shrink-0 text-accent motion-safe:animate-pulse" />
            <span className="min-w-0 flex-1 truncate">思考中：{thinking}</span>
          </div>
        ) : null}
        {jobs.length > 0 ? (
          <div className="mb-1.5 flex flex-col gap-1">
            {jobs.map((j) => (
              <div
                key={j.jobId}
                className="ws-task-row flex items-center gap-1.5 rounded-md border border-hairline bg-surface-2 px-2 py-1 text-[11px] text-text-2"
              >
                {j.kind === "imagegen" ? (
                  <Palette className="h-3 w-3 shrink-0 text-accent" />
                ) : (
                  <Loader2 className="h-3 w-3 shrink-0 motion-safe:animate-spin text-accent" />
                )}
                <span className="min-w-0 flex-1 truncate">{j.title}</span>
                {j.total > 0 ? (
                  <span className="shrink-0 tabular-nums text-text-3">
                    {j.done}/{j.total}
                  </span>
                ) : null}
                <button
                  type="button"
                  data-tip="取消此任务" aria-label={`取消任务：${j.title}`}
                  className="shrink-0 rounded p-0.5 text-text-4 transition-colors hover:text-danger"
                  onClick={() => {
                    if (threadId) void cancelChatJob(threadId, j.jobId);
                    setJobs((list) => list.filter((x) => x.jobId !== j.jobId));
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="mb-1.5 flex flex-wrap gap-1">
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
                  data-tip="移除附件" aria-label="移除附件"
                  className="text-text-4 hover:text-danger"
                  onClick={() => removeAttachment(a.key)}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div
          onKeyDownCapture={onSlashKeyDownCapture}
          onPasteCapture={(e) => {
            // 粘贴的文件走附件链路（文本粘贴交给编辑器）
            if (e.clipboardData.files?.length) {
              e.preventDefault();
              e.stopPropagation();
              addFiles(e.clipboardData.files);
            }
          }}
        >
          <MentionInput
            ref={edRef}
            placeholder="问点什么…@ 引用画布卡片，可粘贴/拖入附件"
            minHeight={28}
            maxHeight={160}
            enterToSubmit
            className="copilotKitInputEditor"
            onChange={setLastRead}
            onCaret={({ text, caret }) => {
              setSlash(detectSlash(text, caret));
              setHi(0);
            }}
            onSubmit={() => {
              if (slash && slashCandidates.length > 0) {
                pickSkill(slashCandidates[hi]);
                return;
              }
              void submit();
            }}
          />
        </div>

        <div className="copilotKitInputControls mt-1.5 self-end">
          <button
            type="button"
            className="copilotKitInputControlButton"
            data-tip="添加附件（图片 / 视频 / 文档）" aria-label="添加附件（图片 / 视频 / 文档）"
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip className="h-4 w-4" />
          </button>
          {inProgress ? (
            <button
              type="button"
              className="copilotKitInputControlButton"
              data-tip="停止生成" aria-label="停止生成"
              onClick={() => {
                // 停止要真停：客户端 abort 之外，把在途后端工具（出图/拆解/技能）
                // 一并取消，否则烧钱循环继续跑完（分镜批量出图取消同范式）
                void cancelChatRun(useChatSession.getState().threadId);
                onStop?.();
              }}
            >
              <Square className="h-3 w-3 fill-current motion-safe:animate-pulse" />
            </button>
          ) : (
            <button
              type="button"
              className="copilotKitInputControlButton"
              data-tip={uploading ? "附件上传中，稍候…" : "发送（Enter 换行 Shift+Enter）"} aria-label={uploading ? "附件上传中，稍候…" : "发送（Enter 换行 Shift+Enter）"}
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

        {slash && slashCandidates.length > 0 ? (
          <div className="absolute bottom-full left-0 z-20 mb-1 max-h-48 w-72 overflow-auto rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
            <p className="px-2 pb-1 pt-0.5 text-[10px] text-text-4">
              Langflow 技能（回车选用）
            </p>
            {slashCandidates.map((s, i) => (
              <button
                key={s.name}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs ${
                  i === hi ? "bg-surface-2 text-text" : "text-text-2"
                }`}
                onClick={() => pickSkill(s)}
                onMouseEnter={() => setHi(i)}
                data-tip={
                  s.params.length > 0
                    ? `参数：${s.params.map((p) => p.name).join("、")}`
                    : undefined
                } aria-label={
                  s.params.length > 0
                    ? `参数：${s.params.map((p) => p.name).join("、")}`
                    : undefined
                }
              >
                <span className="truncate font-medium">⚡ {s.name}</span>
                {s.description ? (
                  <span className="truncate text-[11px] text-text-4">
                    {s.description}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
