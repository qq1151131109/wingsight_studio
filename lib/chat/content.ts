"use client";

import { contextSummary, KIND_LABEL, splitMessageContext } from "./messageContext";

/**
 * 聊天消息 content 的落库编解码（ChatPersistence 存取 / ThreadsBar 导出共用）：
 * 数组 content（AG-UI 多模态 parts）序列化为 `WS_PARTS::<json>` envelope 字符串，
 * 读回/导出时还原为 parts 数组。
 */

export const PARTS_PREFIX = "WS_PARTS::";

export function encodeContent(content: unknown): string | null {
  if (typeof content === "string") {
    const t = content.trim();
    return t ? content : null;
  }
  if (Array.isArray(content)) {
    const json = JSON.stringify(content);
    return json && json !== "[]" ? PARTS_PREFIX + json : null;
  }
  return null;
}

/** 还原为 string | parts 数组；损坏的 envelope 当纯文本 */
export function decodeContent(raw: string): string | ContentPart[] {
  if (raw.startsWith(PARTS_PREFIX)) {
    try {
      const parts = JSON.parse(raw.slice(PARTS_PREFIX.length));
      if (Array.isArray(parts)) return parts as ContentPart[];
    } catch {
      /* 损坏的 envelope 当纯文本 */
    }
  }
  return raw;
}

/** AG-UI 多模态 content part（@ag-ui/core UserMessage） */
export type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "image" | "video" | "audio";
      source: { type: "url"; value: string; mimeType?: string };
    };

/** 把消息内容转成 Markdown 可读文本：只导出**用户可见的部分**（用户自己那句话 +
 *  附件与引用清单 + 媒体 URL）。附件正文不复制进导出——它是画布资料卡的内容，
 *  导出对话不该再抄一份（2026-09-11 与气泡显示同口径） */
export function contentToMarkdown(content: string | ContentPart[]): string {
  const { text, ctx } = splitMessageContext(content);
  const lines: string[] = [];
  if (text) lines.push(text);
  if (ctx) {
    const summary = contextSummary(ctx);
    if (summary) lines.push(`[附件与引用] ${summary}`);
    for (const a of ctx.attachments)
      if (a.url && a.kind !== "document") lines.push(`- ${KIND_LABEL[a.kind]}：${a.url}`);
  } else if (Array.isArray(content)) {
    // 无上下文段的老消息：媒体 part 的 URL 照旧列出
    for (const p of content)
      if (p.type !== "text") lines.push(`- ${KIND_LABEL[p.type]}：${p.source.value}`);
  }
  return lines.join("\n");
}
