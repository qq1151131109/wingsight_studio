"use client";

/**
 * 聊天历史持久化桥（对标"服务端为唯一事实源"）：
 *  - 进项目/切项目：GET 历史回填 agent.messages（空项目清空）
 *  - 消息变化：debounce 1.2s → PUT 整表覆盖（只存 user/assistant 文本，
 *    工具消息不落库——重放时没有配对的工具调用会破坏模型交替）
 *  - 读取失败（服务离线）时本轮不保存，避免用内存里的空历史覆盖服务端
 */

import { useEffect, useRef } from "react";
import { useCopilotChatHeadless_c } from "@copilotkit/react-core";
import { useCanvasStore } from "@/lib/canvas/store";
import {
  loadChatHistory,
  saveChatHistory,
  type ChatMessageRecord,
} from "@/lib/projects";

const SAVE_DEBOUNCE_MS = 1200;

/** AG-UI 消息的最小结构（headless hook 返回的 Message 太宽，这里只取要存的字段） */
type ChatMsg = { id?: string; role?: string; content?: unknown };

/** 数组 content（多模态 parts）的落库编解码：标记前缀 + JSON，读回时还原 */
const PARTS_PREFIX = "WS_PARTS::";

function encodeContent(content: unknown): string | null {
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

function decodeContent(raw: string): string | unknown[] {
  if (raw.startsWith(PARTS_PREFIX)) {
    try {
      const parts = JSON.parse(raw.slice(PARTS_PREFIX.length));
      if (Array.isArray(parts)) return parts;
    } catch {
      /* 损坏的 envelope 当纯文本存 */
    }
  }
  return raw;
}

function toRecords(messages: ChatMsg[]): ChatMessageRecord[] {
  const out: ChatMessageRecord[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const encoded = encodeContent(m.content);
    if (!encoded) continue;
    out.push({
      id: m.id ?? `${Date.now().toString(36)}_${out.length}`,
      role: m.role,
      content: encoded.slice(0, 20000),
    });
  }
  return out;
}

export default function ChatPersistence() {
  const projectId = useCanvasStore((s) => s.projectId);
  const { messages, setMessages } = useCopilotChatHeadless_c();

  // 已成功水合的项目才允许保存（防离线/竞态覆盖）
  const hydratedForRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>("");
  const dirtyRef = useRef<{ pid: string; records: ChatMessageRecord[] } | null>(
    null,
  );
  // 水合返回时读"此刻"的消息（effect 闭包里的 messages 是旧值）
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // ---------- 水合：进项目 / 切项目 ----------
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    // 发请求时消息的快照：返回时若用户已发过消息（快照变了），不用旧历史覆盖新对话
    const before = JSON.stringify(messagesRef.current);
    void (async () => {
      try {
        const history = await loadChatHistory(projectId);
        if (cancelled || useCanvasStore.getState().projectId !== projectId)
          return;
        if (JSON.stringify(messagesRef.current) !== before) return;
        setMessages(
          history.map((h) => ({
            id: h.id,
            role: h.role,
            content: decodeContent(h.content),
          })) as never,
        );
        hydratedForRef.current = projectId;
        lastSavedRef.current = JSON.stringify(history);
      } catch {
        // 服务不可达：保留现状、本轮不保存
        hydratedForRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, setMessages]);

  // ---------- 保存：消息变化 debounce 落盘 ----------
  useEffect(() => {
    if (!projectId || hydratedForRef.current !== projectId) return;
    const records = toRecords(messages as ChatMsg[]);
    const snapshot = JSON.stringify(records);
    if (snapshot === lastSavedRef.current) return;
    dirtyRef.current = { pid: projectId, records };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const dirty = dirtyRef.current;
      if (!dirty) return;
      dirtyRef.current = null;
      lastSavedRef.current = JSON.stringify(dirty.records);
      void saveChatHistory(dirty.pid, dirty.records).catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
  }, [projectId, messages]);

  // ---------- 离开工作台 / 切项目：冲刷未落盘的修改 ----------
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const dirty = dirtyRef.current;
      if (dirty) {
        dirtyRef.current = null;
        void saveChatHistory(dirty.pid, dirty.records).catch(() => undefined);
      }
    };
  }, []);

  return null;
}
