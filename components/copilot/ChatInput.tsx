"use client";

/**
 * 自定义聊天输入框（替换 CopilotSidebar 默认 Input）：
 *  - "@"引用画布卡片：MentionInput 内联 chip（与画布面板同款，open-ai-canvas
 *    结构化 token 范式）——chip 落在正文光标处，改名/删除实时同步，发送时把
 *    引用卡内容（id/类型/标题/正文摘要）拼进消息，agent 可直接按 id 操作
 *  - 附件：📎 选择 / 粘贴 / 拖放；图片视频音频上传后作为 AG-UI 多模态
 *    part（url source）随消息发送——换视觉模型后服务端自动透传；文本类
 *    文档（txt/md/json/csv/srt ≤64KB）直接内联进消息，纯文本模型也能用；
 *    二进制文档（doc/docx/rtf/pdf）经服务端 /extract-text 提取文本后内联
 *    （docx zip 直解、doc/rtf 走 soffice、pdf 走 pdftotext；失败明报原因）
 *  - Enter 发送 / Shift+Enter 换行 / IME 组合输入安全（composing 时不发送）
 *  - 运行中可继续输入：回车排队（本轮结束自动发出，Claude Code 引导范式，
 *    chips 可 × 撤回）；停止按钮真停（abort + 取消在途后端工具）并落一条
 *    「（用户中断了这一轮生成）」标记，agent 下轮知道自己被截断
 *  - 复用 stock 的 .copilotKitInput 系列样式保持原生观感
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useAgent, useCopilotChatConfiguration, useCopilotKit } from "@copilotkit/react-core/v2";
import { langgraphAgent } from "@/app/agent-provider";
import {
  ArrowUp,
  Clock,
  FileText,
  Film,
  ImageIcon,
  Loader2,
  Music,
  Pencil,
  Palette,
  Paperclip,
  Sparkles,
  Square,
  X,
  Zap,
} from "lucide-react";
import { useCanvasStore, type WingNode } from "@/lib/canvas/store";
import { useChatSession } from "@/lib/chat/session";
import MentionInput, {
  type MentionInputHandle,
  type MentionRead,
} from "@/components/canvas/MentionInput";
import {
  uploadAsset,
  extractText,
  saveAsset,
  cancelChatRun,
  cancelChatJob,
  listChatJobs,
  type ChatJob,
} from "@/lib/projects";
import { apiFetch } from "@/lib/auth";
import {
  buildContextText,
  contextSummary,
  splitMessageContext,
  type AttachmentKind,
  type MessageContext,
} from "@/lib/chat/messageContext";
import { CHAT_EDIT_MESSAGE_EVENT, CHAT_INSERT_TEXT_EVENT, OPEN_CAPABILITIES_EVENT } from "@/lib/canvas/events";
import {
  addDocCard,
  addMediaCard,
  parseAssetDrag,
  ASSET_DRAG_MIME,
} from "@/lib/canvas/ingest";
import { showToast } from "@/lib/toast";
import { AutoRunBridge } from "@/components/copilot/TaskEvents";

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

// ---------- 附件 ----------

interface Attachment {
  key: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  status: "uploading" | "ready" | "error" | "inline";
  /** 失败原因（提取/上传明报，chip tooltip 展示） */
  errorMessage?: string;
  /** 上传完成后的同源 URL（inline 文本类没有） */
  url?: string;
  /** 图片本地预览（objectURL，仅展示用） */
  previewUrl?: string;
  /** 文本类文件内联内容（发送时进正文，纯文本模型可直接读） */
  inlineText?: string;
  /** 文档落成的画布资料卡 id（写进消息上下文段，chip 点击定位到卡） */
  nodeId?: string;
  /** 文档正文字数（chip 上显示「2.0 万字」） */
  chars?: number;
}

const TEXT_LIKE_EXT = [
  ".txt", ".md", ".markdown", ".json", ".csv", ".xml", ".log",
  ".srt", ".vtt", ".ass", ".ssa",
];
/** 二进制文档 → 服务端 /extract-text 提取后内联（docx/xlsx zip 直解、doc/rtf/xls
 *  走 soffice、pdf 走 pdftotext——浏览器里读不了这些格式，只有服务端能转）。
 *  表类（xlsx/xlsm/xls）转 Markdown 表格；**漏登记会把整包字节当正文发出去**
 *  （2026-09-11 大宋异事录事故：.xlsx 掉进下面的「文本直读」兜底） */
