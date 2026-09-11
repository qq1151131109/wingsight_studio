"use client";

/**
 * 用户消息的「上下文段」契约（2026-09-11）。
 *
 * 行业共识（codex / gemini-cli / opencode 源码 + 消费级产品）：**对话记录显示
 * 实体，内容走带外通道**——opencode 把文件存成 `part.type==='file'` 显示 chip、
 * 内容作为 synthetic part 只喂模型；gemini-cli 历史里留原始 `@path`、展开的全文
 * 只进模型 payload；codex 干脆只给路径。此前我们把附件正文直接拼进用户消息正文
 * 再原样渲染——本地实测一条 1.2 万字剧本让气泡高达 21,469px，占整个会话滚动区
 * 的 94%，并连带污染轮次轨摘要、把全文倒进「编辑重发」的输入框。
 *
 * 为什么不用 AG-UI 原生的 document part（2026-09-11 实测否决）：ag_ui_langgraph
 * 会把它转成 LangChain 的 `file` 块，而我们的模型端点（deepseek，OpenAI 兼容）
 * 明确拒绝——`document` 变体「unknown variant」直接不认，`file` 块只收图片
 * （webp/png/jpeg/gif，「unsupported file」）。所以正文继续走 text part（模型侧
 * 行为与今天完全一致），只是**在正文里插一个界标**，显示层据此把上下文段摘掉、
 * 换成 chip。
 *
 * 两段结构（同一个 text part 内，界标分隔）：
 *
 *   <<显示文本——用户自己说的话，就是气泡里那一句>>
 *   <<<WS-CTX>>>
 *   <<给模型看的人话上下文：引用卡片 + 附件清单 + 文档正文，与旧格式一字不差>>
 *   <<<WS-MANIFEST>>>
 *   <<给界面看的 JSON 元数据（不含正文）：chip 的名字/类型/id/字数>>
 *
 * 人话段与 manifest 分开，是因为**两种消费者要的东西不同**：模型要能读的自然语
 * 言，界面要结构化字段。让界面去正则人话段（文件名里的「」、标题里的换行都能
 * 把它拆坏）是脆弱设计；manifest 用 JSON 解析，确定性可测。
 *
 * 写入口唯一：`buildContextText`；读入口唯一：`splitMessageContext`。两者必须
 * 一起改（口径漂移是本仓库反复踩的坑，见 AGENTS.md「图生图参考」节）。
 * 老消息没有界标 → ctx 为 null，显示层退回原样渲染（不做格式兼容，只是不炸）。
 */

export const CTX_MARK = "<<<WS-CTX>>>";
export const MANIFEST_MARK = "<<<WS-MANIFEST>>>";

export type AttachmentKind = "image" | "video" | "audio" | "document";

export const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  document: "文档",
};

/** 画布卡类型 → 人话标签（写进给模型的引用行 + chip 标签；漏类型会漏出原始
 *  英文枚举，2026-09-11 一并补全 scene/prop/costume/research 等） */
const NODE_TYPE_LABEL: Record<string, string> = {
  note: "文本",
  script: "剧本",
  character: "角色",
  scene: "场景",
  prop: "道具",
  costume: "服饰",
  image: "图片",
  video: "视频",
  audio: "音频",
  compose: "成片",
  storyboard: "分镜",
  shotlist: "分镜表",
  research: "调研",
  group: "分组",
  compare: "对比",
};

export function nodeTypeLabel(type: string): string {
  return NODE_TYPE_LABEL[type] ?? type;
}

