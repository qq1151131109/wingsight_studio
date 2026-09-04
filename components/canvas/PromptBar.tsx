"use client";

/**
 * 生成输入条（生成输入面板的主体）：描述 + "@"引用画布卡片 → 点生成
 *   → GENERATE_EVENT → CanvasAgentBridge 组装指令发给 agent。
 * 引用走 MentionInput 内联 chip（open-ai-canvas 结构化 token 范式）：@ 后
 * chip 落在正文光标处，提交时带图引用自动编号 图1..图N，正文与引用同源、
 * 无「上方一排 chip、正文手写图一图二」的脱节。连线引用（上游连进来的卡）
 * 仍以 chip 亮在上方，不可删（移除=画布断线）。
 * 拖卡片媒体区抓手到面板上 = 快捷 @ 引用（ADD_REF_EVENT，nodes.tsx 的
 * MediaDragGrip 发出——图片本体不承担拖拽，拖图=移动整卡）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2, Sparkles, Star } from "lucide-react";
import {
  NODE_META,
  NODE_FOOTPRINT,
  absolutePosition,
  findFreePosition,
  useCanvasStore,
  type WingNode,
} from "@/lib/canvas/store";
import { buildRefSequence, CONTEXT_BODY_LIMIT } from "@/lib/canvas/refSequence";
import { assetThumbUrl } from "@/lib/asset-thumb";
import MentionInput, {
  type MentionInputHandle,
  type MentionRead,
} from "./MentionInput";
import {
  ADD_REF_EVENT,
  FOCUS_NODES_EVENT,
  OPEN_STYLE_EVENT,
  PROMPT_PICK_EVENT,
  type AddRefDetail,
  type PromptPickDetail,
} from "@/lib/canvas/events";
import {
  findModelOption,
  saneGen,
  useImageModels,
  type ImagegenParams,
} from "@/lib/imagegen";
import { createMyPrompt } from "@/lib/prompt-library";
import { optimizePrompt } from "@/lib/prompt-optimize";
import { rewriteText } from "@/lib/textwrite";
import {
  findTextModelOption,
  TEXT_MODEL_DEFAULT_ID,
  useTextModels,
} from "@/lib/textmodels";
import { useDismissOnOutside } from "@/lib/useDismiss";
import { Lightbox } from "./Lightbox";

/** 字面重试短语（novanova RETRY_MESSAGES 范式）：只有这些词原样出现时
 *  才复用上一轮参考重跑；改了任何文字 = 新创作 */
const RETRY_PHRASES = new Set([
  "重新生成",
  "重试",
  "再试一次",
  "再生成一次",
  "重画",
  "重画一次",
]);

/** 卡片输入条上的"直接生成"事件 */
export const GENERATE_EVENT = "wingsight:generate";
/** 候选补出（原 genShot 入参快照原样重跑）：字面「重新生成/重试」复用它 */
export const SUPPLEMENT_CANDIDATES_EVENT = "wingsight:supplement-candidates";

/** 文本撰写预填：右键「AI 润色正文」等入口把指令灌进面板（选中节点后弹出）。
 *  面板可能尚未挂载（先 selectNodes 再灌），故走模块级待取 + 事件双通道 */
export const TEXTWRITE_PREFILL_EVENT = "wingsight:textwrite-prefill";
let pendingTextWritePrefill: {
  nodeId: string;
  instruction: string;
  at: number;
} | null = null;

export function prefillTextWrite(nodeId: string, instruction: string): void {
  pendingTextWritePrefill = { nodeId, instruction, at: Date.now() };
  window.dispatchEvent(
    new CustomEvent(TEXTWRITE_PREFILL_EVENT, { detail: { nodeId } }),
  );
}

function consumeTextWritePrefill(nodeId: string): string {
  const p = pendingTextWritePrefill;
  if (p && p.nodeId === nodeId && Date.now() - p.at < 5000) {
    pendingTextWritePrefill = null;
    return p.instruction;
  }
  return "";
}

export type GenerateDetail = {
  nodeId: string;
  /** text=撰写/续写正文（note/script），image/video=媒体生成（结果回填对应
   *  URL 字段），shotlist=对话式修改分镜表（重生成/增删行） */
  kind: "image" | "video" | "text" | "shotlist";
  /** 正文：内联 @ chip 已替换——带图引用→图N（首现顺序），无图引用→《标题》 */
  prompt: string;
  /** 被 @ 的节点 id，按正文首现顺序（桥接层据此排参考图数组/注入编号契约） */
  refIds: string[];
  /** image 生成时的候选张数（1/2/4，缺省 1） */
  count?: number;
  /** 本卡原图不并入参考（输入条「本卡原图」chip 被 × 掉后的当次语义，
   *  novanova「上一张图显式动作才进参考」范式） */
  selfRefOff?: boolean;
  /** 按设定重新生成：忽略全部参考（含本卡原图/连线），用 卡上标题+设定文本
   *  纯文生图全新渲染（novanova 分镜资产重生成范式，做减法立即可见） */
  noRefs?: boolean;
  /** 派生改图（novanova/open-ai-canvas 范式）：无生成谱系的有图卡（上传图）
   *  提交不在本卡原位覆盖，事件已在源卡右侧建好连线的新空卡上发出；此字段
   *  = 源卡 id，桥接层把源图当「改图锚点」（EDIT 最小模板契约） */
  editOf?: string;
};

const KIND_PLACEHOLDER: Record<GenerateDetail["kind"], string> = {
  image: "描述画面，@ 引用画布卡片保持一致",
  video: "描述镜头内容，@ 引用画布卡片保持一致",
  text: "想让 AI 写什么？@ 引用画布卡片补充设定",
  shotlist: "想让 AI 改这页分镜？如：按剧本重新生成 / 压缩到 6 镜 / 给第 3 镜加雨戏",
};

/** 参考实体缩略（竞品通行的实体化 chip：viedeo-workflow/open-ai-canvas）：
 *  有图用缩略图，无图（文本/视频/音频）降级为类型首字徽标 */
function RefThumb({ node, size = 20 }: { node: WingNode; size?: number }) {
  const url = node.data.imageUrl as string | undefined;
  const meta = NODE_META[node.data.nodeType];
  if (url)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={assetThumbUrl(url)}
        alt=""
        className="shrink-0 rounded-sm bg-surface-2 object-contain"
        style={{ width: size, height: size }}
      />
    );
  return (
    <span
      className="grid shrink-0 place-items-center rounded-sm bg-surface-2 text-[9px] font-medium"
      style={{ width: size, height: size, color: meta?.dot }}
      title={meta?.label}
    >
      {meta?.label?.slice(0, 1) ?? "?"}
    </span>
  );
}