const EXTRACT_TEXT_EXT = [
  ".doc", ".docx", ".rtf", ".pdf", ".xlsx", ".xlsm", ".xls", ".pptx", ".ppt",
];
/** 文本类文件直读上限：超过就落到上传分支（拿不到正文、agent 也读不了）。
 *  2MB 覆盖典型剧本/大纲（中文 5 万字 ≈ 150KB）；曾用 64KB，把 100KB+ 的
 *  剧本 .txt 静默踢出「落卡 + 内联」两条路（2026-09-08 review 发现） */
const TEXT_READ_MAX = 2 * 1024 * 1024;
// 拼进消息正文的字符上限：剧本文档动辄数万字，截 8000 会把剧本截残
// （「全站不截断」口径）；超长由对话滚动压缩兜底
const INLINE_TEXT_CHARS = 50000;

const ACCEPT_ATTR =
  "image/*,video/*,audio/*,.pdf,.txt,.md,.markdown,.json,.csv,.srt,.vtt,.ass,.ssa," +
  ".docx,.doc,.rtf,.pptx,.ppt,.xlsx,.xlsm,.xls,.xml,.log";

/** 文本直读的三态判定（2026-09-11 大宋异事录：.xlsx 落到直读档，17000 字正文里
 *  6967 个替换字符 + 446 个 NUL，`PK\x03\x04` 一路进到 prompt）：
 *  - NUL → 二进制容器（本地明报，不发出去）
 *  - 替换字符成片、但没有 NUL → 编码不对（国内编辑器默认 ANSI/GBK、Windows 的
 *    UTF-16）——交服务端按 UTF-8/GB18030/BOM 统一解码，别在这里瞎猜
 *  - 其余 → 就是正文 */
function sniffText(t: string): "ok" | "binary" | "encoding" {
  const sample = t.slice(0, 20000);
  if (sample.includes("\x00")) return "binary";
  let bad = 0;
  for (let i = 0; i < sample.length; i += 1) if (sample.charCodeAt(i) === 0xfffd) bad += 1;
  return bad / Math.max(1, sample.length) > 0.01 ? "encoding" : "ok";
}

function kindOf(mime: string, name: string): AttachmentKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  if (TEXT_LIKE_EXT.includes(ext) || mime.startsWith("text/")) return "document";
  return "document";
}

/** AG-UI 多模态 content part（@ag-ui/core 0.0.57 UserMessage 支持） */
type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "image" | "video" | "audio";
      source: { type: "url"; value: string; mimeType?: string };
    };

/** 排队消息（Claude Code 引导范式）：运行中提交不丢弃也不打断——先排队，
 *  本轮结束自动发出。mediaParts 已在排队时定稿（附件 await 完才进来），
 *  排水时直接按多模态/纯文本两路发送。threadKey = 入队时的 agentThreadId：
 *  排队文本属于当时的会话语境，可见与排水都按它过滤（它在新会话首次落库
 *  前后保持稳定，只在真正切会话/切项目时变化——不能用 threadId 当标，
 *  null→真 id 的首存会被误判成切会话把队清掉） */