/** 字数说人话（chip 与给模型的元数据同源） */
export function charsLabel(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`;
}

export type ContextAttachment = {
  kind: AttachmentKind;
  name: string;
  /** 上传/提取失败的附件也留 chip（明报，与输入条里的错误态同语义） */
  error?: string;
  /** 媒体附件的同源 URL */
  url?: string;
  /** 文档：画布资料卡节点 id（chip 点击定位到卡） */
  nodeId?: string;
  /** 文档正文字数 */
  chars?: number;
  /** 文档正文。**只进人话段**（模型要读），不进 manifest（界面不需要，重复即浪费） */
  body?: string;
};

export type ContextRef = { id: string; type: string; title: string; snippet?: string };

export type MessageContext = { refs: ContextRef[]; attachments: ContextAttachment[] };

/** 上下文段是否为空（空就不加界标，消息保持纯净文本） */
export function contextIsEmpty(ctx: MessageContext): boolean {
  return ctx.refs.length === 0 && ctx.attachments.length === 0;
}

/** 拼「显示文本 + 上下文段」——用户消息正文的唯一写入口 */
export function buildContextText(display: string, ctx: MessageContext): string {
  if (contextIsEmpty(ctx)) return display;
  const human: string[] = [];
  // 用户只丢附件、一个字没打：得给模型一句人话，否则它看到的是孤立的附件清单
  if (!display.trim()) human.push("（用户未附带文字说明，见下列引用卡片与附件）");
  if (ctx.refs.length > 0)
    human.push(
      [
        "引用的画布卡片（可按 id 用 canvas_ops 操作）：",
        ...ctx.refs.map(
          (r) => `- @${r.id} ${nodeTypeLabel(r.type)}「${r.title}」：${r.snippet ?? ""}`,
        ),
      ].join("\n"),
    );
  if (ctx.attachments.length > 0) {
    const lines = ctx.attachments.map((a) => {
      const label = KIND_LABEL[a.kind];
      if (a.error) return `- ${label}「${a.name}」上传失败，未附带（原因：${a.error}）`;
      if (a.kind === "document") {
        const meta = [
          a.nodeId ? `资料卡 ${a.nodeId}` : "",
          a.chars ? charsLabel(a.chars) : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return `- ${label}「${a.name}」${meta ? `（${meta}）` : ""}内容：\n<<<\n${a.body ?? ""}\n>>>`;
      }
      return `- ${label}「${a.name}」：${a.url}${a.kind === "image" ? "（可作生成参考图）" : ""}`;
    });
    human.push(`附件：\n${lines.join("\n")}`);
  }
  const manifest = JSON.stringify({
    refs: ctx.refs.map((r) => ({ id: r.id, type: r.type, title: r.title })),
    attachments: ctx.attachments.map((a) => ({
      kind: a.kind,
      name: a.name,
      ...(a.error ? { error: a.error } : {}),
      ...(a.url ? { url: a.url } : {}),
      ...(a.nodeId ? { nodeId: a.nodeId } : {}),
      ...(a.chars ? { chars: a.chars } : {}),
    })),
  });
  return [display.trim(), CTX_MARK, human.join("\n\n"), MANIFEST_MARK, manifest]
    .filter((p) => p !== "")
    .join("\n\n");
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const p = b as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") out.push(p.text);
  }
  return out;
}

const KINDS: AttachmentKind[] = ["image", "video", "audio", "document"];

/** manifest → MessageContext。形状不对就当没有（显示层退原样渲染） */
function parseManifest(raw: string): MessageContext | null {
  if (!raw.trim()) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as { refs?: unknown; attachments?: unknown };
  const refs: ContextRef[] = [];
  if (Array.isArray(d.refs))
    for (const r of d.refs) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      if (typeof o.id !== "string" || !o.id) continue;
      refs.push({
        id: o.id,
        type: typeof o.type === "string" ? o.type : "",
        title: typeof o.title === "string" ? o.title : "",
      });
    }
  const attachments: ContextAttachment[] = [];
  if (Array.isArray(d.attachments))
    for (const a of d.attachments) {
      if (!a || typeof a !== "object") continue;
      const o = a as Record<string, unknown>;
      const kind = KINDS.find((k) => k === o.kind);
      if (!kind || typeof o.name !== "string" || !o.name) continue;
      attachments.push({
        kind,
        name: o.name,
        ...(typeof o.error === "string" && o.error ? { error: o.error } : {}),
        ...(typeof o.url === "string" && o.url ? { url: o.url } : {}),
        ...(typeof o.nodeId === "string" && o.nodeId ? { nodeId: o.nodeId } : {}),
        ...(typeof o.chars === "number" && o.chars > 0 ? { chars: o.chars } : {}),
      });
    }
  if (refs.length === 0 && attachments.length === 0) return null;
  return { refs, attachments };
}

/** 拆「显示文本 / 上下文段」——界面侧唯一读入口。老消息无界标时 ctx=null */
export function splitMessageContext(content: unknown): {
  text: string;
  ctx: MessageContext | null;
} {
  const kept: string[] = [];
  let ctx: MessageContext | null = null;
  for (const t of textParts(content)) {
    const i = t.indexOf(CTX_MARK);
    if (i < 0) {
      kept.push(t);
      continue;
    }
    kept.push(t.slice(0, i));
    const rest = t.slice(i + CTX_MARK.length);
    const j = rest.indexOf(MANIFEST_MARK);
    ctx = parseManifest(j >= 0 ? rest.slice(j + MANIFEST_MARK.length) : "");
  }
  return { text: kept.join("\n").trim(), ctx };
}

/** 用户自己说的话（搜索 / 轮次摘要 / 编辑重发回填 / 复制共用口径） */
export function visibleUserText(content: unknown): string {
  return splitMessageContext(content).text;
}

/** 一行式摘要（轮次轨标签兜底 / 复制附注） */
export function contextSummary(ctx: MessageContext | null): string {
  if (!ctx) return "";
  return [
    ...ctx.attachments.map(
      (a) => `${KIND_LABEL[a.kind]}「${a.name}」${a.error ? "（失败）" : ""}`,
    ),
    ...ctx.refs.map((r) => `${nodeTypeLabel(r.type)}「${r.title}」`),
  ].join("、");
}

// ---------- 存量迁移（2026-09-11）----------
//
// 旧格式把附件正文直接拼进消息正文（无界标），已经落库的会话读回来仍是一堵字墙
// （生产 8 条 / 本地 091001 那条 1.2 万字）。按本仓「存量走迁移、不留兼容读取」的
// 惯例（sanitize 的 resizedNotes / researchId 回填同款），在**水合边界**把旧格式
// 一次性改写成新格式：正文一个字不丢（照旧进人话段给模型），界面上就出 chip 了。
// 已知损失：老消息没记资料卡 id → chip 不可点击定位（新消息才有）。
// 幂等：带界标的直接原样返回。

const LEGACY_REF_HEAD = "引用的画布卡片（可按 id 用 canvas_ops 操作）：";
const LEGACY_ATT_HEAD = "附件：";
const LEGACY_PLACEHOLDER = "（见附件与引用的画布卡片）";
const LABEL_KIND: Record<string, AttachmentKind> = {
  文档: "document",
  图片: "image",
  视频: "video",
  音频: "audio",
};

/** 旧格式消息正文 → 新格式（显示文本 + 上下文段）。不是旧格式的原样返回 */
export function migrateLegacyUserContent(content: unknown): unknown {
  if (typeof content !== "string") return content;
  if (content.includes(CTX_MARK)) return content;
  const ri = content.indexOf(LEGACY_REF_HEAD);
  const ai = content.indexOf(LEGACY_ATT_HEAD);
  if (ri < 0 && ai < 0) return content;
  const start = ri >= 0 && (ai < 0 || ri < ai) ? ri : ai;
  const display = content.slice(0, start).trim().replace(LEGACY_PLACEHOLDER, "").trim();
  const tail = content.slice(start).split("\n");

  const refs: ContextRef[] = [];
  const attachments: ContextAttachment[] = [];
  for (let k = 0; k < tail.length; k += 1) {
    const line = tail[k];
    const ref = line.match(/^- @(\S+) (\S+)「(.*?)」：(.*)$/);
    if (ref) {
      refs.push({ id: ref[1], type: ref[2], title: ref[3], snippet: ref[4] });
      continue;
    }
    const att = line.match(/^- (文档|图片|视频|音频)「(.+?)」/);
    if (!att) continue;
    const kind = LABEL_KIND[att[1]];
    const name = att[2];
    const err = line.match(/上传失败，未附带（原因：(.*?)）\s*$/);
    if (err) {
      attachments.push({ kind, name, error: err[1] });
      continue;
    }
    if (kind === "document") {
      // 正文夹在 <<< … >>> 之间（旧格式的围栏）
      const body: string[] = [];
      if (tail[k + 1] === "<<<") {
        for (let j = k + 2; j < tail.length; j += 1) {
          if (tail[j] === ">>>") {
            k = j;
            break;
          }
          body.push(tail[j]);
        }
      }
      const text = body.join("\n");
      attachments.push({ kind, name, chars: text.length, body: text });
      continue;
    }
    // `」：<url>（可作生成参考图）`——后缀是旧格式给图片加的说明，不属于 URL
    const url = line.match(/」：(.*?)(?:（可作生成参考图）)?\s*$/);
    if (url && url[1]) attachments.push({ kind, name, url: url[1] });
  }
  if (refs.length === 0 && attachments.length === 0) return content;
  return buildContextText(display, { refs, attachments });
}
