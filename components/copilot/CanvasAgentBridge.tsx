"use client";

import { useEffect, useRef, useState } from "react";
import {
  useCoAgent,
  useCopilotAction,
  useCopilotChat,
  useCopilotChatHeadless_c,
  useCopilotReadable,
} from "@copilotkit/react-core";
import { Role, TextMessage } from "@copilotkit/runtime-client-gql";
import { CheckCircle2, CircleAlert, Wrench } from "lucide-react";
import { summarizeCanvas, useCanvasStore } from "@/lib/canvas/store";
import {
  applyOps,
  normalizeOps,
  type CanvasOp,
  type OpResult,
} from "@/lib/canvas/ops";
import ConfirmDialog from "@/components/shell/ConfirmDialog";
import { assetThumbUrl } from "@/lib/asset-thumb";
import {
  CANCEL_GENERATION_EVENT,
  RETRY_GENERATION_EVENT,
  SUPPLEMENT_CANDIDATES_EVENT,
} from "@/components/canvas/nodes";
import { GENERATE_EVENT, type GenerateDetail } from "@/components/canvas/PromptBar";
import {
  FOCUS_EDIT_EVENT,
  FOCUS_NODES_EVENT,
  FRAME_ANALYSIS_EVENT,
  MASK_REDRAW_EVENT,
  OPEN_STYLE_EVENT,
  ROW_GENERATE_EVENT,
  type FrameAnalysisDetail,
  type MaskRedrawDetail,
  type RowGenerateDetail,
} from "@/lib/canvas/events";
import {
  cancelShotImageJob,
  pollShotImageJob,
  startShotImageJob,
} from "@/lib/shotlist";
import { findModelOption, loadImageModels, saneGen } from "@/lib/imagegen";

/** 面板出图直连管线：跳过聊天 LLM，直连 imagegen flow（与拆解出图链/
 *  分镜批量出图同一条）。确定性任务不走 agent，快、省 token、不刷聊天屏。
 *  prompt 空=按卡上标题与正文；参考图取 @引用+上游连线卡的设定图；
 *  上游有角色卡时按角色四格契约出图（Look 卡重生成保持版式） */