export default function PromptBar({
  nodeId,
  kind,
  placeholder,
  variant = "inline",
}: {
  nodeId: string;
  kind: "image" | "video" | "text" | "shotlist";
  placeholder?: string;
  /** floating = 选中卡下方的独立大面板（libtv 范式）；inline = 卡内紧凑 */
  variant?: "inline" | "floating";
}) {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const nodeType = useCanvasStore(
    (s) => s.nodes.find((n) => n.id === nodeId)?.data.nodeType,
  );
  // 出图/生视频的生成基准=卡上正文（空提示词时桥接层回退「标题+正文」），
  // 预填出来让用户看得见、可改；文本/分镜面板是「下指令」，不预填
  const self = nodes.find((n) => n.id === nodeId);
  const [count, setCount] = useState(1);
  const [favSaved, setFavSaved] = useState(false);
  // 引用 chip 缩略图点击 → 大图预览（灯箱翻页仅限有图的引用）
  const [preview, setPreview] = useState<number | null>(null);
  // 画风闸（出图直连管线与非聊天出图同规）：未选画风在本面板内联报错
  const [panelError, setPanelError] = useState("");
  // 文本撰写直连管线（/text/rewrite，卡片级 textModel 在此生效）：
  // 结果先预览，采用才覆盖正文；空卡直接落正文
  const [rwBusy, setRwBusy] = useState(false);
  const [rwResult, setRwResult] = useState<string | null>(null);
  // 内联引用编辑器（正文即引用载体）+ 序列化结果镜像（渲染/判空用）
  const edRef = useRef<MentionInputHandle>(null);
  const [lastRead, setLastRead] = useState<MentionRead | null>(null);
  const [draft, setDraft] = useState(() => {
    const self0 = useCanvasStore
      .getState()
      .nodes.find((n) => n.id === nodeId);
    const pre =
      kind === "text" ? consumeTextWritePrefill(nodeId) : "";
    if (pre) return pre;
    // 出图/生视频预填优先用上一次生成的提示词（genPrompt 快照），
    // 没有才回退卡上正文——重开面板不丢当时敲的词
    return kind === "image" || kind === "video"
      ? (String(self0?.data.genPrompt ?? "").trim() ||
          ((self0?.data.body as string) ?? "").trim())
      : "";
  });
  const projectStyle = useCanvasStore((s) => s.projectStyle);
  const projectImagegen = useCanvasStore((s) => s.imagegen);
  const { models: imageModels } = useImageModels();
  // 本卡生效的出图参数（卡片级覆盖 > 项目级）：容量计数按此模型口径
  const cardGen = saneGen(self?.data.gen);
  // 派生改图（novanova/open-ai-canvas 范式，7/8 竞品共识）：无生成谱系的
  // 有图图片卡（上传图/素材库图，genShot/genPrompt 皆无）提交不在本卡原位
  // 覆盖——右侧建新图卡+连线，本图作改图锚点；已生成的卡（有谱系）保持
  // 原位+版本档案（锚定控制/快照重跑整套语义），以谱系为界互不越界
  const deriveEdit =
    kind === "image" &&
    self?.data.nodeType === "image" &&
    Boolean(self.data.imageUrl) &&
    !self.data.genShot &&
    !(String(self.data.genPrompt ?? "").trim());

  // 连线即引用（open-ai-canvas「已连接素材」/ novanova「mention 来自连线」）：
  // 上游连进来的卡本来就参与生成（桥接层 upstreamLines 注入），这里如实亮出
  // 来。连线引用不可删（移除=画布断线）；手动 @ 引用已内联进正文，不再挂 chip
  // 本卡原图当次移除（novanova「上一张图显式动作才进参考」范式）：× 掉后
  // 本次纯文生图/仅外部参考，面板重开（切卡）自动恢复默认带上
  const [selfRefOff, setSelfRefOff] = useState(false);
  const connectedRefs = useMemo(() => {
    const out: WingNode[] = [];
    for (const e of edges) {
      if (e.target !== nodeId) continue;
      const n = nodes.find((x) => x.id === e.source);
      if (
        !n ||
        n.id === nodeId ||
        n.data.nodeType === "group" ||
        out.some((x) => x.id === n.id)
      )
        continue;
      out.push(n);
    }
    return out;
  }, [edges, nodes, nodeId]);
  const previewImgs = connectedRefs
    .filter((r) => Boolean(r.data.imageUrl))
    .map((r) => ({ src: r.data.imageUrl as string, title: r.data.title ?? "" }));

  // 参考序列单一事实源（与 CanvasAgentBridge.directImagegen 同一构建器）：
  // 计数「参考 N/4」与 chips 上的 图N 位次都从这里读——口径漂移曾让用户
  // 以为参考没带上（罪案实录事故）
  const refSeq = useMemo(
    () =>
      kind === "image"
        ? buildRefSequence({
            mentionIds: lastRead?.mentionIds ?? [],
            nodes,
            selfId: nodeId,
            selfImageUrl:
              selfRefOff
                ? undefined
                : ((self?.data.imageUrl as string | undefined) ?? undefined),
            // 派生改图的参考 = @ 引用 + 本图（本卡连线不随迁新卡）——口径
            // 永远按实际发送算；谱系卡原位生成时连线照常参与
            connectedIds: deriveEdit
              ? []
              : connectedRefs.map((r) => r.id),
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- self 的变化由 nodes 依赖承载
    [kind, lastRead, nodes, nodeId, connectedRefs, selfRefOff],
  );
  const refSeqLabelOf = (id: string) =>
    refSeq?.entries.find((e) => e.node.id === id)?.label;

  // 死引用检测：@ImageN 式字面文本（外部工具的引用惯例）不会被解析成
  // 引用 token，软提示不拦截——真引用是打 @ 选 chip，提交时自动编号 图N
  const [deadRefHint, setDeadRefHint] = useState(false);
  const onEditorChange = useCallback((r: MentionRead) => {
    setLastRead(r);
    setDraft(r.display);
    setDeadRefHint(/@[A-Za-z]{0,10}\s*\d/.test(r.display));
  }, []);

  // AI 提示词辅助（✦ 双态：优化扩写 / 看图反推；产物回填草稿可再改）。
  // 图源 = 本卡原图 + 正文 @ 的带图引用（编号序）+ 连线引用
  const [aiBusy, setAiBusy] = useState(false);
  const mentionedImgs = (lastRead?.imageRefIds ?? [])
    .map((id) => nodes.find((n) => n.id === id)?.data.imageUrl as string | undefined)
    .filter((u): u is string => Boolean(u));
  const assistImages = [
    self?.data.imageUrl,
    ...mentionedImgs,
    ...previewImgs.map((p) => p.src),
  ]
    .filter((u): u is string => Boolean(u))
    .slice(0, 4);
  const assistContext = [
    ...(lastRead?.mentionIds ?? [])
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is WingNode => Boolean(n))
      .map((n) => `${n.data.title}：${(n.data.body as string) ?? ""}`.slice(0, CONTEXT_BODY_LIMIT)),
    ...connectedRefs.map(
      (n) => `${n.data.title}：${(n.data.body as string) ?? ""}`.slice(0, CONTEXT_BODY_LIMIT),
    ),
    projectStyle.trim() ? `全局视觉风格：${projectStyle.trim()}` : "",
  ]
    .filter(Boolean)
    .join("；");
  const aiLabel = draft.trim() ? "优化" : "看图反推";
  const canAssist = Boolean(draft.trim()) || assistImages.length > 0;

  const runAssist = async () => {
    if (aiBusy || !canAssist) return;
    setAiBusy(true);
    setPanelError("");
    try {
      const out = await optimizePrompt({
        mode: draft.trim() ? "optimize" : "reversal",
        prompt: draft.trim(),
        imageUrls: assistImages,
        contextNotes: assistContext,
      });
      edRef.current?.setValue(out);
    } catch (exc) {
      setPanelError(exc instanceof Error ? exc.message : "AI 辅助失败");
    } finally {
      setAiBusy(false);
    }
  };

  // 提示词库点选 → 追加到输入框
  useEffect(() => {
    const onPick = (e: Event) => {
      const { text } = (e as CustomEvent<PromptPickDetail>).detail;
      if (!text) return;
      const ed = edRef.current;
      if (!ed) return;
      const cur = ed.read().display;
      ed.setValue(cur.trim() ? `${cur.trimEnd()}, ${text}` : text);
      ed.focus();
    };
    window.addEventListener(PROMPT_PICK_EVENT, onPick);
    return () => window.removeEventListener(PROMPT_PICK_EVENT, onPick);
  }, []);

  // 拖画布媒体到面板 = 快捷 @ 该卡（viedeo-workflow drag-to-chat 范式；
  // 含本卡自己 = 快捷自引旧图做图生图）
  useEffect(() => {
    const onAddRef = (e: Event) => {
      const refId = (e as CustomEvent<AddRefDetail>).detail?.nodeId;
      if (!refId) return;
      edRef.current?.appendMention(refId);
    };
    window.addEventListener(ADD_REF_EVENT, onAddRef);
    return () => window.removeEventListener(ADD_REF_EVENT, onAddRef);
  }, []);

  // 面板已挂载时的预填充（挂载前的那份由 initialText 消费）
  useEffect(() => {
    if (kind !== "text") return;
    const onPrefill = (e: Event) => {
      if ((e as CustomEvent<{ nodeId: string }>).detail?.nodeId !== nodeId)
        return;
      const pre = consumeTextWritePrefill(nodeId);
      if (pre) {
        edRef.current?.setValue(pre);
        edRef.current?.focus();
      }
    };
    window.addEventListener(TEXTWRITE_PREFILL_EVENT, onPrefill);
    return () => window.removeEventListener(TEXTWRITE_PREFILL_EVENT, onPrefill);
  }, [nodeId, kind]);

  /** 派生改图落卡：右侧避让找位建新图卡（标题取提示词开头，可引用可检索）
   *  + 连线本卡；对新卡而非源卡发事件（对源卡发是原位生成会覆盖上传图）。
   *  @ 引用随迁（桥接层会落成连线），卡级 gen 覆盖（模型/画幅）一并继承；
   *  noRefs（按设定重掷）派生时不连线，纯文生图新卡 */
  const deriveAndGenerate = (o: {
    prompt: string;
    display: string;
    empty: boolean;
    refIds: string[];
    noRefs?: boolean;
  }) => {
    const st = useCanvasStore.getState();
    const src = st.nodes.find((n) => n.id === nodeId);
    if (!src) return;
    const abs = absolutePosition(st.nodes, src);
    const nw = src.measured?.width ?? NODE_FOOTPRINT.image.w;
    const desc =
      (o.empty ? "" : o.prompt) ||
      `${src.data.title ?? ""} ${(src.data.body ?? "").trim()}`.trim();
    const newId = st.addNode({
      position: findFreePosition(
        st.nodes,
        { x: abs.x + nw + 80, y: abs.y },
        NODE_FOOTPRINT.image,
      ),
      data: {
        nodeType: "image",
        title:
          o.display.trim().slice(0, 20) || `${src.data.title || "图片"} · 衍生`,
        body: "",
        ...(src.data.gen ? { gen: src.data.gen } : {}),
      },
    });
    if (!o.noRefs && !selfRefOff) st.connect({ source: nodeId, target: newId });
    st.flashNodes([newId]);
    window.dispatchEvent(
      new CustomEvent<GenerateDetail>(GENERATE_EVENT, {
        detail: {
          nodeId: newId,
          kind: "image",
          prompt: desc,
          refIds: o.noRefs ? [] : o.refIds,
          ...(count > 1 ? { count } : {}),
          ...(o.noRefs
            ? { selfRefOff: true, noRefs: true }
            : selfRefOff
              ? { selfRefOff: true }
              : { editOf: nodeId }),
        },
      }),
    );
  };

  const submit = () => {
    const r = edRef.current?.read();
    if (!r) return;
    // 画风闸：出图直连管线与非聊天出图同规，未选画风拦下并自动弹画风弹窗
    if (kind === "image" && !projectStyle.trim()) {
      setPanelError("未选画风：请在弹出的「项目画风」里设定，再出图");
      window.dispatchEvent(new CustomEvent(OPEN_STYLE_EVENT));
      return;
    }
    setPanelError("");
    // 出图/生视频允许空提示词（=按卡上标题与正文重生成）；下指令类必须有问题
    if (r.empty && (kind === "text" || kind === "shotlist")) return;
    // 字面「重新生成/重试」= 原参数原参考按入参快照重跑一次（novanova
    // RETRY_MESSAGES 范式：改了 prompt 文字才是新创作，不回喂旧参考）；
    // 没有快照（从未生成过）则落回普通生成
    if (kind === "image" && RETRY_PHRASES.has(r.display.trim())) {
      if (self?.data.genShot) {
        window.dispatchEvent(
          new CustomEvent<{ nodeId: string; count?: number }>(
            SUPPLEMENT_CANDIDATES_EVENT,
            { detail: { nodeId, count: 1 } },
          ),
        );
        return;
      }
    }
    if (kind === "text") {
      void runTextRewrite(r.prompt);
      return;
    }
    // 无谱系有图卡（上传图）：提交 = 派生改图——本卡不动，右侧新卡承接结果
    if (deriveEdit) {
      deriveAndGenerate({
        prompt: r.prompt,
        display: r.display,
        empty: r.empty,
        refIds: r.mentionIds,
      });
      return;
    }
    window.dispatchEvent(
      new CustomEvent<GenerateDetail>(GENERATE_EVENT, {
        detail: {
          nodeId,
          kind,
          prompt: r.prompt,
          refIds: r.mentionIds,
          ...(kind === "image" && count > 1 ? { count } : {}),
          ...(kind === "image" && selfRefOff ? { selfRefOff: true } : {}),
    },
      }),
    );
    // 出图/生视频生成后保留提示词（用户要求可追溯、方便接着改）；
    // 分镜指令是一次性的，仍清空。文本撰写在 runTextRewrite 里自行清
    if (kind === "shotlist") edRef.current?.setValue("");
  };

  /** 文本撰写直连管线：/text/rewrite（卡片级 textModel 在此生效），结果
   *  预览采用才覆盖；空卡直接落正文。上下文 = 正文 @ 引用（编号序）+ 连线卡 */
  const runTextRewrite = async (instruction: string) => {
    if (rwBusy) return;
    setRwBusy(true);
    setRwResult(null);
    setPanelError("");
    try {
      const body = ((self?.data.body as string) ?? "").trim();
      const mentioned = (lastRead?.mentionIds ?? [])
        .map((id) => nodes.find((n) => n.id === id))
        .filter((n): n is WingNode => Boolean(n));
      const context = [...mentioned, ...connectedRefs]
        .filter(
          (n, i, arr) =>
            arr.findIndex((x) => x.id === n.id) === i &&
            ((n.data.body as string) ?? "").trim(),
        )
        .map((n) => {
          const label = NODE_META[n.data.nodeType]?.label ?? n.data.nodeType;
          return `【${label}·${n.data.title || "（无标题）"}】${((n.data.body as string) ?? "").trim().slice(0, CONTEXT_BODY_LIMIT)}`;
        })
        .join("\n");
      const result = await rewriteText({
        instruction,
        body,
        context,
        model: String(self?.data.textModel ?? "").trim() || undefined,
      });
      if (!body) {
        // 空卡直接落正文（无覆盖风险）
        useCanvasStore.getState().updateNodeData(nodeId, { body: result });
        edRef.current?.setValue("");
      } else {
        setRwResult(result);
      }
    } catch (exc) {
      setPanelError(exc instanceof Error ? exc.message : "AI 撰写失败");
    } finally {
      setRwBusy(false);
    }
  };

  const floating = variant === "floating";
  // 图生图锚点提示：本卡已有图时自动并入参考（未在正文 @ 时排最前，
  // 桥接层 directImagegen）；正文里 @ 本卡可显式指定它的编号位置
  const selfImageChip = kind === "image" && Boolean(self?.data.imageUrl);
  // 智能编排（缺省开）：出图前经「指令合成」flow 扩写短指令（详见 lib 说明）
  const composeOn = kind === "image" && self?.data.composeOpt !== false;
  return (
    <div
      className={`ws-detail nodrag nowheel rounded-md border border-hairline bg-surface-2/60 ${
        floating ? "border-0 bg-transparent p-0" : "mt-1.5 p-1.5"
      }`}
    >
      {connectedRefs.length > 0 || selfImageChip ? (
        <div className={`flex flex-wrap gap-1 ${floating ? "mb-1.5" : "mb-1"}`}>
          {selfImageChip ? (
            <span
              className="inline-flex items-center gap-1 rounded border border-solid border-accent-soft bg-surface-1 py-0.5 pl-0.5 pr-1 text-[10px] text-text-2"
              title={
                deriveEdit
                  ? "提交将派生连线新卡：本图作为改图参考（图生图，原图不动）；在正文 @ 本卡可指定它的编号位置"
                  : "本卡当前图自动作为参考参与本次生成（图生图）；在正文 @ 本卡可指定它的编号位置"
              }
            >
              <RefThumb node={self as WingNode} />
              <span className="pr-0.5 text-accent">本卡原图</span>
              {refSeqLabelOf(nodeId) ? (
                <span className="tabular-nums text-text-4">{refSeqLabelOf(nodeId)}</span>
              ) : null}
              <button
                type="button"
                data-tip={
                  deriveEdit
                    ? selfRefOff
                      ? "载回：派生卡重新带上本图作参考"
                      : "移除：派生卡不带本图（纯文生图/仅 @ 引用）"
                    : selfRefOff
                      ? "载回：本卡原图重新并入参考"
                      : "移除：本次不锚定本卡原图（纯文生图/仅外部参考）"
                } aria-label={selfRefOff ? "载回本卡原图" : "移除本卡原图参考"}
                className="px-0.5 text-text-4 transition-colors hover:text-text"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelfRefOff(!selfRefOff);
                }}
              >
                {selfRefOff ? "载回" : "×"}
              </button>
            </span>
          ) : null}
          {connectedRefs.map((r, i) => {
            const hasImg = Boolean(r.data.imageUrl);
            // 该引用在可预览图片序列里的位次（前面的有图引用数）
            const imgIdx = connectedRefs
              .slice(0, i)
              .filter((x) => Boolean(x.data.imageUrl)).length;
            return (
              <span
                key={r.id}
                className="inline-flex items-center gap-1 rounded border border-dashed border-hairline bg-surface-1 py-0.5 pl-0.5 pr-1 text-[10px] text-text-2"
                title={
                  "连线引用：此卡已连入本卡、参与本次生成（断开连线即移除）" +
                  ((r.data.body ?? "").trim()
                    ? `\n${(r.data.body as string).slice(0, 80)}`
                    : "")
                }
              >
                {hasImg ? (
                  <button
                    type="button"
                    data-tip="预览参考图" aria-label="预览参考图"
                    className="shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPreview(imgIdx);
                    }}
                  >
                    <RefThumb node={r} />
                  </button>
                ) : (
                  <RefThumb node={r} />
                )}
                <button
                  type="button"
                  data-tip="定位到画布卡片" aria-label="定位到画布卡片"
                  className="max-w-24 truncate transition-colors hover:text-accent"
                  onClick={(e) => {
                    e.stopPropagation();
                    const st = useCanvasStore.getState();
                    st.selectNodes([r.id]);
                    window.dispatchEvent(
                      new CustomEvent(FOCUS_NODES_EVENT, {
                        detail: { ids: [r.id] },
                      }),
                    );
                  }}
                >
                  {refSeqLabelOf(r.id) ? (
                    <span className="mr-0.5 tabular-nums text-accent">{refSeqLabelOf(r.id)}</span>
                  ) : null}
                  @{r.data.title?.slice(0, 10) ||
                    (r.data.body as string)?.trim().slice(0, 10) ||
                    NODE_META[r.data.nodeType]?.label ||
                    "无题"}
                </button>
              </span>
            );
          })}
          {/* 上次生成的参考快照（genShot）：实时序列之外的快照参考以
              「快照」chip 回显——novanova 持久化参考范式，重开面板也能
              看到上次用了哪些参考（字面「重新生成」会按快照原样重跑） */}
          {(self?.data.genShot?.referenceImages ?? [])
            .filter((u) => u && !(refSeq?.urls ?? []).includes(u))
            .map((u) => (
              <span
                key={u}
                className="inline-flex items-center gap-1 rounded border border-dotted border-hairline bg-surface-1 py-0.5 pl-0.5 pr-1 text-[10px] text-text-4"
                title="上次生成使用的参考快照（本次实时序列不含它；字面「重新生成」会按快照原样重跑）"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={assetThumbUrl(u)} alt="" className="h-4 w-4 rounded-sm object-cover" />
                <span>快照</span>
              </span>
            ))}
          {kind === "image" && (self?.data.body as string)?.trim() ? (
            <button
              type="button"
              data-tip="忽略全部参考，用卡上标题+设定文本纯文生图全新渲染（修改设定文本后点这里，做减法的调整立即可见）" aria-label="按设定重新生成（纯文生图新图）"
              className="ml-auto inline-flex shrink-0 items-center gap-0.5 self-center rounded border border-dashed border-hairline bg-surface-1 px-1.5 py-0.5 text-[10px] text-text-3 transition-colors hover:border-accent hover:text-text"
              onClick={(e) => {
                e.stopPropagation();
                // 无谱系卡（上传图）不在本卡原位覆盖——同样派生新卡，纯文生图
                if (deriveEdit) {
                  deriveAndGenerate({
                    prompt: "",
                    display: "",
                    empty: true,
                    refIds: [],
                    noRefs: true,
                  });
                  return;
                }
                window.dispatchEvent(
                  new CustomEvent<GenerateDetail>(GENERATE_EVENT, {
                    detail: { nodeId, kind, prompt: "", refIds: [], selfRefOff: true, noRefs: true },
                  }),
                );
              }}
            >
              ⟳ 按设定重掷
            </button>
          ) : null}
        </div>
      ) : null}
      {/* 文本撰写结果预览：采用才覆盖正文（误覆盖敏感，竞品全无的确认流） */}
      {kind === "text" && rwResult !== null ? (
        <div className="mb-1 rounded-md border border-accent-soft bg-surface-1 p-1.5">
          <p className="px-0.5 text-[10px] text-text-3">
            AI 生成结果 — 采用后覆盖卡片正文
          </p>
          <div className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap px-0.5 text-xs leading-relaxed text-text">
            {rwResult}
          </div>
          <div className="mt-1.5 flex gap-1.5">
            <button
              type="button"
              className="rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-85"
              onClick={() => {
                useCanvasStore
                  .getState()
                  .updateNodeData(nodeId, { body: rwResult });
                setRwResult(null);
                edRef.current?.setValue("");
              }}
            >
              采用
            </button>
            <button
              type="button"
              className="rounded border border-hairline px-2.5 py-1 text-[11px] text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
              onClick={() => setRwResult(null)}
            >
              丢弃
            </button>
          </div>
        </div>
      ) : null}
      {rwBusy ? (
        <p className="mb-1 flex items-center gap-1.5 px-1 text-[10px] text-text-3">
          <Loader2 className="h-3 w-3 motion-safe:animate-spin" />
          AI 正在撰写…
        </p>
      ) : null}
      {/* 输入区独占一行 + 随内容增高；参数/模型在底栏左侧，发送在右侧。
          MentionInput：@ 内联 chip 编辑器（含候选弹层与整 chip 删除） */}
      <div>
        <MentionInput
          ref={edRef}
          nodeId={nodeId}
          connectedIds={connectedRefs.map((r) => r.id)}
          placeholder={
            placeholder ??
            (deriveEdit
              ? "输入想把它改成什么：生成连线新卡，本图自动作参考、原图不动"
              : KIND_PLACEHOLDER[kind])
          }
          initialText={draft || undefined}
          minHeight={floating ? 96 : 44}
          maxHeight={floating ? 260 : 120}
          onChange={onEditorChange}
          onSubmit={submit}
        />
      </div>
      {kind === "image" && deadRefHint ? (
        <p className="mb-1 px-0.5 text-[10px] leading-relaxed text-warn">
          「@ImageN」只是普通文本，不会当作参考引用——删掉后打 @ 从候选选卡，提交时自动编号为 图1/图2…
        </p>
      ) : null}
      {/* 智能编排合成结果回显：可追溯（真实发给出图模型的提示词），可载入
          输入框修改后重发——LLM 编排模式的黑箱必须开着盖 */}
      {kind === "image" && self?.data.composedPrompt ? (
        <details className="mb-1 rounded-md border border-hairline-soft bg-surface-1 px-1.5 py-1">
          <summary className="cursor-pointer select-none text-[10px] text-text-3">
            本次合成提示词（智能编排 · 点开查看）
          </summary>
          <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-text-2">
            {self.data.composedPrompt}
          </p>
          <button
            type="button"
            className="mt-1 text-[10px] text-accent hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              edRef.current?.setValue(self.data.composedPrompt!);
            }}
          >
            载入输入框修改
          </button>
        </details>
      ) : null}
      {/* 注入开盖（萧燕燕事故后的透明度补齐，全行业竞品都没做）：上次生成
          实际注入的参考资产设定与全局画风（genShot.visualNotes 快照）。
          参考图与设定文本打架（上传金袍图 vs 拆解素服文本）时，用户在这里
          能直接看到两路输入，不再是无从排查的黑箱 */}
      {kind === "image" && (self?.data.genShot?.visualNotes ?? "").trim() ? (
        <details className="mb-1 rounded-md border border-hairline-soft bg-surface-1 px-1.5 py-1">
          <summary className="cursor-pointer select-none text-[10px] text-text-3">
            本次注入的设定与画风（上次生成 · 点开查看）
          </summary>
          <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-text-2">
            {self!.data.genShot!.visualNotes}
          </p>
        </details>
      ) : null}
      {/* 底栏：左侧 = 生成参数（出图候选/模型、文本模型），右侧 = 辅助/收藏/发送
          （对标竞品 composer：模型左下、发送右下圆钮） */}
      <div className="mt-1 flex items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {kind === "image" ? (
            <>
              {/* 卡片级出图模型/档位（写本卡 data.gen，缺省跟随项目）：
                  批量/重跑/聊天入口生成此卡时全部生效；置于底栏最左 */}
              <ImagegenChips nodeId={nodeId} />
              <span className="shrink-0 text-[10px] text-text-4">候选</span>
              {[1, 2, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                    count === n
                      ? "bg-accent-dim text-text"
                      : "text-text-3 hover:bg-surface-2 hover:text-text"
                  }`}
                  onClick={() => setCount(n)}
                  data-track="promptbar.count"
                  data-track-props={JSON.stringify({ count: n, kind })}
                >
                  {n} 张
                </button>
              ))}
              {/* 模式标签（Storyboard-Copilot modeLabel 范式）：提交前就
                  知道这次会不会被参考图锚定 */}
              {deriveEdit && !selfRefOff ? (
                <span
                  className="shrink-0 whitespace-nowrap rounded px-1 py-1 text-[11px] text-text-4"
                  data-tip="派生改图：提交生成连线的新卡，以本图为改图锚点（保留构图只改要改的），本卡原图不动"
                >
                  派生改图
                </span>
              ) : (
              <span
                className="shrink-0 whitespace-nowrap rounded px-1 py-1 text-[11px] text-text-4"
                data-tip={
                  refSeq && refSeq.entries.some((e) => e.kind === "self")
                    ? "编辑模式：本卡原图参与参考，输出将保留其构图与已确认内容"
                    : refSeq && refSeq.entries.length > 0
                      ? "参考生成：以 @/连线的卡为一致性参考"
                      : "文生图：无参考图，按提示词全新生成"
                }
              >
                {refSeq && refSeq.entries.length > 0
                  ? refSeq.entries.some((e) => e.kind === "self")
                    ? "编辑模式"
                    : "参考生成"
                  : "文生图"}
              </span>
              )}
              {/* 参考图容量计数（open-ai-canvas 按模型预算范式）：按本卡生效
                  模型的 max_references 实时显示。口径 = buildRefSequence 的
                  实际发送序列（@ 引用带图卡 + 本卡原图 + 连线带图卡，按图
                  URL 去重），与 directImagegen 同源——口径不一致曾让用户
                  以为参考没带上（罪案实录事故） */}
              {(() => {
                const cap =
                  findModelOption(
                    cardGen?.model ?? projectImagegen.model,
                    imageModels,
                  )?.max_references ?? 4;
                const used = refSeq?.entries.length ?? 0;
                return (
                  <span
                    className={`shrink-0 whitespace-nowrap text-[10px] tabular-nums ${
                      used > cap ? "text-danger" : "text-text-4"
                    }`}
                    title={`本次生成将携带 ${used} 张参考图（@ 引用 + 本卡原图 + 连线卡）；当前模型最多 ${cap} 张`}
                  >
                    参考 {used}/{cap}
                  </span>
                );
              })()}
              {/* 智能编排开关（novanova KEEP/OPTIMIZE 范式）：开=出图前经
                  「指令合成」flow 把 短指令+设定文本 扩写成完整提示词；
                  完整描述/改图指令自动判定 keep 原样直传。默认开 */}
              <button
                type="button"
                data-tip={
                  composeOn
                    ? "智能编排已开启：短指令将结合卡片设定自动扩写成完整提示词，改图指令/完整描述原样直传（点击关闭）"
                    : "智能编排已关闭：输入框文本原样直传生图模型（点击开启）"
                } aria-label={
                  composeOn
                    ? "智能编排已开启：短指令将结合卡片设定自动扩写成完整提示词，改图指令/完整描述原样直传（点击关闭）"
                    : "智能编排已关闭：输入框文本原样直传生图模型（点击开启）"
                }
                className={`shrink-0 whitespace-nowrap rounded px-1.5 py-1 text-[11px] transition-colors ${
                  composeOn ? "text-accent" : "text-text-4 hover:bg-surface-2 hover:text-text-2"
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  useCanvasStore
                    .getState()
                    .updateNodeData(nodeId, { composeOpt: composeOn ? false : undefined });
                }}
              >
                编排{composeOn ? "开" : "关"}
              </button>
            </>
          ) : null}
          {nodeType === "script" || nodeType === "shotlist" || nodeType === "note" ? (
            /* 卡片级文本模型（写本卡 data.textModel，缺省跟随出厂默认）：
                拆解资产/生成分镜表等 flow 全部生效；文本卡/剧本卡的「撰写」
                直连管线（/text/rewrite）也按此模型执行 */
            <TextModelChip nodeId={nodeId} />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
        {kind === "image" || kind === "video" ? (
          <button
            type="button"
            disabled={aiBusy || !canAssist}
            data-tip={
              draft.trim()
                ? "AI 优化提示词：保留主体意图扩写成完整出图提示词，结果回填可再改"
                : "看图反推：AI 按卡上图/参考图写出出图提示词，结果回填可再改"
            } aria-label={
              draft.trim()
                ? "AI 优化提示词：保留主体意图扩写成完整出图提示词，结果回填可再改"
                : "看图反推：AI 按卡上图/参考图写出出图提示词，结果回填可再改"
            }
            className={`flex shrink-0 items-center gap-1 border border-hairline bg-surface-1 text-text-2 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40 ${
              floating ? "h-8 rounded-full px-3 text-xs" : "h-7 rounded-md px-1.5 text-[11px]"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              void runAssist();
            }}
            data-track="promptbar.assist"
            data-track-props={JSON.stringify({ mode: aiLabel, kind })}
          >
            {aiBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className={floating ? "h-3.5 w-3.5" : "h-3 w-3"} />
            )}
            {aiBusy ? "AI…" : aiLabel}
          </button>
        ) : null}
        <button
          type="button"
          data-tip={favSaved ? "已存入提示词库" : "把当前输入存入提示词库（底部坞「提示词」可查看复用）"} aria-label={favSaved ? "已存入提示词库" : "把当前输入存入提示词库（底部坞「提示词」可查看复用）"}
          className={`flex shrink-0 items-center gap-1 border border-hairline bg-surface-1 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed ${
            floating ? "h-8 rounded-full px-3 text-xs" : "h-7 rounded-md px-2 text-[11px]"
          } ${favSaved ? "text-warn" : "text-text-2"}`}
          onClick={() => {
            const t = draft.trim();
            if (!t) return;
            createMyPrompt("", t)
              .then(() => {
                setFavSaved(true);
                setTimeout(() => setFavSaved(false), 1500);
              })
              .catch((e: unknown) =>
                setPanelError(e instanceof Error ? e.message : "存入提示词库失败"),
              );
          }}
          data-track="promptbar.save-preset"
        >
          <Star className={`h-3.5 w-3.5 ${favSaved ? "fill-current" : ""}`} />
          {favSaved ? "已收藏" : "存入提示词库"}
        </button>
        <button
          type="button"
          disabled={rwBusy}
          data-tip={
            kind === "text"
              ? "让 AI 撰写（Ctrl+Enter）"
              : kind === "shotlist"
                ? "让 AI 修改分镜表（Ctrl+Enter）"
                : "生成（Ctrl+Enter）；清空提示词=按卡片标题与正文重生成"
          } aria-label={
            kind === "text"
              ? "让 AI 撰写（Ctrl+Enter）"
              : kind === "shotlist"
                ? "让 AI 修改分镜表（Ctrl+Enter）"
                : "生成（Ctrl+Enter）；清空提示词=按卡片标题与正文重生成"
          }
          className={`flex shrink-0 items-center gap-1 bg-accent font-medium text-white transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50 ${
            floating ? "h-8 rounded-full px-4 text-xs" : "h-7 rounded-md px-2 text-[11px]"
          }`}
          onClick={submit}
          data-track="promptbar.generate"
          data-track-props={JSON.stringify({ kind })}
        >
          {rwBusy ? (
            <Loader2 className={`motion-safe:animate-spin ${floating ? "h-3.5 w-3.5" : "h-3 w-3"}`} />
          ) : (
            <Sparkles className={floating ? "h-3.5 w-3.5" : "h-3 w-3"} />
          )}
          {kind === "text" ? (rwBusy ? "撰写中…" : "撰写") : kind === "shotlist" ? "修改" : "生成"}
        </button>
        </div>
      </div>
      {panelError ? (
        <p className="mt-1 px-1 text-[10px] leading-relaxed text-danger">
          {panelError}
        </p>
      ) : null}
      {preview !== null && previewImgs.length > 0 ? (
        <Lightbox
          images={previewImgs}
          index={Math.min(preview, previewImgs.length - 1)}
          onIndex={setPreview}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}

/** 文本模型 chip（输入条 · 选中剧本/分镜表/文本卡时出现）：卡片级覆盖存
 *  data.textModel，空=跟随出厂默认（agent/models.py）。
 *  驱动范围：剧本卡=拆解资产；分镜表卡=生成分镜 + 本卡拆解；
 *  文本卡/剧本卡「撰写」= 文本撰写直连管线（/text/rewrite 按此模型执行） */
function TextModelChip({ nodeId }: { nodeId: string }) {
  const data = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId)?.data);
  const { models } = useTextModels();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  useDismissOnOutside(wrapRef, open, () => setOpen(false));
  const current = String(data?.textModel ?? "").trim();
  const option = findTextModelOption(current, models);
  const defaultOption = findTextModelOption(TEXT_MODEL_DEFAULT_ID, models);
  const effectiveLabel = current
    ? (option?.label ?? current)
    : (defaultOption?.label ?? TEXT_MODEL_DEFAULT_ID);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <span ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        data-tip={`文本模型（生成分镜/拆解的 LLM）：${effectiveLabel}${
          current ? "" : "（跟随默认）"
        }`}
        aria-label="文本模型"
        className={`flex items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-[11px] transition-colors hover:bg-surface-2 ${
          current ? "text-text" : "text-text-2"
        }`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {effectiveLabel}
        <ChevronDown className="h-3 w-3 text-text-4" />
      </button>
      {open ? (
        <span
          className="absolute bottom-full left-0 z-30 mb-1.5 block w-64 rounded-md border border-hairline bg-surface-1 p-2 text-left shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="block text-[10px] font-medium text-text-4">
            文本模型（生成分镜 / 拆解资产）
          </span>
          <span className="mt-1 block max-h-44 space-y-0.5 overflow-y-auto">
            <button
              type="button"
              className={`block w-full rounded px-1.5 py-1 text-left transition-colors ${
                current === "" ? "bg-accent-dim" : "hover:bg-surface-2"
              }`}
              onClick={() =>
                useCanvasStore.getState().updateNodeData(nodeId, { textModel: undefined })
              }
            >
              <span className="block text-[11px] text-text">跟随默认</span>
              <span className="block text-[9px] text-text-4">
                {defaultOption
                  ? `${defaultOption.label} · ${defaultOption.tag}`
                  : TEXT_MODEL_DEFAULT_ID}
              </span>
            </button>
            {models === null ? (
              <span className="block px-1.5 py-1 text-[10px] text-text-4">
                加载模型目录…
              </span>
            ) : (
              models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`block w-full rounded px-1.5 py-1 text-left transition-colors ${
                    m.id === current ? "bg-accent-dim" : "hover:bg-surface-2"
                  }`}
                  onClick={() =>
                    useCanvasStore.getState().updateNodeData(nodeId, { textModel: m.id })
                  }
                >
                  <span className="block text-[11px] text-text">{m.label}</span>
                  <span className="block text-[9px] text-text-4">{m.tag}</span>
                </button>
              ))
            )}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** 卡片级出图模型/档位 chips（open-storyboard-canvas 模型 chip 范式）：
 *  显示本卡生效配置（data.gen 覆盖，缺省跟随项目级 store.imagegen），
 *  点击弹出选择器写回卡上 data.gen——生成本卡图片的所有入口（面板直连/
 *  补资产图/分镜批量）都读同一份覆盖。模型清单来自 agent 实探目录 */
function ImagegenChips({ nodeId }: { nodeId: string }) {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId));
  const project = useCanvasStore((s) => s.imagegen);
  const { models, error, reload } = useImageModels();
  const [open, setOpen] = useState(false);
  const cardGen = saneGen(node?.data.gen);
  const effective = cardGen ?? project;
  const option = findModelOption(effective.model, models);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutside(wrapRef, open, () => setOpen(false));
  const pick = (patch: Partial<ImagegenParams>) => {
    const base = cardGen ?? project;
    const modelId = patch.model ?? base.model;
    const opt = findModelOption(modelId, models);
    const resolution =
      patch.resolution ??
      (opt?.resolutions.includes(base.resolution) ? base.resolution : opt?.default_resolution) ??
      base.resolution;
    // 画幅：显式选择优先；换模型后当前画幅不被支持则回自动（空）
    const aspects = opt?.aspects ?? [];
    const rawAspect =
      patch.aspect !== undefined ? patch.aspect : (base.aspect ?? "").trim();
    const aspect = rawAspect && aspects.includes(rawAspect) ? rawAspect : "";
    useCanvasStore
      .getState()
      .updateNodeData(nodeId, { gen: { model: modelId, resolution, aspect: aspect || undefined } });
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative flex items-center">
      <button
        type="button"
        data-tip={
          cardGen
            ? `本卡覆盖：${effective.model} · ${effective.resolution} · ${effective.aspect || "自动"}（点击修改；可回退跟随项目）`
            : `跟随项目默认：${effective.model} · ${effective.resolution}（点击为本卡指定模型/档位/画幅）`
        } aria-label={
          cardGen
            ? `本卡覆盖：${effective.model} · ${effective.resolution} · ${effective.aspect || "自动"}（点击修改；可回退跟随项目）`
            : `跟随项目默认：${effective.model} · ${effective.resolution}（点击为本卡指定模型/档位/画幅）`
        }
        className={`flex items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-1 text-[11px] transition-colors hover:bg-surface-2 ${
          cardGen ? "text-text" : "text-text-2"
        }`}
        onClick={() => setOpen((v) => !v)}
      >
        {option?.label ?? effective.model} · {effective.resolution} ·{" "}
        {effective.aspect || "自动"}
        <ChevronDown className="h-3 w-3 text-text-4" />
      </button>
      {open ? (
        <div className="absolute bottom-full left-0 z-30 mb-1.5 w-64 rounded-md border border-hairline bg-surface-1 p-2 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-text-4">本卡出图模型</span>
            {cardGen ? (
              <button
                type="button"
                className="text-[10px] text-accent hover:underline"
                onClick={() => {
                  useCanvasStore.getState().updateNodeData(nodeId, { gen: undefined });
                  setOpen(false);
                }}
              >
                回退跟随项目
              </button>
            ) : null}
          </div>
          {error ? (
            <p className="mt-1.5 text-[10px] text-danger">
              {error}
              <button type="button" className="ml-1 underline" onClick={reload}>
                重试
              </button>
            </p>
          ) : models === null ? (
            <p className="mt-1.5 text-[10px] text-text-4">加载模型目录…</p>
          ) : (
            <>
              <div className="mt-1 max-h-44 space-y-0.5 overflow-y-auto">
                {models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`block w-full rounded px-1.5 py-1 text-left transition-colors ${
                      m.id === effective.model
                        ? "bg-accent-dim"
                        : "hover:bg-surface-2"
                    }`}
                    onClick={() => pick({ model: m.id })}
                  >
                    <span className="block text-[11px] text-text">{m.label}</span>
                    <span className="block text-[9px] text-text-4">{m.tag}</span>
                  </button>
                ))}
              </div>
              <div className="mt-1.5 flex items-center gap-1 border-t border-hairline pt-1.5">
                <span className="text-[10px] text-text-4">档位</span>
                {["1K", "2K", "4K"].map((r) => {
                  const supported =
                    findModelOption(effective.model, models)?.resolutions.includes(r) ?? true;
                  return (
                    <button
                      key={r}
                      type="button"
                      disabled={!supported}
                      data-tip={supported ? undefined : "该模型不支持此档"} aria-label={supported ? undefined : "该模型不支持此档"}
                      className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                        effective.resolution === r
                          ? "border-accent bg-accent-dim text-text"
                          : supported
                            ? "border-hairline text-text-3 hover:text-text"
                            : "cursor-not-allowed border-hairline text-text-4 opacity-40"
                      }`}
                      onClick={() => pick({ resolution: r })}
                    >
                      {r}
                    </button>
                  );
                })}
              </div>
              {/* 画幅（竞品通行的方框预览宫格）：空=自动——带参考图跟随首位
                  参考图比例（吸附模型支持档），无参考图按资产类型默认幅面 */}
              {(option?.aspects?.length ?? 0) > 0 ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-hairline pt-1.5">
                  <span className="mr-0.5 text-[10px] text-text-4">画幅</span>
                  <button
                    type="button"
                    data-tip="自动：有参考图跟随首位参考图比例，无参考图按类型默认幅面" aria-label="自动画幅"
                    className={`flex flex-col items-center gap-0.5 rounded px-1 py-0.5 transition-colors ${
                      !effective.aspect ? "bg-accent-dim text-text" : "text-text-3 hover:bg-surface-2 hover:text-text"
                    }`}
                    onClick={() => pick({ aspect: "" })}
                  >
                    <span className="block h-3 w-3 rounded-[2px] border border-dashed border-current opacity-80" />
                    <span className="text-[8px] leading-none">自动</span>
                  </button>
                  {(option?.aspects ?? []).map((a) => {
                    const [aw, ah] = a.split(":").map(Number);
                    const h = Math.min(
                      14,
                      Math.max(5, Math.round((18 * (ah || 1)) / (aw || 1))),
                    );
                    const w = Math.round((h * (aw || 1)) / (ah || 1));
                    return (
                      <button
                        key={a}
                        type="button"
                        data-tip={`画幅 ${a}`} aria-label={`画幅 ${a}`}
                        className={`flex flex-col items-center gap-0.5 rounded px-1 py-0.5 transition-colors ${
                          effective.aspect === a
                            ? "bg-accent-dim text-text"
                            : "text-text-3 hover:bg-surface-2 hover:text-text"
                        }`}
                        onClick={() => pick({ aspect: a })}
                      >
                        <span
                          className="block rounded-[2px] border border-current opacity-80"
                          style={{ width: w, height: h }}
                        />
                        <span className="text-[8px] leading-none">{a}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
