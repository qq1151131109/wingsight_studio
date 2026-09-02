"use client";

/**
 * 聊天持久化桥（多会话版，对标"服务端为唯一事实源"）：
 *  - 进项目：拉会话列表 → 选中最新会话 → 回填消息（空项目清空）
 *  - 切项目：重置会话选择（残留 tid 在新项目下不存在，必 404 且聊天串台）
 *  - 切会话 / 新建会话（threadId=null）：回填对应消息（新建即清空）
 *  - 选中的会话在服务端消失（404）：自愈回"选最新"，不打错误风暴
 *  - 消息变化：debounce 1.2s → PUT 整表覆盖到当前会话；
 *    threadId=null 且有内容时先建会话（跳过随之而来的回填，防清屏竞态）
 *  - 只存 user/assistant 文本；多模态 parts 用 WS_PARTS:: envelope 序列化
 *  - 读取失败（服务离线）本轮不保存，避免用内存空历史覆盖服务端
 */

import { useEffect, useRef } from "react";
import { useCopilotChatHeadless_c } from "@copilotkit/react-core";
import { useCanvasStore } from "@/lib/canvas/store";
import { pendingAgentThreadId, useChatSession } from "@/lib/chat/session";
import { decodeContent, encodeContent } from "@/lib/chat/content";
import {
  cancelChatRun,
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

function toRecords(messages: ChatMsg[]): ChatMessageRecord[] {
  const out: ChatMessageRecord[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    // 瞬时进度消息（agent 工具执行中推送的 progress_*）不落库：
    // 它是状态提示不是对话内容，回看历史时应消失
    if (typeof m.id === "string" && m.id.startsWith("progress_")) continue;
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
  // threadId 所属项目：全局会话 store 不随项目切换清空，跨项目残留的 tid
  // 拿到新项目下查询必 404（还会把旧项目聊天串到新项目界面）
  const threadProjectRef = useRef<string | null>(null);
  // ensure thread 后跳过一次回填（新建会触发 threadId 变化，回填会把空历史盖到界面上）
  const skipHydrateKeyRef = useRef<string | null>(null);

  // ---------- 水合：进项目 / 切会话 / 新建会话 ----------
  useEffect(() => {
    if (!projectId) return;
    // 切项目：上一项目的会话选择不作数，重置为未选择走下方"进项目选最新会话"；
    // 若上一会话有任务在途，透传后端取消（切走即无人看管，不再烧钱）
    const switchedProject =
      threadProjectRef.current !== null && threadProjectRef.current !== projectId;
    threadProjectRef.current = projectId;
    if (switchedProject && threadId !== undefined) {
      hydratedKeyRef.current = null;
      void cancelChatRun(threadId);
      setThreadId(undefined);
      return;
    }
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
        if (history === null) {
          // 会话在服务端不存在（其他端删除/残留选择）：重新选本项目最新会话。
          // undefined 分支选完落为有效 tid 或 null，一轮收敛，不会循环打 404
          hydratedKeyRef.current = null;
          setThreadId(undefined);
          return;
        }
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
            // 新会话首存：用 agent 正在用的 thread id 建服务端会话（两边同源，
            // 模型记忆与 UI 会话对齐），并跳过 setThreadId 触发的回填
            const t = await createChatThread(dirty.pid, "", pendingAgentThreadId());
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
              const t = await createChatThread(dirty.pid, "", pendingAgentThreadId());
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
