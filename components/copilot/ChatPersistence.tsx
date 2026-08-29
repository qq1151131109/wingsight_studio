"use client";

/**
 * 聊天持久化桥（多会话版，对标"服务端为唯一事实源"）：
 *  - 进项目：拉会话列表 → 选中最新会话 → 回填消息（空项目清空）
 *  - 切会话 / 新建会话（threadId=null）：回填对应消息（新建即清空）
 *  - 消息变化：debounce 1.2s → PUT 整表覆盖到当前会话；
 *    threadId=null 且有内容时先建会话（跳过随之而来的回填，防清屏竞态）
 *  - 只存 user/assistant 文本；多模态 parts 用 WS_PARTS:: envelope 序列化
 *  - 读取失败（服务离线）本轮不保存，避免用内存空历史覆盖服务端
 */

import { useEffect, useRef } from "react";
import { useCopilotChatHeadless_c } from "@copilotkit/react-core";
import { useCanvasStore } from "@/lib/canvas/store";
import { useChatSession } from "@/lib/chat/session";
import {
  createChatThread,
  loadChatMessages,
  listChatThreads,
  saveChatMessages,
  type ChatMessageRecord,
} from "@/lib/projects";

const SAVE_DEBOUNCE_MS = 1200;

/** 水合键：undefined=未选择 / null=新会话 / tid */
const keyOf = (pid: string, tid: string | null | undefined) =>
  `${pid}:${tid ?? (tid === null ? "new" : "unselected")}`;

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
  const threadId = useChatSession((s) => s.threadId);
  const setThreadId = useChatSession((s) => s.setThreadId);
  const { messages, setMessages } = useCopilotChatHeadless_c();
  // 已成功水合的 项目:会话 才允许保存（防离线/竞态覆盖）
  const hydratedKeyRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>("");
  const dirtyRef = useRef<{
    pid: string;
    tid: string | null;
    records: ChatMessageRecord[];
  } | null>(null);
  // 水合返回时读"此刻"的消息（effect 闭包里的 messages 是旧值）
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // ensure thread 后跳过一次回填（新建会触发 threadId 变化，回填会把空历史盖到界面上）
  const skipHydrateKeyRef = useRef<string | null>(null);

  // ---------- 水合：进项目 / 切会话 / 新建会话 ----------
  useEffect(() => {
    if (!projectId) return;
    const key = keyOf(projectId, threadId);
    if (hydratedKeyRef.current === key) return;
    let cancelled = false;

    // 新建会话（null）：直接清空界面，等首条消息保存时落库
    if (threadId === null) {
      hydratedKeyRef.current = key;
      lastSavedRef.current = "";
      setMessages([] as never);
      return;
    }

    // 发请求时消息快照：进项目的初始水合若被并发输入抢先，放弃覆盖（防丢新消息）
    const before = JSON.stringify(messagesRef.current);
    void (async () => {
      try {
        if (threadId === undefined) {
          // 进项目：选最新会话（listChatThreads 按 updated_at DESC）
          const threads = await listChatThreads(projectId);
          if (cancelled || useCanvasStore.getState().projectId !== projectId)
            return;
          if (JSON.stringify(messagesRef.current) !== before) return; // 用户已先开口
          const latest = threads[0]?.id ?? null;
          hydratedKeyRef.current = keyOf(projectId, latest);
          lastSavedRef.current = "";
          setThreadId(latest);
          if (latest === null) setMessages([] as never);
          return;
        }
        const history = await loadChatMessages(projectId, threadId);
        if (cancelled || useCanvasStore.getState().projectId !== projectId)
          return;
        if (skipHydrateKeyRef.current === key) {
          // ensure 刚建出的会话：只标记水合，不覆盖界面
          skipHydrateKeyRef.current = null;
          hydratedKeyRef.current = key;
          return;
        }
        if (JSON.stringify(messagesRef.current) !== before) return;
        setMessages(
          history.map((h) => ({
            id: h.id,
            role: h.role,
            content: decodeContent(h.content),
          })) as never,
        );
        hydratedKeyRef.current = key;
        lastSavedRef.current = JSON.stringify(history);
      } catch {
        // 服务不可达：保留现状、本轮不保存
        hydratedKeyRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, threadId, setMessages, setThreadId]);

  // ---------- 保存：消息变化 debounce 落盘 ----------
  useEffect(() => {
    if (!projectId || !hydratedKeyRef.current) return;
    if (hydratedKeyRef.current !== keyOf(projectId, threadId)) return;
    const records = toRecords(messages as ChatMsg[]);
    const snapshot = JSON.stringify(records);
    if (snapshot === lastSavedRef.current) return;
    dirtyRef.current = { pid: projectId, tid: threadId ?? null, records };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const dirty = dirtyRef.current;
      if (!dirty) return;
      dirtyRef.current = null;
      lastSavedRef.current = JSON.stringify(dirty.records);
      void (async () => {
        try {
          let tid = dirty.tid;
          if (!tid) {
            // 新会话首存：落库建会话，并跳过 setThreadId 触发的回填
            const t = await createChatThread(dirty.pid);
            tid = t.id;
            skipHydrateKeyRef.current = keyOf(dirty.pid, tid);
            setThreadId(tid);
          }
          await saveChatMessages(dirty.pid, tid, dirty.records);
        } catch {
          /* 静默：下一轮消息变化会重试 */
        }
      })();
    }, SAVE_DEBOUNCE_MS);
  }, [projectId, threadId, messages, setThreadId]);

  // ---------- 离开工作台 / 切项目 / 切会话：冲刷未落盘的修改 ----------
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const dirty = dirtyRef.current;
      if (dirty) {
        dirtyRef.current = null;
        void (async () => {
          try {
            let tid = dirty.tid;
            if (!tid) {
              const t = await createChatThread(dirty.pid);
              tid = t.id;
            }
            await saveChatMessages(dirty.pid, tid, dirty.records);
          } catch {
            /* unmount 阶段尽力而为 */
          }
        })();
      }
    };
  }, [projectId, threadId, setThreadId]);

  return null;
}
