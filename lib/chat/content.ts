"use client";

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

/** 把消息内容转成 Markdown 可读文本：纯文本原样；多模态 parts 文字拼接 + 媒体列 URL */
export function contentToMarkdown(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  const lines: string[] = [];
  for (const p of content) {
    if (p.type === "text") lines.push(p.text);
    else lines.push(`- ${p.type === "image" ? "图片" : p.type === "video" ? "视频" : "音频"}：${p.source.value}`);
  }
  return lines.join("\n");
}
