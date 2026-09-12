"use client";

/**
 * 快照稳定中间件（2026-09-12「对话区反复刷新 / 输出突然没了」根治）。
 *
 * 根因：AG-UI 协议里每个 run 结束（前端工具调用边界、轮内状态推进）都会发
 * MESSAGES_SNAPSHOT，@ag-ui/client 对它是**整表替换**；而流式消息 id
 * （langchain_core 按 run 铸造 `lc_run--*`）与快照消息 id（graph state 落库
 * 后的 id）天然不同源——同一条消息换 id = React 换 key = 气泡卸载重建。
 * 一轮对话 10+ 个 run（每个前端工具调用一个边界），用户看到的就是「对话区
 * 一直在刷新」；本地-only 的瞬时消息（reasoning 思考行、progress_* 播报）
 * 不在快照里，整表替换时被删——「输出完突然没了」。
 *
 * 修法（全在客户端中间件，事件进 apply（写 agent.messages）之前）：
 *  1. id 对齐：快照消息与本地消息按「角色+正文+工具调用签名」匹配，命中则
 *     沿用本地 id——React 不换 key，气泡原地更新。对齐命中同时记
 *     localId→serverId 映射，**出站还原**：run input 发出去前把 id 翻译回
 *     服务端 id（ag_ui_langgraph 按 id 与 checkpoint 合并历史，收到它不认识
 *     的本地 id 会当新消息重复插入——DeepSeek 思考模式随即 400「reasoning_
 *     content must be passed back」，2026-09-12 实测）。
 *  2. 瞬时回插：本地 reasoning / progress_* 不在快照里时，按它后面首条正式
 *     消息的位置插回（尾部无锚点则追加到末尾）——思考行与播报跨 run 存活，
 *     刷新页面仍按既有设计消失（ChatPersistence 不落库）。reasoning 消息
 *     **必须**随 input 回传：服务端靠它重建 AIMessage.reasoning_content
 *     （DeepSeek 思考模式硬要求），过滤掉就是上面那个 400。
 *
 * 守卫：本地与快照的首条 user 消息内容一致才做稳定化——线程切换的 connect、
 * 跨会话场景原样放行，不把上一个会话的思考行泄漏进新会话。
 *
 * 回归：pnpm dlx tsx scripts/snapshot-stability-test.mjs（13 项纯函数）。
 */

import { map } from "rxjs";
import type { AbstractAgent, MiddlewareFunction } from "@ag-ui/client";

/**
 * 消息的宽松面：库的 Message 类型 role 是封闭枚举（无 "reasoning"——那是
 * @ag-ui/client 从 REASONING_MESSAGE_* 事件落的本地角色），对齐/回插在
 * 宽松面上做，边界处一次性收窄。
 */
interface MsgLike {
  id?: string;
  role?: string;
  content?: unknown;
  toolCalls?: { id?: string; function?: { name?: string } }[];
  toolCallId?: string;
}

/** 消息身份签名：流式与快照两份「同一条消息」靠它对上（id 本身对不上） */
function keyOf(m: MsgLike): string {
  const content =
    typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
  const calls = (m.toolCalls ?? [])
    .map((t) => `${t.id ?? ""}:${t.function?.name ?? ""}`)
    .join(",");
  return `${m.role ?? ""}:${content}:${calls}:${m.toolCallId ?? ""}`;
}

/** 本地-only 瞬时消息：快照永远不含（服务端没有它们），整表替换时会被删 */
function isTransient(m: MsgLike): boolean {
  return (
    m.role === "reasoning" ||
    (typeof m.id === "string" && m.id.startsWith("progress_"))
  );
}

/** 同对话判定：首条 user 消息内容一致（线程切换/跨会话时为否） */
function sameConversation(local: MsgLike[], snap: MsgLike[]): boolean {
  const a = local.find((m) => m.role === "user");
  const b = snap.find((m) => m.role === "user");
  return Boolean(a && b && keyOf(a) === keyOf(b));
}

/**
 * 纯函数：给定本地消息与快照消息，产出稳定化后的快照列表。
 * `idMap`（可选，就地更新）：对齐命中的 localId→serverId，供出站还原。
 * 导出供单测（scripts/snapshot-stability-test.mjs）。
 */
export function stabilizeSnapshotMessages(
  local: MsgLike[],
  snap: MsgLike[],
  idMap?: Map<string, string>,
): MsgLike[] {
  if (local.length === 0 || !sameConversation(local, snap)) return snap;

  // 1) id 对齐：同签名消息沿用本地 id（从近到远找，每条本地消息最多认领一次）
  const used = new Set<string>();
  const pool = [...local].reverse();
  const aligned = snap.map((m) => {
    const hit = pool.find(
      (x) => x.id != null && !used.has(x.id) && keyOf(x) === keyOf(m),
    );
    if (!hit || hit.id == null || m.id == null || hit.id === m.id) return m;
    used.add(hit.id);
    idMap?.set(hit.id, m.id);
    return { ...m, id: hit.id };
  });

  // 2) 瞬时回插：不在快照里的本地瞬时消息按锚点位置放回
  const out = [...aligned];
  for (let i = 0; i < local.length; i++) {
    const m = local[i];
    if (!isTransient(m) || m.id == null) continue;
    if (out.some((x) => x.id === m.id)) continue; // 快照已含（服务端补进的 reasoning）
    const anchor = local.slice(i + 1).find((x) => !isTransient(x));
    const at = anchor ? out.findIndex((x) => keyOf(x) === keyOf(anchor)) : -1;
    if (at >= 0) out.splice(at, 0, m);
    else out.push(m); // 尾部瞬时（本轮流式中）追加到末尾，不丢
  }
  return out;
}

/** 纯函数：run 出站消息——localId 还原成服务端 id（命中的才翻）；
 *  progress_* 播报不回传（UI 提示非对话内容，DeepSeek 思考模式对无
 *  reasoning 的 assistant 历史 400——E6/E7 留档问题的稳定复现源） */
export function restoreServerMessageIds(
  messages: MsgLike[],
  idMap: Map<string, string>,
): MsgLike[] {
  return messages
    .filter(
      (m) => !(typeof m.id === "string" && m.id.startsWith("progress_")),
    )
    .map((m) => {
      const serverId = m.id != null ? idMap.get(m.id) : undefined;
      return serverId && serverId !== m.id ? { ...m, id: serverId } : m;
    });
}

/** 给 HttpAgent 挂快照稳定中间件（use 收 MiddlewareFunction，事件在 apply 前过 map） */
export function attachSnapshotStability(agent: AbstractAgent): void {
  // localId → serverId（对齐时累积；跨线程 stale 条目无害——消息 id 全局唯一不重号）
  const idMap = new Map<string, string>();
  const middleware: MiddlewareFunction = (input, next) =>
    next
      .run({
        ...input,
        messages: restoreServerMessageIds(
          input.messages as unknown as MsgLike[],
          idMap,
        ) as unknown as typeof input.messages,
      })
      .pipe(
        map((event) => {
          if (event.type !== "MESSAGES_SNAPSHOT") return event;
          const stabilized = stabilizeSnapshotMessages(
            agent.messages as unknown as MsgLike[],
            event.messages as unknown as MsgLike[],
            idMap,
          );
          return {
            ...event,
            messages: stabilized,
          } as typeof event;
        }),
      );
  agent.use(middleware);
}
