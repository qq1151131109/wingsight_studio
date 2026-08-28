"use client";

import { useEffect, useRef } from "react";
import {
  useCoAgent,
  useCopilotAction,
  useCopilotChatHeadless_c,
  useCopilotReadable,
} from "@copilotkit/react-core";
import { CheckCircle2, CircleAlert, Wrench } from "lucide-react";
import { summarizeCanvas, useCanvasStore } from "@/lib/canvas/store";
import { applyOps, type OpResult } from "@/lib/canvas/ops";
import { RETRY_GENERATION_EVENT } from "@/components/canvas/nodes";
import { FOCUS_NODES_EVENT } from "@/lib/canvas/events";

/** 与 agent 侧 AgentState 对齐的共享状态（读通道 ground truth） */
interface WingsightAgentState {
  canvasSummary: string;
}

const EMPTY: WingsightAgentState = { canvasSummary: "（画布为空）" };

const NODE_TYPE_LABEL: Record<string, string> = {
  note: "便签",
  script: "剧本",
  character: "角色",
  image: "图片",
  storyboard: "分镜",
  group: "分组",
};

/**
 * 画布 ↔ Agent 桥：
 *   读通道：画布摘要写入共享状态（useCoAgent state）+ 上下文（useCopilotReadable）
 *   写通道：canvas_ops 前端工具（available:"remote"），agent 调用 → 浏览器执行 applyOps
 */
export default function CanvasAgentBridge() {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);

  const { setState } = useCoAgent<WingsightAgentState>({
    name: "default",
    initialState: EMPTY,
  });

  const summary = summarizeCanvas(
    nodes,
    edges,
    nodes.filter((n) => n.selected).map((n) => n.id),
  );

  // 画布变化 → 更新共享状态与上下文（agent 下轮读取 ground truth）。
  // 用 ref 记录上次同步值：setState 引用可能每轮渲染都变，不做值比较会死循环卡死页面。
  const lastSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    if (summary === lastSyncedRef.current) return;
    lastSyncedRef.current = summary;
    setState((prev) => ({
      ...(prev ?? EMPTY),
      canvasSummary: summary,
    }));
  }, [summary, setState]);

  useCopilotReadable({
    description: "当前画布内容（节点 / 连线 / 选中项）",
    value: summary,
  });

  // 读节点全文：摘要只有 40 字截断，agent 需要时（如回剧本找漏掉的角色）按需读
  useCopilotAction({
    name: "read_node",
    description: "读取一张画布卡片的完整内容（标题与正文全文）。摘要被截断时用它。",
    available: "remote",
    parameters: [
      { name: "id", type: "string", required: true, description: "节点 id" },
    ],
    handler: ({ id }: { id: string }) => {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
      if (!node) return `节点 ${id} 不存在`;
      const d = node.data;
      const body = (d.body ?? "").slice(0, 6000);
      return `【${NODE_TYPE_LABEL[d.nodeType] ?? d.nodeType}】${d.title ?? ""}\n\n${body}${
        (d.body ?? "").length > 6000 ? "\n…（已截断）" : ""
      }`;
    },
  });

  // image 卡"点击重试" → 转成聊天指令让 agent 重新生成该资产
  const { sendMessage } = useCopilotChatHeadless_c();
  useEffect(() => {
    const onRetry = (e: Event) => {
      const nodeId = (e as CustomEvent<{ nodeId: string }>).detail?.nodeId;
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      if (!node) return;
      useCanvasStore.getState().updateNodeData(nodeId, {
        status: "loading",
        errorMessage: undefined,
      });
      void sendMessage(
        {
          id: `retry_${nodeId}_${Date.now()}`,
          role: "user",
          content: `重新生成「${node.data.title}」的设定图`,
        },
        { followUp: true },
      );
    };
    window.addEventListener(RETRY_GENERATION_EVENT, onRetry);
    return () => window.removeEventListener(RETRY_GENERATION_EVENT, onRetry);
  }, [sendMessage]);

  useCopilotAction({
    name: "canvas_ops",
    description:
      "操作无限画布。ops 是操作数组，每个元素形如 " +
      '{op:"add_node",nodeType:"note|script|character|image|storyboard",title,body,position:{x,y}}（分镜卡可带 shotNumber/cameraMove/shotSize/duration/dialogue）/ ' +
      '{op:"update_node",id,title,body} / {op:"delete_nodes",ids:[...]} / ' +
      '{op:"connect_nodes",fromId,toId} / {op:"group_nodes",ids:[...],title}（把多张卡收进分组框）/ ' +
      '{op:"set_viewport",x,y,zoom}。' +
      "可以在一批里执行多个操作。",
    available: "remote",
    parameters: [
      {
        name: "ops",
        type: "object[]",
        required: true,
        description: "画布操作数组",
      },
    ],
    handler: ({ ops }: { ops?: unknown }) => {
      // 容错：部分模型会把数组序列化成字符串
      const raw =
        typeof ops === "string"
          ? safeParse(ops)
          : Array.isArray(ops)
            ? ops
            : ops && typeof ops === "object"
              ? ops
              : [];
      const result = applyOps(raw);
      // 可见性：新建的节点自动选中 + 高亮闪烁；agent 没显式 set_viewport 时镜头跟过去
      if (result.createdIds.length > 0) {
        const store = useCanvasStore.getState();
        store.selectNodes(result.createdIds);
        store.flashNodes(result.createdIds);
        if (!hasViewportOp(raw)) {
          window.dispatchEvent(
            new CustomEvent(FOCUS_NODES_EVENT, {
              detail: { ids: result.createdIds },
            }),
          );
        }
      }
      return result as unknown as string;
    },
    render: ({ status, result }) => {
      if (status !== "complete" || !result) {
        return (
          <div className="flex items-center gap-1.5 py-1 text-xs text-text-3">
            <Wrench className="h-3.5 w-3.5" /> 正在操作画布…
          </div>
        );
      }
      const r = result as unknown as OpResult;
      const ok = r.errors.length === 0;
      return (
        <div className="my-1 rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-xs">
          <div
            className={`flex items-center gap-1.5 font-medium ${
              ok ? "text-good" : "text-warn"
            }`}
          >
            {ok ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <CircleAlert className="h-3.5 w-3.5" />
            )}
            画布操作：执行 {r.applied} 项
            {r.createdIds.length > 0
              ? `，新建 ${r.createdIds.length} 个节点`
              : ""}
          </div>
          {r.errors.length > 0 ? (
            <ul className="mt-1 list-inside list-disc text-text-3">
              {r.errors.slice(0, 5).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    },
  });

  return null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

/** agent 是否在本批里显式运过镜（显式 set_viewport 时不自动聚焦，尊重 agent 的镜头） */
function hasViewportOp(raw: unknown): boolean {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { ops?: unknown[] }).ops)
      ? (raw as { ops: unknown[] }).ops
      : [];
  return list.some((o) => (o as { op?: string } | null)?.op === "set_viewport");
}