interface QueuedMessage {
  id: string;
  /** 发送载荷：buildContextText 产物（人话段 + manifest，模型读全量） */
  text: string;
  /** 排队条显示文本：只放用户可见内容。曾直接显示 text——带引用/附件时
   *  「<<<WS-CTX>>>」机器段、@节点 id、甚至数万字文档正文全泄进输入框
   *  chip（2026-09-11 实锤） */
  display: string;
  mediaParts: ContentPart[];
  threadKey: string | undefined;
}

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
  // 多模态发送 = 复刻 v2 in-context sendMessage 内核（agent.addMessage(裸 AG-UI
  // 对象) + copilotkit.runAgent）。三条歧路都试过：废弃版 appendMessage 把裸对象
  // 直塞 gqlToAGUI 炸 "isResultMessage is not a function"（v2 迁移起发图片/视频
  // 附件就是坏的）；useCopilotChatHeadless_c 是独立 runtime，消息进不了侧栏可见
  // 聊天；onSubmitMessage 只收 string。useAgent 取的就是侧栏正在用的同一个包装
  // agent（注册表单例），runAgent 走 core 的流式生命周期，侧栏照常渲染。
  const chatConfig = useCopilotChatConfiguration();
  const { agent: chatAgent } = useAgent({ agentId: chatConfig?.agentId ?? "default" });
  const { copilotkit } = useCopilotKit();
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
  /** 附件镜像 ref（发送路径的唯一事实源）：submit 会 await 在途上传——await
   *  归来后组件闭包里的 attachments 仍是点击那帧的快照（status 还是
   *  "uploading"，三分支全匹配不上），2026-09-07 霸王龙项目实锤：用户传图
   *  未等「上传中」消失就发送，五次全被静默降级成纯文本、agent 一张图都没
   *  收到。状态更新一律走 writeAttachments（同步写 ref + setAttachments） */
  const attachmentsRef = useRef<Attachment[]>([]);
  const writeAttachments = useCallback((next: Attachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  // 长任务条：轮询会话在途后端任务（出图/拆解/技能），可逐任务取消。
  // 聊天进度消息会滚走，这里常驻；无任务时整条隐藏
  const threadId = useChatSession((s) => s.threadId);
  const [jobs, setJobs] = useState<ChatJob[]>([]);

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

  // 编辑重发（UserBubble 铅笔）：**恢复用户自己那句话 + @ 引用 + 附件**，而不是把
  // 附件正文倒进输入框（2026-09-11：此前铅笔回填的是气泡全文本，一条 1.2 万字
  // 剧本会整篇灌进输入条）。引用卡片回填成 @ chip（MentionInput 按 id 找卡），
  // 文档从画布资料卡取回正文重建 inline 附件——编辑重发不会丢掉「模型能看到全文」
  // 的语义；媒体按原 URL 重建 ready 附件；失败的附件不回填（重发不该继承失败）。
  const [editingMsg, setEditingMsg] = useState<{ id: string } | null>(null);
  useEffect(() => {
    const onEdit = (e: Event) => {
      const { id, content } = (e as CustomEvent<{ id: string; content?: unknown }>).detail;
      const { text: rawText, ctx } = splitMessageContext(content);
      setEditingMsg({ id });
      // 引用卡在显示文本里是字面量 `@标题前12字`（MentionInput 的 display 把 chip
      // 序列化成文字）——回填前先摘掉，否则 appendMention 会把同一张卡上两次
      // （一句字面量 + 一颗 chip），重发后引用行也跟着重复
      let text = rawText;
      for (const r of ctx?.refs ?? []) {
        const token = `@${(r.title || "无题").slice(0, 12)}`;
        const at = text.indexOf(token);
        if (at >= 0)
          text = `${text.slice(0, at)}${text.slice(at + token.length)}`.replace(/[ \t]{2,}/g, " ");
      }
      edRef.current?.setValue(text.trim());
      const nodes = useCanvasStore.getState().nodes;
      for (const r of ctx?.refs ?? []) {
        if (nodes.some((n) => n.id === r.id)) edRef.current?.appendMention(r.id);
      }
      const restored: Attachment[] = [];
      for (const a of ctx?.attachments ?? []) {
        if (a.error) continue;
        if (a.kind === "document" && a.nodeId) {
          const body = nodes.find((n) => n.id === a.nodeId)?.data.body;
          if (!body) continue;
          restored.push({
            key: `edit_${a.nodeId}`,
            name: a.name,
            mime: "text/plain",
            kind: "document",
            status: "inline",
            inlineText: body.slice(0, INLINE_TEXT_CHARS),
            nodeId: a.nodeId,
            chars: body.length,
          });
        } else if (a.url) {
          restored.push({
            key: `edit_${a.kind}_${restored.length}`,
            name: a.name,
            mime: "",
            kind: a.kind,
            status: "ready",
            url: a.url,
          });
        }
      }
      writeAttachments(restored);
      edRef.current?.focus();
    };
    window.addEventListener(CHAT_EDIT_MESSAGE_EVENT, onEdit);
    return () => window.removeEventListener(CHAT_EDIT_MESSAGE_EVENT, onEdit);
  }, [writeAttachments]);

  // ---------- 附件：添加 / 上传 / 内联读取 ----------

  const addFiles = useCallback((files: FileList | File[]) => {
    const added: Attachment[] = [];
    for (const f of Array.from(files)) {
      // 不设张数上限（juben c28ab13a 同款裁决：批量设定图一次带齐）——附件是
      // URL 型 part 无消息体积压力；上游视觉模型若有限制会明报，不在此静默预砍
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
        const ext = a.name.includes(".")
          ? a.name.slice(a.name.lastIndexOf(".")).toLowerCase()
          : "";
        const fail = (errorMessage: string) =>
          writeAttachments(
            attachmentsRef.current.map((x) =>
              x.key === a.key ? { ...x, status: "error", errorMessage } : x,
            ),
          );
        const isTextLike = TEXT_LIKE_EXT.includes(ext) || a.mime.startsWith("text/");
        // 二进制文档（doc/docx/rtf/pdf/xlsx/pptx…）浏览器读不了，交服务端提取；
        // 文本类超过直读上限（2MB）也走服务端——它的解码上限是 20MB，此前这种
        // 大剧本会掉到上传分支变成一条 URL，agent 根本拿不到正文
        const viaServer =
          kind === "document" &&
          (EXTRACT_TEXT_EXT.includes(ext) || (isTextLike && f.size > TEXT_READ_MAX));
        if (viaServer || (kind === "document" && f.size <= TEXT_READ_MAX)) {
          let text: string | null = null;
          if (viaServer) {
            const t = await extractText(f, a.name);
            if (!t.ok) return fail(t.error);
            text = t.text;
          } else {
            const head = new Uint8Array(await f.slice(0, 2).arrayBuffer());
            // UTF-16 BOM（Windows 记事本「Unicode」存的剧本）：本地必然读成乱码，
            // 直接交服务端按 BOM 解码
            const utf16Bom =
              (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
            const raw = utf16Bom ? "" : await f.text().catch(() => "");
            if (!raw.trim() && !utf16Bom) return fail("文件为空或不是文本格式");
            const sniff = utf16Bom ? "encoding" : sniffText(raw);
            // 二进制容器（zip/OLE…）漏登记时的最后一道闸：曾把整包字节当正文发出
            if (sniff === "binary") {
              return fail(
                `无法解析 ${ext || "该文件"}：不是可读文本（二进制格式）。文档附件支持 .doc/.docx/.rtf/.pdf/.xlsx/.xlsm/.xls/.pptx/.ppt 与文本类文件，其余请转成 .md/.txt/.csv 后重传`,
              );
            }
            if (sniff === "encoding") {
              // 编码不对（ANSI/GBK/UTF-16）→ 服务端统一解码（一份实现，别在浏览器里猜）
              const t = await extractText(f, a.name);
              if (!t.ok) return fail(t.error);
              text = t.text;
            } else {
              text = raw;
            }
          }
          if (!text.trim()) return fail("未提取到文本（文件可能是空的或没有文字层）");
          // 落资料卡（2026-09-08 @ 体系补缺）：文档此前只内联在当轮消息里，
          // 后续轮次无法点名引用、不落卡、不进素材库——用户上传资料的主要
          // 形态恰好走这条路。建卡后 @/连线/跨会话/跨视图全通。
          const id = addDocCard(a.name, text);
          if (id) showToast(`已存为资料卡，可在画布 @ 引用`);
          writeAttachments(
            attachmentsRef.current.map((x) =>
              x.key === a.key
                ? {
                    ...x,
                    status: "inline",
                    inlineText: text.slice(0, INLINE_TEXT_CHARS),
                    nodeId: id ?? undefined,
                    chars: text.length,
                  }
                : x,
            ),
          );
          return;
        }
        const url = await uploadAsset(f, f.type, f.name);
        // 聊天上传的媒体自动进素材库（与画布上传对齐：此前只有画布节点的
        // 媒体入库，聊天上传的图/视频/音频是"一次性"的，库和 @ 都够不着）
        if (url && (kind === "image" || kind === "video" || kind === "audio")) {
          const pid = useCanvasStore.getState().projectId;
          if (pid) void saveAsset(pid, { kind, title: a.name, url, source: "upload" });
        }
        writeAttachments(
          attachmentsRef.current.map((x) =>
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
    if (added.length > 0) writeAttachments([...attachmentsRef.current, ...added]);
  }, [writeAttachments]);

  // 整个聊天侧栏都是文件落区（v2 aside 是它的 DOM，命令式挂监听）：
  // 拖到侧栏任意处即入附件，不再要求精确落到输入条。画布卡拖放（→ @ 引用）
  // 仍由输入条容器自己的 onDrop 处理——这里 defaultPrevented / 节点载荷直接放行。
  // 依赖 [addFiles] 重订阅拿最新闭包（编译器禁 ref/模块变量赋值，重挂 4 个
  // 监听器的代价可忽略）
  useEffect(() => {
    const aside = document.querySelector("aside.copilotKitSidebar") as HTMLElement | null;
    if (!aside) return;
    let dragDepth = 0;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e) || e.defaultPrevented) return;
      dragDepth += 1;
      aside.classList.add("ws-chat-drop");
    };
    const onLeave = () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) aside.classList.remove("ws-chat-drop");
    };
    const onDrop = (e: DragEvent) => {
      dragDepth = 0;
      aside.classList.remove("ws-chat-drop");
      // 输入条容器已处理（@ 引用等）或无文件 → 不接手
      if (e.defaultPrevented || !e.dataTransfer?.files?.length) return;
      e.preventDefault();
      e.stopPropagation();
      addFiles(e.dataTransfer.files);
    };
    aside.addEventListener("dragover", onOver);
    aside.addEventListener("dragenter", onEnter);
    aside.addEventListener("dragleave", onLeave);
    aside.addEventListener("drop", onDrop);
    return () => {
      aside.removeEventListener("dragover", onOver);
      aside.removeEventListener("dragenter", onEnter);
      aside.removeEventListener("dragleave", onLeave);
      aside.removeEventListener("drop", onDrop);
    };
  }, [addFiles]);

  const removeAttachment = (key: string) => {
    writeAttachments(attachmentsRef.current.filter((x) => x.key !== key));
  };

  // ---------- 发送 ----------

  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const queueRef = useRef<QueuedMessage[]>([]);
  const writeQueue = useCallback((next: QueuedMessage[]) => {
    queueRef.current = next;
    setQueue(next);
  }, []);
  // 只展示当前会话的排队项（别的会话排队项留在栈里，切回去还能看见/排水）
  const agentThreadId = useChatSession((s) => s.agentThreadId);
  const visibleQueue = queue.filter((q) => q.threadKey === agentThreadId);

  /** 已定稿载荷的统一发送口（submit 与排队排水共用） */
  const sendComposed = useCallback(
    ({ text, mediaParts }: { text: string; mediaParts: ContentPart[] }) => {
      if (mediaParts.length > 0) {
        // 多模态消息：text part + 媒体 part（视觉模型服务端透传；文本模型自动降级）
        if (chatAgent) {
          chatAgent.addMessage({
            id: `u_${Date.now()}`,
            role: "user",
            content: [{ type: "text", text }, ...mediaParts],
          } as never);
          void copilotkit.runAgent({ agent: chatAgent }).catch((e: unknown) => {
            console.error("[ChatInput] 多模态 runAgent 失败", e);
          });
        }
      } else {
        if (onSend) void onSend(text);
      }
    },
    [chatAgent, copilotkit, onSend],
  );

  // 排水：运行→空闲的跳变沿自动发出下一条排队消息（无论本轮是跑完还是
  // 被停止——停止后排队的引导恰好作为新一轮指令接上）；别的会话的排队
  // 项跳过，留在栈里
  const wasRunningRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const was = wasRunningRef.current;
    wasRunningRef.current = inProgress;
    if (!was || inProgress || queueRef.current.length === 0) return;
    const cur = useChatSession.getState().agentThreadId;
    const idx = queueRef.current.findIndex((q) => q.threadKey === cur);
    if (idx === -1) return;
    const next = queueRef.current[idx];
    writeQueue(queueRef.current.filter((_, i) => i !== idx));
    sendComposed(next);
  }, [inProgress, writeQueue, sendComposed]);

  const submit = async () => {
    const r = lastRead;
    const prompt = r?.display.trim() ?? "";
    const mentioned = (r?.mentionIds ?? [])
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is WingNode => Boolean(n));
    if (!prompt && mentioned.length === 0 && attachments.length === 0) return;
    // 编辑重发要截断历史再发，运行中做等于把正在跑的轮次脚下抽薪——拦下
    if (editingMsg && inProgress) {
      showToast("正在生成中，等本轮结束（或先停止）再编辑重发");
      return;
    }
    // 编辑重发：截断被编辑消息及其之后的历史，新发送即替代它
    if (editingMsg) {
      const msgs = langgraphAgent.messages ?? [];
      const idx = msgs.findIndex((m) => m.id === editingMsg.id);
      if (idx > 0) langgraphAgent.setMessages?.(msgs.slice(0, idx) as never);
      setEditingMsg(null);
    }

    // 等所有上传收尾（含失败的——失败项只进文本清单不阻塞发送）。
    // 收尾后必须读 attachmentsRef：await 归来时组件闭包里的 attachments
    // 仍是点击帧的快照（status="uploading"，ready/inline/error 三分支全
    // 匹配不上，附件被静默丢弃——霸王龙项目「发了图 agent 没收到」实锤）
    await Promise.allSettled([...uploadsRef.current.values()]);

    const current = attachmentsRef.current;
    // 消息正文 = 显示文本 + 上下文段（契约见 lib/chat/messageContext.ts）：
    // 模型照旧拿到引用卡片与附件全文，界面只渲染用户自己那句话 + chip。
    // 引用行正文**不截断**（2026-09-04「全站都不要字数截断」口径，此前这里
    // 偷偷 slice(0,200)，是那轮决定漏改的一处）
    const ctx: MessageContext = {
      refs: mentioned.map((r2) => ({
        id: r2.id,
        type: r2.data.nodeType,
        title: r2.data.title ?? "",
        snippet: r2.data.body ?? "",
      })),
      attachments: current.map((a) => {
        if (a.status === "inline" && a.inlineText)
          return {
            kind: "document" as const,
            name: a.name,
            nodeId: a.nodeId,
            chars: a.chars,
            body: a.inlineText,
          };
        if (a.status === "ready" && a.url) return { kind: a.kind, name: a.name, url: a.url };
        return { kind: a.kind, name: a.name, error: a.errorMessage || "上传未完成" };
      }),
    };
    const mediaParts: ContentPart[] = current
      .filter((a) => a.status === "ready" && a.url && a.kind !== "document")
      .map((a) => ({
        type: a.kind as "image" | "video" | "audio",
        source: { type: "url" as const, value: a.url as string, mimeType: a.mime },
      }));
    const textPart = buildContextText(prompt, ctx);

    if (inProgress) {
      // 运行中提交 = 排队引导（Claude Code 范式）：不掐断本轮也不要求用户
      // 干等，本轮结束（跑完或被停止）后自动发出
      writeQueue([
        ...queueRef.current,
        {
          id: `q_${Date.now()}_${queueRef.current.length}`,
          text: textPart,
          // 显示口径：用户那句话（display 形态，@ 引用为标题）；只丢附件/
          // 引用没打字时用上下文摘要兜展示（submit 入队前已保证两者不会同时为空）
          display: prompt || contextSummary(ctx),
          mediaParts,
          threadKey: useChatSession.getState().agentThreadId,
        },
      ]);
    } else {
      sendComposed({ text: textPart, mediaParts });
    }
    edRef.current?.setValue("");
    writeAttachments([]);
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
        // 素材库项拖进来 = 建媒体卡 + @ 引用（库项不是画布卡，@ 的载体必须
        // 是卡——建卡后即进候选，语义与「库图即资产」一致）
        const assetRaw = e.dataTransfer.getData(ASSET_DRAG_MIME);
        if (assetRaw) {
          e.preventDefault();
          const p = parseAssetDrag(assetRaw);
          const id = p ? addMediaCard(p.kind, p.url, p.title) : null;
          if (id) edRef.current?.appendMention(id);
          return;
        }
        if (e.dataTransfer.files?.length) {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }
      }}
    >
      {/* 任务终态自动续跑桥：借宿在侧栏 chat context 内（context 分裂实测：
          侧栏外的 headless hook 消息进了另一套 context，可见聊天收不到） */}
      <AutoRunBridge onSend={onSend} />
      {editingMsg ? (
          <div className="mb-1 flex items-center gap-2 rounded-md border border-accent-soft bg-accent/5 px-2 py-1 text-[11px] text-text-2">
            <Pencil className="h-3 w-3 text-accent" />
            正在编辑一条消息，发送将从这里重新展开对话
            <button
              type="button"
              className="ml-auto rounded p-0.5 text-text-4 hover:text-text"
              aria-label="取消编辑" data-tip="取消编辑"
              onClick={() => {
                setEditingMsg(null);
                edRef.current?.setValue("");
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : null}
      <div className="copilotKitInput relative flex flex-col">
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
            {attachments.map((a) => (              <span
                key={a.key}
                data-tip={a.status === "error" ? (a.errorMessage || "上传失败") : undefined}
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

        {visibleQueue.length > 0 ? (
          <div className="mb-1.5 flex flex-col gap-1">
            {visibleQueue.map((q) => (
              <div
                key={q.id}
                className="flex items-center gap-1.5 rounded-md border border-accent-soft bg-accent/5 px-2 py-1 text-[11px] text-text-2"
              >
                <Clock className="h-3 w-3 shrink-0 text-accent" />
                <span
                  className="min-w-0 flex-1 truncate"
                  data-tip="已排队：本轮结束后自动发送"
                >
                  {q.display}
                </span>
                <button
                  type="button"
                  data-tip="移除排队消息" aria-label="移除排队消息"
                  className="shrink-0 rounded p-0.5 text-text-4 transition-colors hover:text-danger"
                  onClick={() =>
                    writeQueue(queueRef.current.filter((x) => x.id !== q.id))
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
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
            placeholder={
              inProgress
                ? "生成中…此时回车将排队，本轮结束后自动发送；点 ■ 可停止"
                : "问点什么…@ 引用画布卡片，可粘贴/拖入附件"
            }
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

        {/* 附件/技能居左 / 发送居右（ChatGPT·Claude 共识布局）：发送是唯一主动作，
            实心 accent 圆钮与左侧幽灵按钮拉开主次。「技能」原在侧栏头部——那是
            告诉用户"这个产品能干什么"，与当前会话无关，头部黄金位留给会话本身 */}
        <div className="copilotKitInputControls mt-1.5">
          <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="copilotKitInputControlButton"
            data-tip="添加附件（图片 / 视频 / 文档）" aria-label="添加附件（图片 / 视频 / 文档）"
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="copilotKitInputControlButton"
            data-tip="技能（手册与指令）" aria-label="技能"
            data-track="chat.skills"
            onClick={() =>
              window.dispatchEvent(new CustomEvent(OPEN_CAPABILITIES_EVENT))
            }
          >
            <Sparkles className="h-4 w-4" />
          </button>
          </div>
          {inProgress ? (
            <button
              type="button"
              className="copilotKitInputSendButton"
              data-tip="停止生成" aria-label="停止生成"
              onClick={() => {
                // 停止要真停：客户端 abort 之外，把在途后端工具（出图/拆解/技能）
                // 一并取消，否则烧钱循环继续跑完（分镜批量出图取消同范式）
                void cancelChatRun(useChatSession.getState().threadId);
                onStop?.();
                // 打断告知（Claude Code "[Request interrupted]" 范式）：残篇之后
                // 落一条用户口吻的标记——agent 下轮据此知道自己上一轮是中途
                // 被截断的，不会把半截话当完整回答或自顾自续跑
                chatAgent?.addMessage({
                  id: `u_stop_${Date.now()}`,
                  role: "user",
                  content: "（用户中断了这一轮生成）",
                } as never);
              }}
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              className="copilotKitInputSendButton"
              data-tip={uploading ? "附件上传中，稍候…" : "发送（Enter 发送，Shift+Enter 换行）"} aria-label={uploading ? "附件上传中，稍候…" : "发送（Enter 发送，Shift+Enter 换行）"}
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
          <div className="absolute bottom-full left-0 z-20 mb-1 max-h-48 w-72 overflow-auto rounded-lg bg-surface-1 p-1 ws-elev-popover">
            <p className="px-2 pb-1 pt-0.5 text-[10px] text-text-4">
              Langflow 技能（回车选用）
            </p>
            {slashCandidates.map((s, i) => (
              <button
                key={s.name}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                className={`flex w-full flex-col gap-0.5 rounded-[4px] px-2 py-1.5 text-left text-xs ${
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
                <span className="flex items-center gap-1 truncate font-medium">
                  <Zap className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />
                  {s.name}
                </span>
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