async function directImagegen(
  nodeId: string,
  opts: { prompt: string; refIds: string[]; count?: number },
) {
  const st = useCanvasStore.getState();
  const node = st.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const projectStyle = st.projectStyle.trim();
  if (!projectStyle) {
    st.updateNodeData(nodeId, {
      status: "error",
      errorMessage: "未选画风：请在弹出的「项目画风」里设定，再出图",
    });
    window.dispatchEvent(new CustomEvent(OPEN_STYLE_EVENT));
    return;
  }
  // 参考 = 正文 @ 引用（编号序，排最前）+ 本卡已有图（未 @ 时作图生图锚点）
  // + 上游连线卡，带图才收。refIds 先过一遍存在性：已删卡的残留引用不再
  // 参与/不再持久化。模型收到的正文含「图N」指代，数组头部顺序与之一一对应，
  // 头部再注入编号契约（图N=《卡名》），指代不再靠模型猜
  const validRefIds = opts.refIds.filter((rid) => st.nodes.some((n) => n.id === rid));
  const mentionedNodes = validRefIds
    .map((rid) => st.nodes.find((n) => n.id === rid))
    .filter((n): n is NonNullable<typeof n> => Boolean(n));
  const mentionedImgs = mentionedNodes.filter((n) => n.data.imageUrl);
  // 参考图上限按所选模型（agent/models.py 的 max_references：seedream-5-pro
  // 融合通道实测 10 张，其余 edits 通道保守 4）。超限明报不静默截断——截断
  // 会让正文里的「图N」凭空消失
  const cardGen = saneGen(node.data.gen);
  const effectiveModel = cardGen?.model ?? st.imagegen.model;
  const maxRefs =
    findModelOption(effectiveModel, await loadImageModels())?.max_references ?? 4;
  if (mentionedImgs.length > maxRefs) {
    st.updateNodeData(nodeId, {
      status: "error",
      errorMessage: `当前模型参考图上限 ${maxRefs} 张（已选 ${mentionedImgs.length} 张）：请减少 @ 引用，或换用支持 10 张参考图融合的 Seedream 5.0 Pro`,
    });
    return;
  }
  const connectedNodes = st.edges
    .filter((e) => e.target === nodeId && !validRefIds.includes(e.source))
    .map((e) => st.nodes.find((n) => n.id === e.source))
    .filter((n): n is NonNullable<typeof n> => Boolean(n))
    .filter((n) => n.data.imageUrl);
  const selfImageUrl = node.data.imageUrl as string | undefined;
  const selfMentioned = validRefIds.includes(nodeId);
  const seenUrl = new Set<string>();
  const referenceImages = [
    ...mentionedImgs.map((n) => n.data.imageUrl as string),
    // 本卡原图自动并入（图生图锚点，孝庄太后项目踩坑）；正文里已 @ 自己
    // 则尊重显式编号位次，不重复收
    ...(!selfMentioned && selfImageUrl ? [selfImageUrl] : []),
    ...connectedNodes.map((n) => n.data.imageUrl as string),
  ].filter((u) => (seenUrl.has(u) ? false : (seenUrl.add(u), true)));
  // 明式引用（@ 或连线）却一张可用图都没收到 = 曾经「静默降级文生图」的
  // 根源，明报拦下让用户决策；空卡无引用的直接文生图不受影响
  const expectsRefs =
    validRefIds.length > 0 || st.edges.some((e) => e.target === nodeId);
  if (expectsRefs && referenceImages.length === 0) {
    st.updateNodeData(nodeId, {
      status: "error",
      errorMessage:
        "未找到可用参考图：@ 引用/连线的卡上都没有图片。请引用带图的卡，或移除引用后直接文生图",
    });
    return;
  }
  // 编号契约（novanova buildImageReferencePromptText 范式）：把「图N」和
  // 卡名/数组位次钉死，指代有事实源
  const numberingNote = mentionedImgs.length
    ? `参考图编号：${mentionedImgs
        .map((n, i) => `图${i + 1}=《${n.data.title || "无题"}》`)
        .join("、")}（图N 即第 N 张参考图）。`
    : "";
  const visualNotes = [
    ...mentionedNodes.map((n) => {
      const body = ((n.data.body as string) ?? "").slice(0, 150);
      const idx = mentionedImgs.indexOf(n);
      return idx >= 0
        ? `图${idx + 1}=《${n.data.title || "无题"}》${body ? `：${body}` : ""}`
        : `${n.data.title}：${body}`;
    }),
    ...connectedNodes.map(
      (n) => `${n.data.title}：${((n.data.body as string) ?? "").slice(0, 150)}`,
    ),
    `全局视觉风格：${projectStyle}`,
  ].join("；");
  const isCharacterLook =
    mentionedNodes.some((n) => n.data.nodeType === "character") ||
    connectedNodes.some((n) => n.data.nodeType === "character");
  // 资产卡按自身类型出设定图（角色=四格定妆契约、服饰按道具契约、场景/道具
  // 同名）——此前只看引用卡里有没有角色卡，角色资产卡不带角色引用时被误标
  // 成 scene，提示词渲染成「无人空镜」出空场景
  const targetType = String(node.data.nodeType);
  const targetAssetType =
    targetType === "character"
      ? "character"
      : targetType === "costume"
        ? "prop"
        : targetType === "scene" || targetType === "prop"
          ? targetType
          : undefined;
  // 分镜表派生的镜头图卡走 shot 剧照契约——否则带角色引用被误标成
  // character（出成四格定妆）、无引用落 scene（无人空镜禁人物）
  const fromShotlist = st.edges.some(
    (e) =>
      e.target === nodeId &&
      st.nodes.find((m) => m.id === e.source)?.data.nodeType === "shotlist",
  );
  const assetType =
    targetAssetType ??
    (fromShotlist ? "shot" : isCharacterLook ? "character" : "scene");
  // 逐张参考图职责标签（与 referenceImages 一一对应）：flow 渲染
  // 「参考图N（名）：只锁定什么/不继承什么」——juben build_reference_usage 范式
  const refLabelOf = (n: (typeof mentionedImgs)[number]) => ({
    type: String(n.data.nodeType),
    name: String(n.data.title || "无题"),
  });
  const referenceLabels = [
    ...mentionedImgs.map(refLabelOf),
    ...(!selfMentioned && selfImageUrl
      ? [{ type: "image", name: "本卡原图" }]
      : []),
    ...connectedNodes.map(refLabelOf),
  ];
  // 手动 @ 引用落成连线（viedeo-workflow「mention=边」范式）：生成后面板
  // chips 持续可见，不随本会话的输入框状态消失（已删卡的引用不落边）
  for (const rid of new Set(validRefIds)) {
    if (rid === nodeId || st.edges.some((e) => e.target === nodeId && e.source === rid))
      continue;
    st.connect({ source: rid, target: nodeId });
  }
  const description = (
    numberingNote + (opts.prompt || `${node.data.title} ${node.data.body ?? ""}`)
  ).trim();
  const count = Math.max(1, Math.min(4, opts.count ?? 1));
  const first = st.nodes.find((n) => n.id === nodeId);

  st.updateNodeData(nodeId, {
    status: "loading",
    errorMessage: undefined,
    refIds: validRefIds,
    // 重生成前把当前主图存进版本历史（可对比/回滚），并归因它当时的提示词
    ...(first?.data.imageUrl
      ? {
          versions: [
            ...(first.data.versions ?? []),
            {
              url: first.data.imageUrl as string,
              at: new Date().toISOString().slice(5, 16).replace("T", " "),
              prompt: String(first.data.genPrompt ?? "").trim() || undefined,
            },
          ].slice(-12),
        }
      : {}),
  });
  try {
    const jobId = await startShotImageJob(
      Array.from({ length: count }, (_, i) => ({
        rid: `${nodeId}#${i}`,
        name: (node.data.title as string) || "图片",
        description,
        assetType,
        visualNotes,
        referenceImages,
        referenceLabels,
      })),
      // 卡片级模型/档位覆盖（面板 chips 写入 data.gen），缺省跟随项目
      cardGen ?? undefined,
    );
    // 入参快照：补出失败候选/重试按原样重跑；imageJobId 供卡上「取消」
    useCanvasStore.getState().updateNodeData(nodeId, {
      imageJobId: jobId,
      genPrompt: opts.prompt,
      genShot: { description, assetType, visualNotes, referenceImages, referenceLabels },
      failedCandidates: undefined,
    });
    const urls: string[] = [];
    let lastError = "";
    const outcome = await pollShotImageJob(jobId, (item) => {
      if (item.ok && item.imageUrl) urls.push(item.imageUrl);
      else if (item.error) lastError = item.error;
    });
    if (outcome === "cancelled") {
      // 用户已取消：卡回原态（有图 ready，无图占位），轮询尾包幂等
      const cur = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      useCanvasStore.getState().updateNodeData(nodeId, {
        status: cur?.data.imageUrl ? "ready" : undefined,
        imageJobId: undefined,
      });
      return;
    }
    if (urls.length > 0) {
      const failed = count - urls.length;
      useCanvasStore.getState().updateNodeData(nodeId, {
        status: "ready",
        imageUrl: urls[0],
        primaryIndex: 0,
        // 单张结果直接取代上一轮的候选条（重试/单张重生成时旧变体已过时）
        imageUrls: urls.length > 1 ? urls : undefined,
        failedCandidates: failed > 0 ? failed : undefined,
      });
    } else {
      useCanvasStore.getState().updateNodeData(nodeId, {
        status: "error",
        errorMessage:
          outcome === "gone"
            ? "出图任务已失效（agent 重启），请重试"
            : lastError || "出图失败，请重试",
      });
    }
  } catch (exc) {
    useCanvasStore.getState().updateNodeData(nodeId, {
      status: "error",
      errorMessage: (exc instanceof Error ? exc.message : "出图失败").slice(0, 200),
    });
  }
}

/** 候选补出：候选有失败张数时按入参快照（genShot）原样重跑 N 张，
 *  成功结果追加进候选尾部；再失败重新计数，继续可补 */
async function supplementCandidates(nodeId: string, count: number) {
  const st = useCanvasStore.getState();
  const node = st.nodes.find((n) => n.id === nodeId);
  const shot = node?.data.genShot;
  if (!node || !shot || node.data.supplementing) return;
  const n = Math.max(1, Math.min(4, count));
  st.updateNodeData(nodeId, { supplementing: n, failedCandidates: undefined });
  const seq = Date.now().toString(36);
  try {
    const jobId = await startShotImageJob(
      Array.from({ length: n }, (_, i) => ({
        rid: `${nodeId}#s${seq}#${i}`,
        name: (node.data.title as string) || "图片",
        description: shot.description,
        assetType: shot.assetType,
        visualNotes: shot.visualNotes,
        referenceImages: shot.referenceImages,
        referenceLabels: shot.referenceLabels,
      })),
      saneGen(node.data.gen) ?? undefined,
    );
    const urls: string[] = [];
    const outcome = await pollShotImageJob(jobId, (item) => {
      if (item.ok && item.imageUrl) urls.push(item.imageUrl);
    });
    if (outcome === "cancelled") {
      useCanvasStore.getState().updateNodeData(nodeId, { supplementing: undefined });
      return;
    }
    const cur = useCanvasStore.getState().nodes.find((n2) => n2.id === nodeId);
    const existing = (cur?.data.imageUrls as string[] | undefined) ?? [];
    const appended = urls.filter((u) => !existing.includes(u));
    const stillFailed = n - appended.length;
    useCanvasStore.getState().updateNodeData(nodeId, {
      supplementing: undefined,
      failedCandidates: stillFailed > 0 ? stillFailed : undefined,
      ...(appended.length ? { imageUrls: [...existing, ...appended] } : {}),
    });
  } catch {
    useCanvasStore.getState().updateNodeData(nodeId, {
      supplementing: undefined,
      failedCandidates: n,
    });
  }
}

/** 与 agent 侧 AgentState 对齐的共享状态（读通道 ground truth） */
interface WingsightAgentState {
  canvasSummary: string;
}

const EMPTY: WingsightAgentState = { canvasSummary: "（画布为空）" };

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
  compose: "合成",
  storyboard: "分镜",
  group: "分组",
};

/** 生成结果媒体（出现在 canvas_ops 结果卡里，点击可定位画布节点） */
interface MediaItem {
  nodeId: string;
  title: string;
  url: string;
  kind: "image" | "video";
}

type OpResultEx = OpResult & {
  media?: MediaItem[];
  rejected?: boolean;
  elapsedMs?: number;
};

/** 破坏性操作审批的挂起请求（handler 阻塞等用户点确认） */
interface Approval {
  summary: string;
  resolve: (ok: boolean) => void;
}

/**
 * 画布 ↔ Agent 桥：
 *   读通道：画布摘要写入共享状态（useCoAgent state）+ 上下文（useCopilotReadable）
 *   写通道：canvas_ops 前端工具（available:"remote"），agent 调用 → 浏览器执行 applyOps
 */
export default function CanvasAgentBridge() {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  // 破坏性操作（删除/分组）审批弹窗；handler await 用户选择
  const [approval, setApproval] = useState<Approval | null>(null);

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
  const { sendMessage, isLoading } = useCopilotChatHeadless_c();
  // 文本指令发送走 v1 开源钩子：_c 的 sendMessage 对纯文本消息静默不跑
  // （Intelligence 层特性门控），侧栏纯文本也走的 v1 通道（ChatInput onSend）
  const { appendMessage } = useCopilotChat();

  // 生成中断恢复（对标 viedeo-workflow useGenerationRecovery）：刷新页面会杀掉
  // agent 运行。挂载后聊天空闲时，把仍在 loading 的卡标记为"生成中断"，
  // 用户点卡上的重试即可重发；聊天运行中则跳过（生成还在进行）。
  useEffect(() => {
    if (isLoading) return;
    const t = setTimeout(() => {
      const st = useCanvasStore.getState();
      if (!st.hydrated) return;
      const stuck = st.nodes.filter((n) => n.data.status === "loading");
      for (const n of stuck) {
        st.updateNodeData(n.id, {
          status: "error",
          errorMessage: "生成中断（页面刷新导致），点击重试",
        });
      }
    }, 6000);
    return () => clearTimeout(t);
  }, [isLoading]);
  useEffect(() => {
    const onRetry = (e: Event) => {
      const nodeId = (e as CustomEvent<{ nodeId: string }>).detail?.nodeId;
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      if (!node) return;
      // 图片卡重试同样直连（不绕聊天）；重试优先用面板提交时的原提示词
      // （genPrompt 快照），无快照（拆解链等入口）回退卡上正文
      if (node.data.nodeType === "image") {
        void directImagegen(nodeId, {
          prompt:
            String(node.data.genPrompt ?? "").trim() ||
            ((node.data.body as string) ?? "").trim(),
          refIds: ((node.data.refIds as string[]) ?? []).filter(Boolean),
        });
        return;
      }
      const what = node.data.nodeType === "video" ? "视频" : "设定图";
      useCanvasStore.getState().updateNodeData(nodeId, {
        status: "loading",
        errorMessage: undefined,
      });
      void appendMessage(
        new TextMessage({
          id: `retry_${nodeId}_${Date.now()}`,
          role: Role.User,
          content: `重新生成「${node.data.title}」的${what}`,
        }),
      );
    };
    window.addEventListener(RETRY_GENERATION_EVENT, onRetry);
    return () => window.removeEventListener(RETRY_GENERATION_EVENT, onRetry);
  }, [appendMessage]);

  // 卡片输入条（PromptBar）→ 组装含 @引用 的生成指令发给 agent
  useEffect(() => {
    const onGenerate = (e: Event) => {
      const { nodeId, kind, prompt, refIds, count } = (e as CustomEvent<GenerateDetail>)
        .detail;
      const st = useCanvasStore.getState();
      const node = st.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      // 出图=确定性任务，直连 imagegen flow（不经聊天 LLM，不刷聊天屏）
      if (kind === "image") {
        void directImagegen(nodeId, { prompt, refIds, count });
        return;
      }
      // 连线即数据流：目标卡的入边上游自动进生成上下文（@ 手动引用过的不重复）
      const upstreamLines = st.edges
        .filter((e) => e.target === nodeId && !refIds.includes(e.source))
        .map((e) => st.nodes.find((n) => n.id === e.source))
        .filter((n): n is NonNullable<typeof n> => Boolean(n))
        .map(
          (n) =>
            `- @${n.id} ${NODE_TYPE_LABEL[n.data.nodeType] ?? n.data.nodeType}「${n.data.title}」：${(n.data.body ?? "").slice(0, 300)}`,
        )
        .join("\n");
      if (node.data.nodeType === "shotlist") {
        // 分镜表修改指令（对话式重生成/增删行）：带当前行清单与上游剧本，
        // agent 用分镜生成技能重写或 canvas_ops 直接改 rows
        const rows = (node.data.rows ?? []) as { action?: string }[];
        const rowLines = rows
          .slice(0, 20)
          .map((r, i) => `${i + 1}. ${(r.action ?? "").slice(0, 60)}`)
          .join("\n");
        const scriptUp = st.edges
          .filter((e2) => e2.target === nodeId)
          .map((e2) => st.nodes.find((n) => n.id === e2.source))
          .filter((n): n is NonNullable<typeof n> => Boolean(n))
          .find((n) => n.data.nodeType === "script");
        const content = [
          `【分镜表修改】针对分镜表卡 nodeId=${nodeId}（共 ${rows.length} 行）：`,
          rowLines ? `当前分镜行：\n${rowLines}${rows.length > 20 ? "\n…" : ""}` : "（空表）",
          scriptUp
            ? `上游剧本（整表重写时以此为源）：\n${(scriptUp.data.body ?? "").slice(0, 4000)}`
            : "",
          refIds
            .map((rid) => st.nodes.find((n) => n.id === rid))
            .filter((n): n is NonNullable<typeof n> => Boolean(n))
            .map(
              (n) =>
                `- @${n.id} ${NODE_TYPE_LABEL[n.data.nodeType] ?? n.data.nodeType}「${n.data.title}」`,
            )
            .join("\n"),
          `用户指令：${prompt || "按剧本重新生成整表"}`,
          "整表重写时调用分镜生成技能，完成后用 canvas_ops update_node 把新 rows 写回该卡；小幅增删改直接 canvas_ops update_node 修改 rows，不要动其他卡。",
        ]
          .filter(Boolean)
          .join("\n");
        void appendMessage(
          new TextMessage({
            id: `shotlist_gen_${nodeId}_${Date.now()}`,
            role: Role.User,
            content,
          }),
        );
        return;
      }
      // kind === "text" 已迁至文本撰写直连管线（PromptBar → /text/rewrite，
      // 卡片级模型生效），不再经聊天主循环
      st.updateNodeData(nodeId, {
        status: "loading",
        errorMessage: undefined,
        body: prompt || node.data.body,
        // 引用关系落在卡上：选中生成卡时画布高亮这些引用卡（@一致性可视化）
        refIds,
        // 重生成前把当前主图存进版本历史（重生成不丢旧结果，可对比/回滚）
        ...(node.data.imageUrl || node.data.videoUrl
          ? {
              versions: [
                ...(node.data.versions ?? []),
                {
                  url: (node.data.imageUrl ?? node.data.videoUrl)!,
                  at: new Date().toISOString().slice(5, 16).replace("T", " "),
                  prompt: String(node.data.genPrompt ?? "").trim() || undefined,
                },
              ].slice(-12),
            }
          : {}),
      });
      const refLines = refIds
        .map((rid) => st.nodes.find((n) => n.id === rid))
        .filter((n): n is NonNullable<typeof n> => Boolean(n))
        .map(
          (n) =>
            `- @${n.id} ${NODE_TYPE_LABEL[n.data.nodeType] ?? n.data.nodeType}「${n.data.title}」：${(n.data.body ?? "").slice(0, 200)}`,
        )
        .join("\n");
      const field = kind === "video" ? "videoUrl" : "imageUrl";
      const kindLabel = kind === "video" ? "视频" : "图片";
      const content = [
        `请为画布节点 ${nodeId}（${kindLabel}卡「${node.data.title}」）生成内容：`,
        prompt || "（按卡片标题与正文生成）",
        refLines
          ? `严格参考以下画布卡片的内容描述，保持角色外形/服装/场景细节一致：\n${refLines}`
          : "",
        upstreamLines
          ? `该卡已连线接入以下上游内容，作为本次生成的依据（文本卡=画面描述来源，图片/角色卡=保持形象一致）：\n${upstreamLines}`
          : "",
        `完成后用 canvas_ops update_node 把 ${nodeId} 置为 {status:"ready", ${field}:<url>}；失败则置 {status:"error", errorMessage:<原因>}，不要让卡片停在 loading。`,
      ]
        .filter(Boolean)
        .join("\n");
      void appendMessage(
        new TextMessage({
          id: `gen_${nodeId}_${Date.now()}`,
          role: Role.User,
          content,
        }),
      );
    };
    window.addEventListener(GENERATE_EVENT, onGenerate);

    // 生成中「取消」：调 agent DELETE，卡片立即回原态（轮询尾包幂等）
    const onCancelGen = async (e: Event) => {
      const nodeId = (e as CustomEvent<{ nodeId: string }>).detail?.nodeId;
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      const jobId = node?.data.imageJobId as string | undefined;
      if (!node || !jobId) return;
      await cancelShotImageJob(jobId);
      const cur = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      useCanvasStore.getState().updateNodeData(nodeId, {
        status: cur?.data.imageUrl ? "ready" : undefined,
        imageJobId: undefined,
      });
    };
    window.addEventListener(CANCEL_GENERATION_EVENT, onCancelGen);

    // 候选「补出 N 张」：沿用原入参快照重跑失败张数
    const onSupplement = (e: Event) => {
      const { nodeId, count } = (e as CustomEvent<{ nodeId: string; count?: number }>)
        .detail;
      if (!nodeId || !count) return;
      void supplementCandidates(nodeId, count);
    };
    window.addEventListener(SUPPLEMENT_CANDIDATES_EVENT, onSupplement);

    return () => {
      window.removeEventListener(GENERATE_EVENT, onGenerate);
      window.removeEventListener(CANCEL_GENERATION_EVENT, onCancelGen);
      window.removeEventListener(SUPPLEMENT_CANDIDATES_EVENT, onSupplement);
    };
  }, [appendMessage]);

  // 视频卡"AI 拉片"→ 抽帧已上传，组装逐帧分析指令（视觉模型看图，文本模型读 URL 清单）
  useEffect(() => {
    const onAnalyze = (e: Event) => {
      const { nodeId, frames } = (e as CustomEvent<FrameAnalysisDetail>).detail;
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      if (!node || frames.length === 0) return;
      const title = node.data.title || "未命名视频";
      const textPart = [
        `请对画布节点 ${nodeId}（视频卡「${title}」）做逐帧拉片分析。以下是等间隔抽取的 ${frames.length} 帧（时间点 → 帧 URL）：`,
        ...frames.map((f) => `- ${f.t.toFixed(1)}s ${f.url}`),
        "分析角度：景别变化与镜头切换、运镜推断（推拉摇跟固定）、构图与光线、节奏与建议的剪辑点。",
        `把结论写成一张文本卡（canvas_ops add_node，nodeType=note，标题「拉片分析：${title}」，正文分小节精炼输出），并用 connect_nodes 连线 ${nodeId} → 新节点。`,
      ].join("\n");
      void sendMessage(
        {
          id: `frames_${nodeId}_${Date.now()}`,
          role: "user",
          content: [
            { type: "text", text: textPart },
            ...frames.map((f) => ({
              type: "image",
              source: { type: "url" as const, value: f.url, mimeType: "image/jpeg" },
            })),
          ],
        } as never,
        { followUp: true },
      );
    };
    window.addEventListener(FRAME_ANALYSIS_EVENT, onAnalyze);
    return () => window.removeEventListener(FRAME_ANALYSIS_EVENT, onAnalyze);
  }, [sendMessage]);

  // 分镜表某行"出图"→ 聊天指令（agent 生成后 update_row 回填行缩略图）
  useEffect(() => {
    const onRowGen = (e: Event) => {
      const { nodeId, rid, prompt, refIds } = (e as CustomEvent<RowGenerateDetail>)
        .detail;
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const refLines = refIds
        .map((rid2) => useCanvasStore.getState().nodes.find((n) => n.id === rid2))
        .filter((n): n is NonNullable<typeof n> => Boolean(n))
        .map(
          (n) =>
            `- @${n.id} ${NODE_TYPE_LABEL[n.data.nodeType] ?? n.data.nodeType}「${n.data.title}」：${(n.data.body ?? "").slice(0, 200)}`,
        )
        .join("\n");
      const content = [
        `请为分镜表节点 ${nodeId} 的镜头行 ${rid} 生成画面图：`,
        prompt || "（按该行画面描述生成）",
        refLines ? `参考以下画布卡片保持一致性：\n${refLines}` : "",
        `完成后用 canvas_ops update_node 携带 row:{rid:"${rid}", imageUrl:<url>} 回填该行缩略图；失败也请汇报原因。`,
      ]
        .filter(Boolean)
        .join("\n");
      void appendMessage(
        new TextMessage({
          id: `rowgen_${nodeId}_${rid}_${Date.now()}`,
          role: Role.User,
          content,
        }),
      );
    };
    window.addEventListener(ROW_GENERATE_EVENT, onRowGen);
    return () => window.removeEventListener(ROW_GENERATE_EVENT, onRowGen);
  }, [appendMessage]);

  // 标注重绘：原图+红笔标注合成图双参考，只改标注区域（图生图）
  useEffect(() => {
    const onMaskRedraw = (e: Event) => {
      const { nodeId, annotatedUrl, originUrl, prompt } = (
        e as CustomEvent<MaskRedrawDetail>
      ).detail;
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      if (!node) return;
      useCanvasStore.getState().updateNodeData(nodeId, {
        status: "loading",
        errorMessage: undefined,
        // 旧图进版本历史（归因它当时的提示词）
        versions: [
          ...(node.data.versions ?? []),
          ...(originUrl
            ? [
                {
                  url: originUrl,
                  at: new Date().toISOString().slice(5, 16).replace("T", " "),
                  prompt: String(node.data.genPrompt ?? "").trim() || undefined,
                },
              ]
            : []),
        ].slice(-12),
      });
      const content = [
        `请对画布节点 ${nodeId}（「${node.data.title}」）做局部重绘：`,
        `标注图：${annotatedUrl}（红色半透明笔刷 = 需要修改的区域）`,
        `原图：${originUrl}`,
        `改动要求：${prompt}`,
        "生成时严格保持标注区域以外的画面内容、构图与光线不变；以上下游一致的方式重绘红色区域。",
        `完成后用 canvas_ops update_node 把 ${nodeId} 置为 {status:"ready", imageUrl:<新图url>}；失败置 {status:"error", errorMessage:<原因>}。`,
      ].join("\n");
      void appendMessage(
        new TextMessage({
          id: `mask_${nodeId}_${Date.now()}`,
          role: Role.User,
          content,
        }),
      );
    };
    window.addEventListener(MASK_REDRAW_EVENT, onMaskRedraw);
    return () => window.removeEventListener(MASK_REDRAW_EVENT, onMaskRedraw);
  }, [appendMessage]);

  useCopilotAction({
    name: "canvas_ops",
    description:
      "操作无限画布。ops 是操作数组，每个元素必须带 op 字段标明操作类型（缺 op 的操作会被拒绝），取值与形状：每个元素形如 " +
      '{op:"add_node",nodeType:"note|script|character|image|video|audio|compose|storyboard|shotlist",title,body,position:{x,y}}（分镜卡可带 shotNumber/cameraMove/shotSize/duration/dialogue；媒体卡可带 imageUrl/videoUrl/audioUrl；shotlist 可带 rows 行数组）/ ' +
      '{op:"update_node",id,title,body}（分镜表单行回填用 {op:"update_node",id,row:{rid,imageUrl}}）/ ' +
      '{op:"delete_nodes",ids:[...]} / ' +
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
    handler: async ({ ops }: { ops?: unknown }) => {
      // 容错：部分模型会把数组序列化成字符串
      const raw =
        typeof ops === "string"
          ? safeParse(ops)
          : Array.isArray(ops)
            ? ops
            : ops && typeof ops === "object"
              ? ops
              : [];
      const list = normalizeOps(raw);

      // 人在环：删除/分组先请用户确认（整批等待，通过后一起执行）
      const destructive = list.filter(
        (o) => o.op === "delete_nodes" || o.op === "group_nodes",
      );
      if (destructive.length > 0) {
        const ok = await new Promise<boolean>((resolve) => {
          setApproval({ summary: describeDestructive(destructive), resolve });
        });
        setApproval(null);
        if (!ok) {
          const rejected: OpResultEx = {
            applied: 0,
            createdIds: [],
            errors: [],
            rejected: true,
          };
          return rejected as unknown as string;
        }
      }

      const t0 = performance.now();
      const result = applyOps(raw);
      const elapsedMs = Math.round(performance.now() - t0);
      const media = collectMedia(list, result.createdIds);
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
        // agent 建的文本卡自动进入编辑态（novanova 的 onEditText 通道）：
        // 镜头跟过去光标已在文末，用户接着写
        for (const nid of result.createdIds) {
          const n = store.nodes.find((x) => x.id === nid);
          if (
            n &&
            (n.data.nodeType === "note" || n.data.nodeType === "script")
          ) {
            window.dispatchEvent(
              new CustomEvent(FOCUS_EDIT_EVENT, { detail: { nodeId: nid } }),
            );
          }
        }
      }
      return {
        ...result,
        elapsedMs,
        ...(media.length > 0 ? { media } : {}),
      } as unknown as string;
    },
    render: ({ status, result }) => {
      if (status !== "complete" || !result) {
        return (
          <div className="flex items-center gap-1.5 py-1 text-xs text-text-3">
            <Wrench className="h-3.5 w-3.5" /> 正在操作画布…
          </div>
        );
      }
      const r = result as unknown as OpResultEx;
      if (r.rejected) {
        return (
          <div className="my-1 rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-xs text-text-3">
            已按你的选择跳过这批删除 / 分组操作。
          </div>
        );
      }
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
            {typeof r.elapsedMs === "number" ? (
              <span className="ml-1 font-normal text-text-4">
                · 用{" "}
                {r.elapsedMs >= 1000
                  ? `${(r.elapsedMs / 1000).toFixed(1)}s`
                  : `${r.elapsedMs}ms`}
              </span>
            ) : null}
          </div>
          {r.errors.length > 0 ? (
            <ul className="mt-1 list-inside list-disc text-text-3">
              {r.errors.slice(0, 5).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
          {r.media && r.media.length > 0 ? (
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {r.media.map((m) => (
                <button
                  key={`${m.nodeId}_${m.url}`}
                  type="button"
                  data-tip="点击在画布上定位" aria-label="点击在画布上定位"
                  className="group relative block overflow-hidden rounded-md border border-hairline transition-shadow hover:shadow-md"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent(FOCUS_NODES_EVENT, {
                        detail: { ids: [m.nodeId] },
                      }),
                    )
                  }
                >
                  {m.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={assetThumbUrl(m.url)}
                      alt={m.title}
                      className="h-20 w-full object-cover"
                    />
                  ) : (
                    <video
                      src={m.url}
                      muted
                      playsInline
                      preload="metadata"
                      className="h-20 w-full object-cover"
                    />
                  )}
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/45 px-1.5 py-0.5 text-[10px] text-white">
                    {m.title}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      );
    },
  });

  return approval ? (
    <ConfirmDialog
      title="允许助手修改画布？"
      message={approval.summary}
      confirmText="允许执行"
      danger
      onConfirm={() => approval.resolve(true)}
      onCancel={() => approval.resolve(false)}
    />
  ) : null;
}

/** 把破坏性操作批描述成人话（审批弹窗正文） */
function describeDestructive(ops: CanvasOp[]): string {
  const del = ops.filter((o) => o.op === "delete_nodes") as Extract<
    CanvasOp,
    { op: "delete_nodes" }
  >[];
  const grp = ops.filter((o) => o.op === "group_nodes") as Extract<
    CanvasOp,
    { op: "group_nodes" }
  >[];
  const store = useCanvasStore.getState();
  const parts: string[] = [];
  if (del.length > 0) {
    const titles = del
      .flatMap((o) => o.ids)
      .map((id) => store.nodes.find((n) => n.id === id)?.data.title ?? id)
      .slice(0, 8)
      .join("、");
    parts.push(`删除 ${del.reduce((n, o) => n + o.ids.length, 0)} 张卡片（${titles}）`);
  }
  if (grp.length > 0) {
    parts.push(
      `把 ${grp.reduce((n, o) => n + o.ids.length, 0)} 张卡片收进分组${grp[0].title ? `「${grp[0].title}」` : ""}`,
    );
  }
  return `助手请求：${parts.join("；")}。允许后这批操作会立即执行。`;
}

/** 从 ops 里挑出生成结果媒体（update_node/add_node 带 imageUrl/videoUrl） */
function collectMedia(list: CanvasOp[], createdIds: string[]): MediaItem[] {
  const store = useCanvasStore.getState();
  const out: MediaItem[] = [];
  for (const op of list) {
    if (op.op === "update_node") {
      const url = op.imageUrl ?? op.videoUrl;
      if (!url) continue;
      const node = store.nodes.find((n) => n.id === op.id);
      if (!node) continue;
      out.push({
        nodeId: op.id,
        title: node.data.title || "生成结果",
        url,
        kind: op.videoUrl ? "video" : "image",
      });
    } else if (op.op === "add_node" && op.id) {
      const url = op.imageUrl ?? op.videoUrl;
      if (!url || !createdIds.includes(op.id)) continue;
      out.push({
        nodeId: op.id,
        title: op.title || "生成结果",
        url,
        kind: op.videoUrl ? "video" : "image",
      });
    }
  }
  return out.slice(0, 6);
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
