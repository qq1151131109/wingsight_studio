"use client";

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Handle,
  NodeResizer,
  NodeToolbar,
  Position,
  useReactFlow,
  useViewport,
  type NodeProps,
} from "@xyflow/react";
import {
  BookOpen,
  Brush,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Columns3,
  Combine,
  Copy,
  Crop,
  Download,
  Drama,
  Film,
  GripVertical,
  Scaling,
  Sparkles,
  Sun,
  Grid3X3,
  History,
  Image as ImageIcon,
  ImagePlus,
  ImageUp,
  Info,
  Landmark,
  Lock,
  LockOpen,
  Loader2,
  Maximize2,
  Music,
  Package,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Search,
  Shirt,
  Trash2,
  Undo2,
  Upload,
  Wand2,
  X,
  ZoomIn,
} from "lucide-react";
import {
  NODE_FOOTPRINT,
  NODE_META,
  SHOT_SIZES,
  absolutePosition,
  findFreePosition,
  nodeSize,
  useCanvasStore,
  type NodeDataUpdateOpts,
  type ShotRow,
  type WingNode,
  type WingNodeData,
  type WingNodeType,
} from "@/lib/canvas/store";
import { TYPE_ICONS } from "@/lib/canvas/type-icons";
import { assetThumbUrl } from "@/lib/asset-thumb";
import { rewriteText } from "@/lib/textwrite";
import {
  RESEARCH_DEPTH_LABEL,
  RESEARCH_STAGE_LABEL,
  RESEARCH_STATUS_LABEL,
  type ResearchJob,
  getResearch,
  startResearch,
} from "@/lib/research";
import ResearchReader from "./ResearchReader";
import {
  ASSET_TYPES,
  isLookCard,
  preferLookRefs,
  resolveRowRefIds,
} from "@/lib/canvas/shotRefs";
import { findModelOption, saneGen, useImageModels } from "@/lib/imagegen";
import { copyImageToClipboard, downloadMedia } from "@/lib/download";
import { downloadBlobFile, mergeImagesToGrid } from "@/lib/canvas/gridMerge";
import { showToast } from "@/lib/toast";
import { reportError } from "@/lib/error-dialog";
import {
  dispatchFocusEdit,
  FOCUS_EDIT_EVENT,
  FOCUS_NODES_EVENT,
  FRAME_ANALYSIS_EVENT,
  IMAGE_TOOL_EVENT,
  NODE_INFO_EVENT,
  OPEN_STYLE_EVENT,
  type FocusEditDetail,
  type ImageToolDetail,
  type NodeInfoDetail,
} from "@/lib/canvas/events";
import { toggleFreeResize } from "@/lib/canvas/imageTools";
import {
  GENERATE_EVENT,
  SUPPLEMENT_CANDIDATES_EVENT,
  type GenerateDetail,
} from "./PromptBar";
import { CONTEXT_BODY_LIMIT } from "@/lib/canvas/refSequence";
import {
  exportDocxFile,
  exportTextFile,
  shotlistToDocxBlocks,
  shotlistToMarkdown,
  shotlistToText,
  textToDocxBlocks,
  type ExportFormat,
} from "@/lib/canvas/exportDoc";
import {
  autoAdoptKeyOnce,
  autoAdoptTopRecommendations,
} from "@/lib/canvas/refAdopt";
import { Lightbox } from "./Lightbox";
import { createPortal } from "react-dom";
import OverlayModal from "./OverlayModal";
import { composeVideos, uploadAsset } from "@/lib/projects";
import {
  decomposeAssets,
  generateShotlist,
  getShotImageJob,
  pollShotImageJob,
  startCharacterImageJob,
  startShotImageJob,
  type DecomposedLook,
  type ExistingAsset,
  type ShotImageRequest,
  type ShotImageResult,
} from "@/lib/shotlist";
import { useDismissOnOutside } from "@/lib/useDismiss";
import VersionHistoryModal from "./NodeMediaHistory";
import MaskEditDialog from "./MaskEditDialog";
import RefResearchDialog from "./RefResearchDialog";
import RefReviewDialog from "./RefReviewDialog";
import ScriptReviewDialog from "./ScriptReviewDialog";
import { getLatestScriptReviewCached, getScriptReview, type ReviewJob } from "@/lib/script-review";
import {
  startBatchRefResearch,
  getBatchRefResearchJob,
  type BatchRefJob,
} from "@/lib/ref-research";
import { useRefStatusStore } from "@/lib/refStatus";

/** 重试生成事件：image 卡 error 态发出，CanvasAgentBridge 监听并转成聊天指令 */
export const RETRY_GENERATION_EVENT = "wingsight:retry-generation";

/** 取消生成事件：image 卡 loading 态的「取消」发出，桥接层调 agent DELETE
 *  并把卡片回原态（未开跑镜头跳过、在途中止请求） */
export const CANCEL_GENERATION_EVENT = "wingsight:cancel-generation";

/** 候选补出事件：候选有失败张数时行图卡「补出 N 张」发出，桥接层沿用
 *  原入参快照（genShot）补跑失败张数，成功结果追加进候选 */


/** 从一张卡右侧建下游卡并自动连线（AIGCCanvasFlow 的 hover "+" 模式）。
 *  锚点 = 源卡实际宽度 + 80、顶对齐（竞品用实际尺寸，默认表会在拉大卡上
 *  叠卡）；被占则 findFreePosition 向下找空位，连点加号自然纵向级联。
 *  返回新节点 id 供调用方追加动作 */
function createConnectedNode(sourceId: string, type: WingNodeType) {
  const st = useCanvasStore.getState();
  const src = st.nodes.find((n) => n.id === sourceId);
  if (!src) return null;
  const abs = absolutePosition(st.nodes, src);
  const fp = NODE_FOOTPRINT[type] ?? NODE_FOOTPRINT.note;
  const pos = findFreePosition(
    st.nodes,
    { x: abs.x + nodeSize(src).w + 80, y: abs.y },
    { w: fp.w, h: fp.h },
  );
  const id = st.addNode({
    position: pos,
    // 标题留空（占位符引导输入）：hint 文案当真名会污染资产名单/@引用/全名匹配
    data: { nodeType: type, title: "", body: "" },
  });
  st.connect({ source: sourceId, target: id });
  useCanvasStore.getState().selectNodes([id]);
  window.dispatchEvent(
    new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: [id] } }),
  );
  dispatchFocusEdit(id);
  return id;
}

/** 从一张卡左侧建上游卡并自动连线（新卡 → 本卡），找空位规则同下游 */
function createUpstreamNode(targetId: string, type: WingNodeType) {
  const st = useCanvasStore.getState();
  const tgt = st.nodes.find((n) => n.id === targetId);
  if (!tgt) return;
  const abs = absolutePosition(st.nodes, tgt);
  const fp = NODE_FOOTPRINT[type] ?? NODE_FOOTPRINT.note;
  const pos = findFreePosition(
    st.nodes,
    { x: abs.x - 80 - fp.w, y: abs.y },
    { w: fp.w, h: fp.h },
  );
  const id = st.addNode({
    position: pos,
    data: { nodeType: type, title: "", body: "" },
  });
  st.connect({ source: id, target: targetId });
  useCanvasStore.getState().selectNodes([id]);
  window.dispatchEvent(
    new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: [id] } }),
  );
  dispatchFocusEdit(id);
}

/** 加号手柄菜单：与 NODE_TYPE_ITEMS 同序（对标 libtv 建卡菜单） */
const PLUS_MENU_TYPES: WingNodeType[] = [
  "note",
  "image",
  "video",
  "compose",
  "audio",
  "script",
  "character",
  "scene",
  "prop",
  "costume",
  "storyboard",
  "shotlist",
];

/** 拖拽媒体=设为生成引用（NodeInputPanel/PromptBar 接收，见 ADD_REF_EVENT） */
export function mediaDragProps(nodeId: string) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(
        "application/x-ws-node-ref",
        JSON.stringify({ nodeId }),
      );
      e.dataTransfer.effectAllowed = "copy";
    },
  };
}

/** 节点信息弹窗（对标 novanova 的 info/JSON 双视图）：id 复制、媒体溯源、原始数据。
 *  挂载入口在画布右键菜单（CanvasView） */
export function NodeInfoModal({
  node,
  onClose,
}: {
  node: WingNode;
  onClose: () => void;
}) {
  const d = node.data;
  const copy = (t: string) =>
    void navigator.clipboard?.writeText(t).catch(() => undefined);
  const media = [
    ["图片", d.imageUrl],
    ["候选图", d.imageUrls?.length ? `${d.imageUrls.length} 张` : null],
    ["视频", d.videoUrl],
    ["音频", d.audioUrl],
  ].filter(([, v]) => Boolean(v)) as [string, string][];
  const refs = Array.isArray(d.refIds) ? (d.refIds as string[]) : [];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="nowheel flex max-h-[70vh] w-full max-w-md flex-col gap-2.5 overflow-y-auto rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-text">节点信息</h3>
        <div className="flex items-center justify-between rounded-md border border-hairline bg-surface-2 px-2 py-1.5 text-xs">
          <span className="text-text-3">
            ID <code className="text-text">{node.id}</code>
          </span>
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => copy(node.id)}
          >
            复制
          </button>
        </div>
        <div className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1.5 text-xs">
          <span className="text-text-4">类型</span>
          <span className="text-text">{NODE_META[d.nodeType].label}</span>
          <span className="text-text-4">标题</span>
          <span className="truncate text-text">{d.title || "（无标题）"}</span>
          <span className="text-text-4">正文</span>
          <span className="text-text">{(d.body ?? "").length} 字</span>
          {media.map(([label, v]) => (
            <Fragment key={label}>
              <span className="text-text-4">{label}</span>
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate text-text">{v}</span>
                <button
                  type="button"
                  className="shrink-0 text-accent hover:underline"
                  onClick={() => copy(v)}
                >
                  复制
                </button>
              </span>
            </Fragment>
          ))}
          {refs.length > 0 ? (
            <>
              <span className="text-text-4">引用</span>
              <span className="text-text">{refs.length} 张卡</span>
            </>
          ) : null}
        </div>
        <details className="rounded-md border border-hairline bg-surface-2 p-2 text-xs">
          <summary className="cursor-pointer text-text-3">原始数据 (JSON)</summary>
          <pre className="nowheel mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed text-text-3">
            {JSON.stringify({ ...d }, null, 2).slice(0, 2500)}
          </pre>
        </details>
      </div>
    </div>
  );
}

/** 图片操作事件派发（顶部工具条/右键菜单两入口同源，弹窗侧统一接） */
function dispatchImageTool(nodeId: string, tool: ImageToolDetail["tool"]) {
  window.dispatchEvent(
    new CustomEvent<ImageToolDetail>(IMAGE_TOOL_EVENT, {
      detail: { nodeId, tool },
    }),
  );
}

/** 双击聚焦（open-ai-canvas focusCanvasImageNode 范式）：视口平滑居中到
 *  该卡，缩放钳制 0.78–1.25（跟当前档位走，不猛跳） */
function focusCardView(
  rf: { fitView: (o: Record<string, unknown>) => Promise<boolean> | void },
  id: string,
) {
  void rf.fitView({
    nodes: [{ id }],
    duration: 420,
    minZoom: 0.78,
    maxZoom: 1.25,
    padding: 0.3,
  });
}

/** 悬浮工具条按钮（选中节点上方浮现的常用操作，libtv 范式；
 *  图片操作组在此条上直发 IMAGE_TOOL_EVENT——竞品共识：重动作入口
 *  挂选中卡上方工具条，右键只是备份路径） */
function ToolBtn({
  title,
  danger,
  disabled,
  active,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  disabled?: boolean;
  /** 开启态（如自由缩放已解锁） */
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-tip={title} aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={`grid h-6 w-6 place-items-center rounded-md transition-colors hover:bg-surface-2 disabled:opacity-40 ${
        danger
          ? "text-text-3 hover:bg-danger/10 hover:text-danger"
          : active
            ? "bg-accent-dim text-accent"
            : "text-text-3 hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

/** 深缩放 LOD 三档（对标 Figma / open-ai-canvas 的缩放分层）：
 *  full ≥0.25 完整卡；micro <0.25 只留 标题+媒体+生成态（chrome 真不渲染，
 *  fiber/DOM 数随档位直落——拉远看全图后的平移流畅度与离开画布的卸载成本都吃这个）；
 *  nano <0.08 连媒体也不挂（类型色块兜底，保画布结构可辨）。
 *  选择器返回字符串只有跨阈值才重渲；viewport 在手势结束才写 store，
 *  缩放过程中零重渲。E2E 最低 zoom 0.5，阈值留足余量 */
type Lod = "full" | "micro" | "nano";
const LOD_MICRO_ZOOM = 0.25;
const LOD_NANO_ZOOM = 0.08;

function useLod(): Lod {
  return useCanvasStore((s) =>
    s.viewport.zoom < LOD_NANO_ZOOM
      ? "nano"
      : s.viewport.zoom < LOD_MICRO_ZOOM
        ? "micro"
        : "full",
  );
}

/**
 * 批量调研任务续链：refBatchJobId 锚在卡数据上——分镜表/剧本卡被
 * onlyRenderVisibleElements 卸载（平移/缩放移出视口即卸）或刷新页面后重挂载，
 * 凭它续轮询、终态照样弹审阅面板（完事即清锚）。卸载即停轮询，重挂载自动续上
 * （任务本体在 agent 内存里继续跑）；agent 重启丢任务表（404）→ 明报并清锚不悬挂。
 */
function useBatchRefJob(nodeId: string) {
  const batchId = useCanvasStore(
    (s) => s.nodes.find((n) => n.id === nodeId)?.data.refBatchJobId,
  );
  const [state, setState] = useState<{
    batchId: string;
    job: BatchRefJob | null;
    error: string;
  }>({ batchId: "", job: null, error: "" });
  useEffect(() => {
    if (!batchId) return;
    let alive = true;
    void (async () => {
      const projectId = useCanvasStore.getState().projectId;
      if (!projectId) return;
      // 连续查询失败容忍 5 次（网络抖动不丢锚）；404（任务不存在，agent 已重启）立即终态
      let misses = 0;
      for (;;) {
        try {
          const j = await getBatchRefResearchJob(projectId, batchId);
          if (!alive) return;
          setState({ batchId, job: j, error: "" });
          // 同步到资产卡状态总线：进行中的资产亮「调研中」
          useRefStatusStore
            .getState()
            .setRunning(
              batchId,
              j.items.filter((it) => it.status === "running").map((it) => it.nodeId),
            );
          // 考据简报落卡：条目完成即写 data.researchBrief（幂等：相同内容不重写；
          // 与采纳解耦——不采纳参考图，考据也供「AI 写设定」与出图设定使用）
          const st = useCanvasStore.getState();
          for (const it of j.items) {
            if (it.status !== "done" || !it.brief) continue;
            const cur = st.nodes.find((n) => n.id === it.nodeId)?.data
              .researchBrief;
            if (cur !== it.brief) {
              st.updateNodeData(it.nodeId, { researchBrief: it.brief });
            }
          }
          // 调研完成自动采纳：推荐候选补齐到 3 张建卡连线（模块级去重，
          // ScriptCard 与各资产卡同轮询不重复建卡）
          for (const it of j.items) {
            if (it.status !== "done") continue;
            if (autoAdoptKeyOnce(projectId, batchId, it.nodeId)) {
              void autoAdoptTopRecommendations(projectId, it.nodeId);
            }
          }
          if (j.status !== "running") {
            useRefStatusStore.getState().clearRunning(batchId);
            // 候选落库了：强制刷新汇总，资产卡亮「N 张候选待选」
            void useRefStatusStore.getState().refresh(projectId, { force: true });
            return;
          }
          misses = 0;
        } catch (exc) {
          misses += 1;
          if (!alive) return;
          const msg = exc instanceof Error ? exc.message : "批量调研查询失败";
          if (msg.includes("不存在") || misses >= 5) {
            useRefStatusStore.getState().clearRunning(batchId);
            setState({ batchId, job: null, error: msg });
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
        if (!alive) return;
      }
    })();
    return () => {
      alive = false;
    };
  }, [batchId, nodeId]);
  // 锚已清/换批后旧结果不外露（防旧终态重复触发面板）
  return state.batchId === batchId && batchId
    ? { batchId, job: state.job, error: state.error, running: state.job?.status === "running" }
    : { batchId: undefined, job: null, error: "", running: false };
}

/**
 * 剧本审查任务续链：reviewJobId 锚在卡数据上（useBatchRefJob 同式，无状态总线）。
 * 移出视口卸载/刷新后凭锚续轮询；终态由 ScriptCard 清锚并弹审查弹窗。
 */
function useScriptReviewJob(nodeId: string) {
  const reviewJobId = useCanvasStore(
    (s) => s.nodes.find((n) => n.id === nodeId)?.data.reviewJobId,
  );
  const [state, setState] = useState<{
    jobId: string;
    job: ReviewJob | null;
    error: string;
  }>({ jobId: "", job: null, error: "" });
  useEffect(() => {
    if (!reviewJobId) return;
    let alive = true;
    void (async () => {
      const projectId = useCanvasStore.getState().projectId;
      if (!projectId) return;
      // 容忍 5 次网络抖动；404（任务不存在，agent 已重启）立即明报终态
      let misses = 0;
      for (;;) {
        try {
          const j = await getScriptReview(projectId, reviewJobId);
          if (!alive) return;
          setState({ jobId: reviewJobId, job: j, error: "" });
          if (j.status !== "queued" && j.status !== "running") return;
          misses = 0;
        } catch (exc) {
          misses += 1;
          if (!alive) return;
          const msg = exc instanceof Error ? exc.message : "审查任务查询失败";
          if (msg.includes("不存在") || misses >= 5) {
            setState({ jobId: reviewJobId, job: null, error: msg });
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 2500));
        if (!alive) return;
      }
    })();
    return () => {
      alive = false;
    };
  }, [reviewJobId, nodeId]);
  // 锚已清后旧结果不外露（防旧终态重复触发面板）
  return reviewJobId && state.jobId === reviewJobId
    ? {
        jobId: reviewJobId,
        job: state.job,
        error: state.error,
        running:
          state.job?.status === "running" ||
          state.job?.status === "queued" ||
          (!state.job && !state.error),
      }
    : { jobId: undefined, job: null as ReviewJob | null, error: "", running: false };
}

/** nano 档媒体兜底：类型色着色块（构图/规模可辨，图片解码缓存随卡释放） */
function NanoBlock({ nodeType }: { nodeType: string }) {
  const dot =
    NODE_META[nodeType as keyof typeof NODE_META]?.dot ?? "var(--color-hairline)";
  return (
    <div
      className="h-full w-full rounded"
      style={{ background: `color-mix(in oklab, ${dot} 26%, var(--color-surface-2))` }}
    />
  );
}

function CardShell({
  id,
  data,
  selected,
  aspect,
  children,
}: {
  id: string;
  data: WingNodeData;
  selected: boolean;
  /** 就绪的图片/视频锁定宽高比缩放 */
  aspect?: boolean;
  children: React.ReactNode;
}) {
  const [plusMenu, setPlusMenu] = useState<null | "left" | "right">(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 磁性追踪（libtv/Flora 手感）：手柄朝光标方向偏移（限幅 12px）+ 按距离放大
  const [magnet, setMagnet] = useState({
    left: { p: 0, sx: 0, sy: 0 },
    right: { p: 0, sx: 0, sy: 0 },
  });
  // 手柄"加号"的点击 vs 拖拽连线区分：位移 <4px 视为干净点击，弹建卡菜单
  const handleDown = useRef<{ x: number; y: number } | null>(null);
  // agent 建卡后的瞬时高亮（选择器返回布尔，未命中的卡不重渲）
  const flashing = useCanvasStore((s) => s.flashIds.includes(id));
  // 资产卡命名引导：FOCUS_EDIT 通道打开标题编辑并聚焦（手动建卡/素材库
  // 建为资产后命令"先起名"——空名资产不进名单/候选，占位名会污染引用）
  const isAsset = ASSET_TYPES.includes(String(data.nodeType));
  // 顶部工具条防出屏：xyflow 工具条定位是纯算术（无贴边防裁剪），卡片停在
  // 视口顶部时整条被渲染到屏外（"点卡片看不到入口"事故）。选中且视口变化
  // 后量一次卡片屏幕位置，offset 钳制让工具条顶边不小于屏幕 8px——贴顶时
  // 压在标题行上也不翻到卡下（卡下会被 PromptBar 盖住，画布层压不过它）。
  // 视口用 xyflow 的 useViewport（与 DOM transform 同 commit 更新）+ 双
  // rAF 确保量到的是新位置（单 rAF 会量到旧 transform，钳制反方向出错）
  const rfViewport = useViewport();
  const [tbOffset, setTbOffset] = useState(36);
  useEffect(() => {
    if (!selected) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = rootRef.current;
        if (!el) return;
        setTbOffset(Math.min(36, el.getBoundingClientRect().top - 38));
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [selected, rfViewport]);
  const [titleForce, setTitleForce] = useState(false);
  useEffect(() => {
    if (!isAsset) return;
    const onFocus = (e: Event) => {
      if ((e as CustomEvent<FocusEditDetail>).detail?.nodeId === id)
        setTitleForce(true);
    };
    window.addEventListener(FOCUS_EDIT_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_EDIT_EVENT, onFocus);
  }, [id, isAsset]);
  // LOD：低缩放时只留标题（布尔选择器，只有跨阈值才触发重渲）
  const tiny = useCanvasStore((s) => s.viewport.zoom < 0.5);
  const lod = useLod();
  // @引用光环：被选中生成卡引用时点亮
  const halo = useCanvasStore((s) => s.haloIds.includes(id));
  const meta = NODE_META[data.nodeType];
  const TypeIcon = TYPE_ICONS[data.nodeType];
  const update = makeUpdater(id);

  // 成功徽章：loading→ready 翻转时闪现 2.4s 自动淡出（对标 open-ai-canvas）
  const [justReady, setJustReady] = useState(false);
  const prevStatus = useRef(data.status);
  useEffect(() => {
    if (prevStatus.current === "loading" && data.status === "ready") {
      setJustReady(true);
      const t = setTimeout(() => setJustReady(false), 2400);
      prevStatus.current = data.status;
      return () => clearTimeout(t);
    }
    prevStatus.current = data.status;
  }, [data.status]);

  const locked = Boolean(data.locked);

  const onRootMouseMove = (e: React.MouseEvent) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 手柄锚点：垂直在卡体中部（根高一半 + 标题行偏移 12px），水平在左右边缘
    const cy = rect.top + rect.height / 2;
    const probe = (
      ax: number,
      ay: number,
    ): { p: number; sx: number; sy: number } => {
      const dx = e.clientX - ax;
      const dy = e.clientY - ay;
      const d = Math.hypot(dx, dy) || 1;
      const p = Math.max(0, Math.min(1, 1 - d / 150));
      // 朝光标方向偏移（限幅 12px），到手边时归位
      const shift = 12 * p;
      return { p, sx: (dx / d) * shift, sy: (dy / d) * shift };
    };
    setMagnet({
      left: probe(rect.left, cy),
      right: probe(rect.right, cy),
    });
  };

  const handleStyle = (side: "left" | "right"): React.CSSProperties => {
    const { p, sx, sy } = magnet[side];
    // 只作用于 .ws-plus 视觉浮层；连线锚点（Handle）是静态定位，绝不参与
    // 动效——xyflow 按 getBoundingClientRect 快照锚点位置画连线端点
    return {
      transform:
        side === "left"
          ? `translate(calc(-100% - 6px + ${sx}px), calc(-50% + ${sy}px)) scale(${1 + 0.4 * p})`
          : `translate(calc(100% + 6px + ${sx}px), calc(-50% + ${sy}px)) scale(${1 + 0.4 * p})`,
      // 光标越近光圈越大（磁性吸附的视觉反馈）
      boxShadow:
        p > 0.5
          ? `0 0 0 ${Math.round(p * 6)}px var(--color-accent-dim)`
          : "0 1px 2px oklch(0 0 0 / 0.12)",
      transition:
        "transform 160ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 160ms ease-out, opacity 120ms",
    };
  };

  const onHandlePointerDown = (e: React.PointerEvent) => {
    handleDown.current = { x: e.clientX, y: e.clientY };
  };
  const onHandlePointerUp = (side: "left" | "right") => (e: React.PointerEvent) => {
    const down = handleDown.current;
    handleDown.current = null;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) {
      setPlusMenu((cur) => (cur === side ? null : side));
    }
  };

  const menu = (side: "left" | "right") =>
    plusMenu === side ? (
      <div
        className={`absolute top-1/2 z-20 flex w-24 -translate-y-1/2 flex-col rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg ${
          side === "right" ? "left-full ml-3" : "right-full mr-3"
        }`}
      >
        <p className="px-2 py-0.5 text-[10px] text-text-4">
          {side === "right" ? "建下游卡" : "建上游卡"}
        </p>
        {PLUS_MENU_TYPES.map((t) => {
          const Icon = TYPE_ICONS[t];
          return (
            <button
              key={t}
              type="button"
              className="nodrag nowheel flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
              onClick={(e) => {
                e.stopPropagation();
                setPlusMenu(null);
                if (side === "right") createConnectedNode(id, t);
                else createUpstreamNode(id, t);
              }}
            >
              {Icon ? <Icon className="h-3 w-3" /> : null}
              {NODE_META[t].label}
            </button>
          );
        })}
      </div>
    ) : null;

  return (
    <div
      ref={rootRef}
      className={`ws-node group ${selected ? "is-selected" : ""} ${tiny ? "is-tiny" : ""}`}
      onMouseMove={onRootMouseMove}
      onMouseLeave={() => {
        setMagnet({
          left: { p: 0, sx: 0, sy: 0 },
          right: { p: 0, sx: 0, sy: 0 },
        });
        setPlusMenu(null);
      }}
    >
      {/* 尺寸来自创建时的默认宽度（store.withDefaultWidth），用户可拖角缩放 */}
      <NodeResizer
        isVisible={selected}
        minWidth={200}
        minHeight={140}
        keepAspectRatio={aspect && !data.freeResize}
        handleClassName="ws-resize-handle"
        lineClassName="ws-resize-line"
      />
      {/* 悬浮工具条（libtv 范式）：选中即在卡上方浮现常用操作。
          不做 tiny（缩放）隐藏——工具条是屏幕空间固定尺寸，任意缩放都
          可读（zoom<0.5 时藏掉曾让用户"看不到入口"，竞品也是全档显示）。
          offset 36：越过卡外标题行，不压住标题 */}
      <NodeToolbar isVisible={selected} position={Position.Top} offset={tbOffset}>
        <div className="flex items-center gap-0.5 rounded-lg border border-hairline bg-surface-1 p-0.5 shadow-md">
          {(isAsset || data.nodeType === "image") && data.imageUrl ? (
            <>
              <ToolBtn
                title="裁剪…"
                disabled={data.status === "loading"}
                onClick={() => dispatchImageTool(id, "crop")}
              >
                <Crop className="h-3.5 w-3.5" />
              </ToolBtn>
              <ToolBtn
                title="多视角…"
                disabled={data.status === "loading"}
                onClick={() => dispatchImageTool(id, "multiview")}
              >
                <Camera className="h-3.5 w-3.5" />
              </ToolBtn>
              {data.nodeType === "character" ? (
                <ToolBtn
                  title="三视图…"
                  disabled={data.status === "loading"}
                  onClick={() => dispatchImageTool(id, "turnaround")}
                >
                  <Columns3 className="h-3.5 w-3.5" />
                </ToolBtn>
              ) : null}
              <ToolBtn
                title="打光…"
                disabled={data.status === "loading"}
                onClick={() => dispatchImageTool(id, "lighting")}
              >
                <Sun className="h-3.5 w-3.5" />
              </ToolBtn>
              <ToolBtn
                title="人物质感…"
                disabled={data.status === "loading"}
                onClick={() => dispatchImageTool(id, "texture")}
              >
                <Wand2 className="h-3.5 w-3.5" />
              </ToolBtn>
              <ToolBtn
                title={data.freeResize ? "锁定比例（回原图比例）" : "自由缩放"}
                active={Boolean(data.freeResize)}
                onClick={() => toggleFreeResize(id)}
              >
                <Scaling className="h-3.5 w-3.5" />
              </ToolBtn>
              <span className="mx-0.5 h-3.5 w-px bg-hairline" />
            </>
          ) : null}
          <ToolBtn title="原地复制" onClick={() => useCanvasStore.getState().duplicateSelection()}>
            <Copy className="h-3.5 w-3.5" />
          </ToolBtn>
          <ToolBtn title={locked ? "解锁" : "锁定"} onClick={() => update({ locked: !locked })}>
            {locked ? <LockOpen className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
          </ToolBtn>
          <ToolBtn
            title="节点信息"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent<NodeInfoDetail>(NODE_INFO_EVENT, { detail: { nodeId: id } }),
              )
            }
          >
            <Info className="h-3.5 w-3.5" />
          </ToolBtn>
          <span className="mx-0.5 h-3.5 w-px bg-hairline" />
          <ToolBtn
            title="删除"
            danger
            onClick={() => {
              const st = useCanvasStore.getState();
              st.commitHistory();
              st.deleteNodes([id]);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </ToolBtn>
        </div>
      </NodeToolbar>
      {/* 连线锚点（左右，不可见静态定位，点击弹菜单/拖拽连线）+ 视觉 + 浮层
          （完全悬在卡外，磁性追踪）。二者分离：连线端点=锚点=卡缘，
          浮层怎么动都不影响线 */}
      <Handle
        type="target"
        position={Position.Left}
        onPointerDown={onHandlePointerDown}
        onPointerUp={onHandlePointerUp("left")}
        title="建上游卡 / 拖拽连线"
      />
      <span className="ws-plus left-0" style={handleStyle("left")}>
        <Plus className="h-3 w-3" />
      </span>
      <Handle
        type="source"
        position={Position.Right}
        onPointerDown={onHandlePointerDown}
        onPointerUp={onHandlePointerUp("right")}
        title="建下游卡 / 拖拽连线"
      />
      <span className="ws-plus right-0" style={handleStyle("right")}>
        <Plus className="h-3 w-3" />
      </span>
      {/* 标题行在卡外上方（libtv 范式）：类型图标（按类型着色）+ 可编辑标题 */}
      <div className="mb-1 flex h-5 items-center gap-1.5 px-0.5" title={meta.label}>
        {TypeIcon ? (
          <TypeIcon
            className="h-3.5 w-3.5 shrink-0"
            style={{ color: meta.dot }}
          />
        ) : null}
        {lod !== "full" || locked ? (
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-2">
            {data.title || "（无标题）"}
          </span>
        ) : (
          <Editable
            value={data.title}
            onSave={(title, opts) => {
              update({ title }, opts);
              // 同类同名即时提醒（ai-moive 同名合并的轻量版）：重名会让
              // @引用/资产名单绑定产生歧义（titleToId 后者覆盖前者），提示
              // 定位人工处理，不强制
              const t = title.trim();
              if (!isAsset || !t) return;
              const dup = useCanvasStore
                .getState()
                .nodes.find(
                  (n) =>
                    n.id !== id &&
                    n.data.nodeType === data.nodeType &&
                    (n.data.title as string)?.trim() === t,
                );
              if (
                dup &&
                window.confirm(
                  `画布上已有同名${meta.label}「${t}」——@引用与出图名单会歧义。定位查看已有卡？`,
                )
              ) {
                useCanvasStore.getState().selectNodes([dup.id]);
                window.dispatchEvent(
                  new CustomEvent(FOCUS_NODES_EVENT, {
                    detail: { ids: [dup.id] },
                  }),
                );
              }
            }}
            editingOn={titleForce}
            onEditingEnd={() => setTitleForce(false)}
            placeholder={isAsset ? `输入${meta.label}名` : "（无标题）"}
            className="min-w-0 flex-1 truncate text-xs font-medium text-text-2"
          />
        )}
        {/* 拖到聊天输入框 = @ 引用该卡（novanova 拖拽引用范式）。nodrag 挡住
            xyflow 节点拖动，HTML5 原生拖拽把节点 id 交给 ChatInput 落 chip */}
        <span
          draggable
          className="ws-node-drag nodrag ml-auto shrink-0 cursor-grab rounded p-0.5 text-text-4 opacity-0 transition-opacity hover:text-text group-hover:opacity-100 active:cursor-grabbing"
          data-tip="拖到聊天框引用此卡" aria-label="拖到聊天框引用此卡"
          title={meta.label}
          onDragStart={(e) => {
            e.dataTransfer.setData(
              "application/x-wingsight-node",
              JSON.stringify({ id, title: data.title ?? "" }),
            );
            e.dataTransfer.setData("text/plain", data.title || id);
            e.dataTransfer.effectAllowed = "copy";
          }}
        >
          <GripVertical className="h-3 w-3" />
        </span>
      </div>
      <div
        className={`ws-card relative flex min-h-0 flex-1 flex-col p-3 ${selected ? "selected" : ""} ${flashing ? "ws-flash" : ""} ${halo ? "ws-ref-halo" : ""}`}
      >
        {justReady ? (
          <span className="ws-success-badge absolute left-2 top-2 z-10 grid h-5 w-5 place-items-center rounded-full bg-good text-white shadow">
            <Check className="h-3 w-3" />
          </span>
        ) : null}
        {children}
        {menu("left")}
        {menu("right")}
      </div>
    </div>
  );
}

/** 媒体区右上角的悬停操作簇（各媒体卡统一位置与样式） */
function CornerActions({ children }: { children: React.ReactNode }) {
  return (
    <span className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      {children}
    </span>
  );
}

/** 媒体空态：图标 + 主/副文案 + 点击上传（image/video/audio/character 共用） */
function MediaEmpty({
  icon,
  hint,
  sub,
  onClick,
  busy,
}: {
  icon: React.ReactNode;
  hint: string;
  sub?: string;
  onClick?: () => void;
  busy?: boolean;
}) {
  if (busy) return <span className="text-xs text-text-3">上传中…</span>;
  return (
    <button
      type="button"
      className="nodrag flex flex-col items-center gap-1.5 px-4 text-center text-text-4 transition-colors hover:text-text-3"
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      {icon}
      <span className="text-xs leading-relaxed">
        {hint}
        {sub ? (
          <>
            <br />
            {sub}
          </>
        ) : null}
      </span>
    </button>
  );
}

/** 自定义迷你音频播放器（替代原生 audio 控件，贴合纸面设计系统） */
function AudioPlayer({ src, title }: { src: string; title: string }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const fmt = (t: number) =>
    `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => undefined);
    else a.pause();
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = ref.current;
    if (!a || !Number.isFinite(dur) || dur <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = Math.min(
      Math.max(((e.clientX - r.left) / r.width) * dur, 0),
      dur,
    );
  };
  return (
    <div className="nodrag nowheel flex w-full flex-col gap-1.5">
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-tip={playing ? "暂停" : "播放"} aria-label={playing ? "暂停" : "播放"}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-hairline bg-surface-1 text-text-2 transition-colors hover:border-accent hover:text-text"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          {playing ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="ml-0.5 h-3.5 w-3.5" />
          )}
        </button>
        <div
          title="点击跳转进度"
          className="h-1.5 flex-1 cursor-pointer overflow-hidden rounded-full bg-hairline-soft"
          onClick={(e) => {
            e.stopPropagation();
            seek(e);
          }}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-200"
            style={{ width: dur > 0 ? `${(cur / dur) * 100}%` : 0 }}
          />
        </div>
        <span className="shrink-0 text-[10px] tabular-nums text-text-4">
          {fmt(cur)} / {fmt(Number.isFinite(dur) ? dur : 0)}
        </span>
        <a
          href={src}
          download={downloadName(title, src, "mp3")}
          title="下载音频"
          className="shrink-0 text-text-4 transition-colors hover:text-text"
          onClick={(e) => e.stopPropagation()}
        >
          <Download className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  );
}

/**
 * 就地编辑文本块（nodrag/nowheel 避免触发画布手势），统一用 textarea。
 * **非受控**（defaultValue + 未聚焦守卫回写）：受控 value 撞上 xyflow 内部
 * 节点副本晚一拍的现实，每击都会被 React 强写一次旧值——光标甩文末、IME
 * 组合被毁。聚焦中 DOM 即事实源；外部改值（AI 撰写/版本恢复/撤销）在未聚焦
 * 时由 effect 回写。
 * always（常驻编辑，文本/剧本/角色/分镜各类内容字段）：没有"编辑态"概念，
 * 直接渲染无边框透明 textarea——点击即输入、光标即点即落（浏览器原生行为，
 * 无需偏移映射），每击实时写回 store（novanova 范式，点别处零丢失）。
 * 默认（标题等短字段）：展示态双击进入短暂编辑，失焦/Esc trim 收尾；
 * editingOn 是外部聚焦信号（FOCUS_EDIT_EVENT 通道），常驻卡收到后把光标
 * 移入正文（配合 focusWhenVisible 穿过新节点的 visibility:hidden 测量期）。
 * 代价：textarea 吞 mousedown，拖卡要走标题行/卡缘/留白；打字不进撤销栈。
 * fill：撑满父 flex 容器剩余高度（卡片拉大后正文跟随填充）。
 */
function Editable({
  value,
  onSave,
  className,
  multiline,
  placeholder,
  fill,
  editingOn,
  onEditingEnd,
  always,
}: {
  value: string;
  /** 打字流（onChange）以 {history:"coalesce"} 调用；失焦 commit 默认模式 */
  onSave: (next: string, opts?: NodeDataUpdateOpts) => void;
  className?: string;
  multiline?: boolean;
  placeholder?: string;
  fill?: boolean;
  /** 远程聚焦信号（FOCUS_EDIT 通道）：直接参与 open 渲染条件，命令此块
   *  打开编辑并聚焦（agent 建卡/手动建资产卡的命名引导） */
  editingOn?: boolean;
  /** editingOn 打开的编辑在失焦收尾后回调（宿主复位信号，避免编辑框常开） */
  onEditingEnd?: () => void;
  /** 常驻编辑：不经过展示态，永远是输入框 */
  always?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // 打开状态：常驻卡恒开；双击进 editing；远程信号 editingOn 直接参与渲染
  const open = always || editing || Boolean(editingOn);

  // agent 建卡后的远程聚焦：textarea 由 open 条件渲染，挂载前 ref 为空——
  // focusWhenVisible 的等挂载重试负责把光标落到字上
  useEffect(() => {
    if (!editingOn) return;
    return focusWhenVisible(ref);
  }, [editingOn]);

  // 非受控的守卫回写：外部改值（AI 撰写覆盖/版本恢复/agent 改卡/撤销）只在
  // 未聚焦时同步进 DOM。绝不能用受控 value——xyflow 内部节点副本晚 zustand
  // 一拍，打字时每次击键都会触发一次"旧值回写"（React 强写 .value 抹掉刚打的
  // 字再把光标甩到文末、打断 IME 组合），实测中文打不进、中途改字必跳末尾。
  // 聚焦中 DOM 即事实源，失焦后由 commit 落库
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.value !== value) el.value = value;
  }, [value]);

  const commit = () => {
    setEditing(false);
    if (editingOn) onEditingEnd?.();
    const next = (ref.current?.value ?? "").trim();
    if (next !== value) onSave(next);
  };

  const renderTextarea = (variant: "accent" | "flat") => {
    // 尺寸策略：fill=撑满容器；常驻多行=宽随容器、高随内容（ws-autota，
    // 上限由调用方 max-h 控制）；常驻单行（小字段芯片）=宽高都随内容；
    // 非常驻（标题等）=固定 w-full
    const sizing = fill
      ? "min-h-0 w-full flex-1"
      : always
        ? multiline
          ? "ws-autota w-full"
          : "ws-autota"
        : "w-full";
    return (
      <textarea
        ref={ref}
        // 非受控（见上方 effect 注释）：defaultValue 只管进场首帧，
        // 外部改值走未聚焦守卫回写
        defaultValue={value}
        placeholder={placeholder}
        rows={multiline ? Math.min(10, Math.max(always ? 1 : 3, value.split("\n").length)) : 1}
        onBlur={commit}
        onChange={(e) => {
          // 实时写回（novanova 范式）：每击落 store，编辑中途点别处零丢失。
          // 打字流合并撤销；代价：打字不进撤销栈（与竞品一致，⌘Z 仍可撤手势类操作）
          onSave(e.currentTarget.value, { history: "coalesce" });
        }}
        onClick={variant === "accent" ? (e) => e.stopPropagation() : undefined}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // IME 组合中的 Enter/Esc 是"确认/取消候选"，不是编辑命令
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Escape") {
            // 常驻卡：Esc = 收尾并移出焦点（让位给画布快捷键）
            if (variant === "flat") {
              commit();
              ref.current?.blur();
            } else {
              commit();
            }
          }
          if (e.key === "Enter" && (multiline ? e.ctrlKey || e.metaKey : true)) {
            commit();
          }
        }}
        className={`nodrag nowheel resize-none outline-none ${
          fill || variant === "flat"
            ? // 纸面式：无边框透明底，排版即展示排版，只靠卡片选中描边 + 光标提示
              "border-0 bg-transparent px-0 py-0"
            : "rounded-sm border border-accent bg-surface-2 px-1 py-0.5"
        } ${sizing} ${multiline ? "" : "whitespace-nowrap overflow-hidden"} ${className ?? ""}`}
      />
    );
  };

  // 常驻编辑：永远是输入框
  if (always) return renderTextarea("flat");

  if (!open) {
    return (
      <div
        className={`group relative ${fill ? "flex min-h-0 flex-1 flex-col" : ""}`}
      >
        <div
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          className={`cursor-text rounded-sm hover:bg-accent-dim ${className ?? ""}`}
          title="双击编辑"
        >
          {value ? (
            value
          ) : (
            <span className="italic text-text-4">{placeholder}</span>
          )}
        </div>
      </div>
    );
  }

  return renderTextarea("accent");
}

/** 节点数据更新器（普通函数，非 hook）。opts.history="coalesce"：
 *  连续打字合并撤销（800ms 窗口一次快照，见 store.updateNodeData） */
function makeUpdater(id: string) {
  return (patch: Partial<WingNodeData>, opts?: NodeDataUpdateOpts) =>
    useCanvasStore.getState().updateNodeData(id, patch, opts);
}

/** 聚焦直到真正落位：xyflow 新节点首帧 visibility:hidden（等待测量），
 *  此窗口内 focus() 静默失败；远程信号打开的编辑框还可能晚一帧才挂载
 *  （ref 为 null）。都逐帧重试（上限 20 帧），返回取消函数。 */
function focusWhenVisible(ref: React.RefObject<HTMLElement | null>) {
  let raf = 0;
  let tries = 0;
  const step = () => {
    const el = ref.current;
    if (!el) {
      if (++tries > 20) return;
      raf = requestAnimationFrame(step);
      return;
    }
    el.focus();
    if (document.activeElement === el || ++tries > 20) return;
    raf = requestAnimationFrame(step);
  };
  step();
  return () => cancelAnimationFrame(raf);
}

/** 下载文件名：标题净字 + 从 URL 推断后缀 */
function downloadName(title: string, url: string, fallbackExt: string) {
  const m = url.match(/\.(png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|m4a|ogg|flac|aac)(?:\?|$)/i);
  const ext = m ? m[1].toLowerCase().replace("jpeg", "jpg") : fallbackExt;
  const safe = (title || "").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 40);
  return `${safe || "wingsight"}.${ext}`;
}

/** 导出格式菜单（txt/md/docx）：portal 到 body 以 fixed 定位（卡内 absolute
 *  弹层会被 .ws-card overflow:hidden 裁剪，矮卡里点不到——mention 候选弹层
 *  同款先例）；文本/剧本/分镜表卡共用；埋点只记格式不记内容 */
function ExportMenuButton({
  onExport,
  disabled,
  track,
  bare,
}: {
  onExport: (format: ExportFormat) => void;
  disabled?: boolean;
  track: string;
  /** 无边框样式（文本卡底栏是一排无边框文本钮） */
  bare?: boolean;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLSpanElement | null>(null);
  // 外点关闭：portal 内容不在节点 DOM 里，dismiss 需同时认 弹层+按钮 两个 ref
  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (
        t instanceof Node &&
        (menuRef.current?.contains(t) || openerRef.current?.contains(t))
      )
        return;
      setAnchor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAnchor(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor]);
  const item = (format: ExportFormat, label: string) => (
    <button
      key={format}
      type="button"
      className="flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-[11px] text-text-2 transition-colors hover:bg-surface-2"
      data-track={`${track}.export`}
      data-track-props={`{"format":"${format}"}`}
      onClick={(e) => {
        e.stopPropagation();
        setAnchor(null);
        onExport(format);
      }}
    >
      {label}
      <span className="text-[9px] text-text-4">.{format}</span>
    </button>
  );
  return (
    <>
      <button
        ref={openerRef}
        type="button"
        disabled={disabled}
        data-tip="导出为 txt / md / docx" aria-label="导出文件"
        className={
          bare
            ? "nodrag flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-text-3 transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            : "nodrag flex shrink-0 items-center gap-0.5 rounded border border-hairline px-1.5 py-0.5 text-text-3 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
        }
        onClick={(e) => {
          e.stopPropagation();
          const rect = openerRef.current?.getBoundingClientRect();
          if (rect) setAnchor((cur) => (cur ? null : rect));
        }}
      >
        <Download className="h-3 w-3" />
        导出
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {anchor
        ? createPortal(
            <span
              ref={menuRef}
              className="nodrag nowheel fixed z-50 flex w-32 flex-col rounded-md border border-hairline bg-surface-1 p-1 shadow-lg"
              // 菜单右下角锚在按钮右上角上方：贴按钮向上展开，顶边钳在视口内
              style={{
                left: Math.max(140, anchor.right),
                top: Math.max(8, anchor.top - 6),
                transform: "translate(-100%, -100%)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {item("docx", "Word 文档")}
              {item("md", "Markdown")}
              {item("txt", "纯文本")}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

/** 文本 / 剧本卡：紧凑文本卡 + 就地编辑（标题在卡外头部）。
 *  空卡 = 直接输入框 + AI 撰写输入条（对标 libtv 的"尝试"+输入区）。
 *  文本卡（非剧本）底部带字数徽标 + 「生图/生视频」快捷键（viedeo-workflow
 *  的 prompt 启动器模式）：右侧建媒体卡并连线，正文即提示词直接发起生成 */
function TextCard({
  data,
  id,
  selected,
  editorial,
  footer,
}: {
  data: WingNodeData;
  id: string;
  selected: boolean;
  editorial?: boolean;
  /** 卡底附加操作条（剧本卡的拆解/分镜按钮用），渲染在正文之下 */
  footer?: React.ReactNode;
}) {
  // 远程编辑通道（FOCUS_EDIT_EVENT）：外部命令本卡进入编辑态，取消选中即复位
  const [forceEdit, setForceEdit] = useState(false);
  const [researching, setResearching] = useState(false);
  const lod = useLod();
  useEffect(() => {
    const onFocusEdit = (e: Event) => {
      if ((e as CustomEvent<FocusEditDetail>).detail?.nodeId === id)
        setForceEdit(true);
    };
    window.addEventListener(FOCUS_EDIT_EVENT, onFocusEdit);
    return () => window.removeEventListener(FOCUS_EDIT_EVENT, onFocusEdit);
  }, [id]);
  useEffect(() => {
    if (selected) return;
    // 取消选中即复位远程编辑态（延迟一拍，React Compiler 禁止 effect 内同步 setState）
    const t = setTimeout(() => setForceEdit(false), 0);
    return () => clearTimeout(t);
  }, [selected]);
  // 防御：历史/异常数据缺字段时跳过渲染，不让单个节点拖垮整棵树
  if (!data || typeof data.nodeType !== "string") return null;
  const update = makeUpdater(id);
  const empty = !(data.body ?? "").trim();
  const genFromText = (kind: "image" | "video") => {
    const newId = createConnectedNode(id, kind);
    if (!newId) return;
    window.dispatchEvent(
      new CustomEvent<GenerateDetail>(GENERATE_EVENT, {
        detail: {
          nodeId: newId,
          kind,
          prompt: (data.body ?? "").trim(),
          refIds: [],
        },
      }),
    );
  };
  const genBtn = (kind: "image" | "video", label: string) => {
    const Icon = TYPE_ICONS[kind];
    return (
      <button
        type="button"
        className="nodrag nowheel flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
        data-tip={`以本文为提示词，右侧新建${label}卡并生成`} aria-label={`以本文为提示词，右侧新建${label}卡并生成`}
        onClick={(e) => {
          e.stopPropagation();
          genFromText(kind);
        }}
      >
        {Icon ? <Icon className="h-3 w-3" /> : null}
        {label}
      </button>
    );
  };
  /** 导出：txt/md 正文原样，docx = 标题+正文分段（文本卡与剧本卡同构） */
  const doExport = (format: ExportFormat) => {
    const text = (data.body ?? "").trim();
    if (!text) return;
    const title = (data.title || "").trim() || "文本";
    if (format === "docx") void exportDocxFile(title, textToDocxBlocks(title, text));
    else exportTextFile(title, text, format);
  };
  /** 深度调研：正文作 brief 发起调研，右侧建调研卡连线（卡面轮询任务实况） */
  const researchBtn = () => {
    const st = useCanvasStore.getState();
    const pid = st.projectId;
    if (!pid || researching) return null;
    return (
      <button
        type="button"
        disabled={researching}
        className="nodrag nowheel flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-text-3 transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
        data-tip="以本文为背景发起深度调研，右侧新建调研卡" aria-label="深度调研"
        data-track="script.deep-research"
        onClick={async (e) => {
          e.stopPropagation();
          if (researching) return;
          const src = useCanvasStore.getState().nodes.find((n) => n.id === id);
          const text = (src?.data.body ?? "").trim();
          if (!text) return;
          setResearching(true);
          try {
            const topic =
              (src?.data.title ?? "").trim() || text.replaceAll("\n", " ").slice(0, 30);
            const job = await startResearch(pid, topic, text.slice(0, 600), "standard");
            const nid = createConnectedNode(id, "research");
            if (nid) {
              useCanvasStore.getState().updateNodeData(nid, {
                title: topic,
                researchId: job.jobId,
              });
            }
          } catch (exc) {
            reportError(
              "深度调研发起失败",
              exc instanceof Error ? exc.message : String(exc),
            );
          } finally {
            setResearching(false);
          }
        }}
      >
        {researching ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Search className="h-3 w-3" />
        )}
        调研
      </button>
    );
  };
  return (
    <CardShell id={id} data={data} selected={selected}>
      {lod === "full" ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col">
            <Editable
              value={data.body ?? ""}
              onSave={(body, opts) => update({ body }, opts)}
              multiline
              fill
              always
              editingOn={forceEdit}
              placeholder={
                editorial
                  ? "直接输入剧本…选中后可在下方让 AI 写"
                  : "直接输入内容…选中后可在下方让 AI 写"
              }
              className={`ws-detail min-h-0 flex-1 text-xs leading-relaxed text-text-2 ${
                editorial ? "font-editorial" : ""
              } nowheel`}
            />
          </div>
          {empty ? (
            <p className="ws-detail mt-1.5 text-center text-[10px] text-text-4">
              选中卡片后可在下方输入区让 AI 撰写
            </p>
          ) : !editorial ? (
            <div className="ws-detail mt-1.5 flex items-center gap-1">
              <span className="text-[10px] tabular-nums text-text-4">
                {(data.body ?? "").length} 字
              </span>
              <span className="flex-1" />
              {genBtn("image", "生图")}
              {genBtn("video", "生视频")}
              {researchBtn()}
              <ExportMenuButton onExport={doExport} disabled={empty} track="card" bare />
            </div>
          ) : null}
          {footer}
        </>
      ) : (data.body ?? "").trim() && lod === "micro" ? (
        <p className="line-clamp-8 whitespace-pre-wrap text-[11px] leading-relaxed text-text-3">
          {data.body}
        </p>
      ) : null}
    </CardShell>
  );
}

function NoteCard({ data, id, selected }: NodeProps) {
  return <TextCard data={data as WingNodeData} id={id} selected={selected} />;
}

/** 剧本卡：正文可滚 + 衬线编辑风（承载剧本全文）+ 卡底操作条。
 *  管线起点：拆解资产→组框建在左侧；拆分镜表→右侧建/复用分镜表卡并
 *  自动触发生成（autoGenerate 旗标） */
function ScriptCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const [decomposing, setDecomposing] = useState(false);
  const [decomposeMsg, setDecomposeMsg] = useState("");
  const [fillingAssets, setFillingAssets] = useState(false);
  const [genError, setGenError] = useState("");
  const [researching, setResearching] = useState(false);
  const [researchMsg, setResearchMsg] = useState("");
  const [reviewBatch, setReviewBatch] = useState<BatchRefJob | null>(null);
  // 批量调研续链：锚在卡数据上，移出视口卸载/刷新后恢复进度与终态面板
  const refJob = useBatchRefJob(id);
  // 剧本审查续链：同式（终态清锚自动弹结果弹窗）
  const reviewJob = useScriptReviewJob(id);
  const [showReview, setShowReview] = useState(false);
  const [reviewOpen, setReviewOpen] = useState<number | null>(null);
  /** 卡面角标（审查·N）：该卡最新一次审查的待处理数（缓存 10s，防平移重挂载请求雨） */
  const refreshReviewCount = useCallback((force = false) => {
    const pid = useCanvasStore.getState().projectId;
    if (!pid) return;
    void getLatestScriptReviewCached(pid, id, force)
      .then((s) => setReviewOpen(s?.status === "done" ? s.openCount : null))
      .catch(() => setReviewOpen(null));
  }, [id]);
  useEffect(() => {
    refreshReviewCount();
  }, [refreshReviewCount]);
  // 审查收尾（含跨卸载恢复到的终态）：清锚 + 弹结果 + 刷角标
  useEffect(() => {
    const j = reviewJob.job;
    if (!j || reviewJob.running) return;
    useCanvasStore.getState().updateNodeData(id, { reviewJobId: undefined });
    void (async () => {
      await Promise.resolve();
      refreshReviewCount(true);
      setShowReview(true);
    })();
  }, [reviewJob.job, reviewJob.running, id, refreshReviewCount]);
  // 审查续链查询失败（任务不存在等）：清锚 + 明报
  useEffect(() => {
    if (!reviewJob.error) return;
    useCanvasStore.getState().updateNodeData(id, { reviewJobId: undefined });
    void (async () => {
      await Promise.resolve();
      setResearchMsg(reviewJob.error);
    })();
  }, [reviewJob.error, id]);
  // 调研收尾（含跨卸载恢复到的终态）：清锚 + 弹审阅面板
  useEffect(() => {
    const j = refJob.job;
    if (!j || j.status === "running") return;
    useCanvasStore.getState().updateNodeData(id, { refBatchJobId: undefined });
    void (async () => {
      await Promise.resolve();
      setReviewBatch(j);
    })();
  }, [refJob.job, id]);
  // 续链查询失败（任务不存在等）：清锚 + 明报
  useEffect(() => {
    if (!refJob.error) return;
    useCanvasStore.getState().updateNodeData(id, { refBatchJobId: undefined });
    void (async () => {
      await Promise.resolve();
      setResearchMsg(refJob.error);
    })();
  }, [refJob.error, id]);
  // 防御：异常数据不渲染（hooks 已在上，顺序稳定）
  if (!d || typeof d.nodeType !== "string") return null;
  const body = d.body ?? "";
  const empty = !body.trim();
  // 场数：按「第 X 场/幕」行头粗算（无场标的剧本不显示）
  const sceneCount = (
    body.match(/^\s*第[0-9一二三四五六七八九十百]+[场幕]/gm) ?? []
  ).length;

  // 按钮直读 store：正文 blur 保存可能晚于点击，props 里的 body 会 stale
  const freshBody = () =>
    (
      useCanvasStore.getState().nodes.find((n) => n.id === id)?.data.body ?? ""
    ).trim();

  const missingAssetCount = countAssetsMissingImage(nodes, id);
  const researchCount = researchTargetsOf(nodes, edges, id).length;
  /** 批量调研：圈定本卡资产开跑，任务锚进卡数据（进度/收尾由 refJob 续链） */
  const researchRefs = async () => {
    if (researching || refJob.batchId) return;
    setResearching(true);
    setResearchMsg("");
    try {
      const batchId = await startBatchResearchForCard(id);
      if (!batchId) setResearchMsg("没有需要调研的资产（缺参考的资产为 0）");
    } catch (exc) {
      setResearchMsg(exc instanceof Error ? exc.message : "批量调研失败");
    } finally {
      setResearching(false);
    }
  };
  /** 补资产图：本卡拆解出的缺图资产卡一键批量出图（画风闸内） */
  const fillAssets = async () => {
    if (fillingAssets) return;
    setFillingAssets(true);
    setDecomposeMsg("");
    try {
      const msg = await fillAssetImages(id);
      if (msg) setDecomposeMsg(msg);
    } finally {
      setFillingAssets(false);
    }
  };
  /** 拆解资产：共享实现 runAssetDecompose，锚点=本卡（资产组建在本卡正下方） */
  const decompose = () => {
    if (decomposing) return;
    const scriptSource = freshBody();
    if (!scriptSource) return;
    setDecomposeMsg("");
    setGenError("");
    setDecomposing(true);
    void runAssetDecompose({
      anchorId: id,
      scriptSource,
      model: (d.textModel ?? "").trim() || undefined,
      onMsg: setDecomposeMsg,
      onError: setGenError,
    }).finally(() => setDecomposing(false));
  };

  /** 拆分镜表：找/建本卡下游分镜表卡 → 置 autoGenerate 旗标远程触发生成 */
  const genShotlist = () => {
    if (!freshBody()) return;
    const st = useCanvasStore.getState();
    const tid0 = st.edges.find(
      (e) =>
        e.source === id &&
        st.nodes.find((n) => n.id === e.target)?.data.nodeType === "shotlist",
    )?.target;
    const tid = tid0 ?? createConnectedNode(id, "shotlist");
    if (!tid) return;
    // 本卡选的文本模型一并带过去（分镜表卡可再改）
    useCanvasStore.getState().updateNodeData(tid, {
      autoGenerate: true,
      ...((d.textModel ?? "").trim() ? { textModel: d.textModel } : {}),
    });
    window.dispatchEvent(
      new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: [tid] } }),
    );
  };

  /** 导出：txt/md 正文原样，docx = 标题+正文分段（入口在 footer「导出」菜单） */
  const doExport = (format: ExportFormat) => {
    const text = freshBody();
    if (!text) return;
    const title = (d.title || "").trim() || "剧本";
    if (format === "docx") void exportDocxFile(title, textToDocxBlocks(title, text));
    else exportTextFile(title, text, format);
  };

  return (
    <TextCard
      data={d}
      id={id}
      selected={selected}
      editorial
      footer={
        <>
          <div className="ws-detail nodrag nowheel mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md border border-hairline-soft bg-surface-2/50 px-1.5 py-1 text-[10px] text-text-3">
            <span
              className="whitespace-nowrap tabular-nums text-text-4"
              title={body.slice(0, 120)}
            >
              {body.length} 字
              {sceneCount > 0 ? ` · ${sceneCount} 场` : ""}
            </span>
            <span className="flex-1" />
            <ExportMenuButton onExport={doExport} disabled={empty} track="script" />
            <button
              type="button"
              disabled={empty || decomposing}
              data-tip="用拆解技能从剧本提取角色/场景/道具 → 自动分组建卡在本卡正下方（只建卡不出图）。出分镜图前建议先调研参考图再补资产图，一致性最好" aria-label="用拆解技能从剧本提取角色/场景/道具 → 自动分组建卡在本卡正下方（只建卡不出图）"
              className="nodrag shrink-0 rounded border border-hairline bg-surface-1 px-1.5 py-0.5 text-text-2 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
              data-track="script.decompose"
  onClick={(e) => {
                e.stopPropagation();
                decompose();
              }}
            >
              {decomposing ? "拆解中…" : "拆解资产"}
            </button>
            {researchCount > 0 ? (
              <button
                type="button"
                disabled={empty || researching || !!refJob.batchId}
                data-tip="为缺参考的资产批量搜网络考据图（AI 出词→Google 搜索（Serper 号池）→模型终选），完成后逐资产勾选采纳；真实类题材建议先调研再补图" aria-label="批量调研参考图"
                className="nodrag shrink-0 rounded border border-hairline bg-surface-1 px-1.5 py-0.5 text-text-2 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                data-track="card.batch-research"
  onClick={(e) => {
                  e.stopPropagation();
                  void researchRefs();
                }}
              >
                {researching || refJob.batchId
                  ? refJob.running && refJob.job
                    ? `调研中 ${refJob.job.done}/${refJob.job.total}`
                    : "调研中…"
                  : `调研参考图·${researchCount}`}
              </button>
            ) : null}
            {missingAssetCount > 0 ? (
              <button
                type="button"
                disabled={empty || fillingAssets}
                data-tip="为本卡拆解出的缺设定图资产卡批量出图（自动带上已采纳的参考卡，画风闸内）" aria-label="为本卡拆解出的缺设定图资产卡批量出图"
                className="nodrag shrink-0 rounded border border-hairline bg-surface-1 px-1.5 py-0.5 text-text-2 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                data-track="asset.fill-images"
  onClick={(e) => {
                  e.stopPropagation();
                  void fillAssets();
                }}
              >
                {fillingAssets ? "补图中…" : `补资产图·${missingAssetCount}`}
              </button>
            ) : null}
            <button
              type="button"
              disabled={empty}
              data-tip="AI 审查剧本：合规（敏感内容）/ 一致性（内部矛盾）/ 事实核查（联网取证）→ 问题清单，可定位/忽略/一键改写" aria-label="剧本审查"
              className="nodrag flex shrink-0 items-center gap-0.5 rounded border border-hairline bg-surface-1 px-1.5 py-0.5 text-text-2 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
              onClick={(e) => {
                e.stopPropagation();
                setShowReview(true);
              }}
            >
              {reviewJob.running ? "审查中…" : reviewOpen !== null ? `审查·${reviewOpen}` : "审查"}
            </button>
            <button
              type="button"
              disabled={empty}
              data-tip="在本卡右侧新建分镜表卡并自动生成分镜（已连分镜表则重新生成）" aria-label="在本卡右侧新建分镜表卡并自动生成分镜（已连分镜表则重新生成）"
              className="nodrag flex shrink-0 items-center gap-0.5 rounded border border-accent bg-accent-dim px-2 py-0.5 font-medium text-text transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:border-hairline disabled:bg-surface-2 disabled:text-text-4"
              onClick={(e) => {
                e.stopPropagation();
                genShotlist();
              }}
            >
              <Film className="h-3 w-3" />
              拆分镜表
            </button>
          </div>
          {decomposeMsg ? (
            <p className="ws-detail mt-1 text-[10px] text-text-3">
              {decomposeMsg}
            </p>
          ) : null}
          {researchMsg ? (
            <p className="ws-detail mt-1 text-[10px] text-text-3">
              {researchMsg}
            </p>
          ) : null}
          {genError ? (
            <p className="ws-detail mt-1 text-[10px] text-danger">{genError}</p>
          ) : null}
          {reviewBatch ? (
            <RefReviewDialog
              projectId={useCanvasStore.getState().projectId ?? ""}
              batch={reviewBatch}
              onClose={() => setReviewBatch(null)}
            />
          ) : null}
          {showReview ? (
            <ScriptReviewDialog
              projectId={useCanvasStore.getState().projectId ?? ""}
              nodeId={id}
              jobId={reviewJob.jobId}
              onClose={() => {
                setShowReview(false);
                refreshReviewCount(true);
              }}
            />
          ) : null}
        </>
      }
    />
  );
}

/** 资产卡（character/scene/prop 三态同构）：设定图槽位（上传/AI 出图）+ 设定正文。
 *  设定图是分镜图一致性锚点（ai-moive-studio 的 look-dev 步骤）：
 *  分镜行 @资产名 出图时会把设定图作为参考图传给出图 flow */
const ASSET_ICON = {
  character: Drama,
  scene: Landmark,
  prop: Package,
  costume: Shirt,
} as const;
const ASSET_IMAGE_LABEL = {
  character: "定妆照",
  scene: "概念图",
  prop: "设定图",
  costume: "服饰结构图",
} as const;
const ASSET_EMPTY = {
  character: { hint: "上传定妆照", sub: "角色一致性锚点" },
  scene: { hint: "上传概念图", sub: "场景一致性锚点" },
  prop: { hint: "上传设定图", sub: "道具一致性锚点" },
  costume: { hint: "上传服饰结构图", sub: "服饰一致性锚点" },
} as const;
const ASSET_BODY_PH = {
  character: "外形 / 性格 / 服装 / 说话方式",
  scene: "空间 / 光线 / 氛围 / 陈设",
  prop: "形制 / 材质 / 色彩 / 使用痕迹",
  costume: "形制 / 材质 / 配色 / 工艺",
} as const;
/** 「AI 写设定」的类型模板：与占位符同一套维度（/text/rewrite 指令用） */
const ASSET_WRITE_HINT: Record<keyof typeof ASSET_BODY_PH, string> = {
  character: "外形与年龄感、性格气质、服装造型、说话方式",
  scene: "空间布局、光线时段、氛围基调、陈设细节",
  prop: "形制结构、材质、色彩、使用痕迹",
  costume: "形制、材质、配色、工艺与纹样",
};

/** 资产卡动作条按钮：单行三联（出图/参考ⁿ/撰写），nowrap 防中文竖排 */
const ACT_BTN =
  "nodrag flex min-w-0 flex-1 items-center justify-center gap-0.5 whitespace-nowrap rounded-md border border-hairline px-1 py-1 text-[10px] text-text-2 transition-colors hover:border-accent-soft hover:text-text disabled:cursor-not-allowed disabled:opacity-40";

function AssetCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const rf = useReactFlow();
  const update = makeUpdater(id);
  const projectStyle = useCanvasStore((s) => s.projectStyle);
  const kind = (
    ["character", "scene", "prop", "costume"].includes(d?.nodeType ?? "")
      ? d.nodeType
      : "character"
  ) as keyof typeof ASSET_IMAGE_LABEL;
  const imgLabel = ASSET_IMAGE_LABEL[kind];
  const [uploading, setUploading] = useState(false);
  const [imgJob, setImgJob] = useState(false);
  const [styleHint, setStyleHint] = useState("");
  const [zoom, setZoom] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  // 「AI 写设定」直连管线（/text/rewrite）：空设定直接落正文，已有设定
  // 先预览采用才覆盖（与文本卡撰写同规）
  const [writing, setWriting] = useState(false);
  const [writePreview, setWritePreview] = useState<string | null>(null);
  const [writeMsg, setWriteMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const lod = useLod();
  // 参考图调研状态（状态总线）：批量调研进行中亮「调研中」，有已调研未采纳
  // 的候选亮「N 张待选」徽标（点击进找参考图面板）
  const refRunning = useRefStatusStore((s) =>
    Object.values(s.runningByBatch).some((ids) => ids.includes(id)),
  );
  const refPending = useRefStatusStore((s) => {
    const x = s.byNode[id];
    return x ? x.total - x.adopted : 0;
  });
  useEffect(() => {
    void useRefStatusStore
      .getState()
      .refresh(useCanvasStore.getState().projectId ?? "");
  }, [id]);
  // 防御：异常数据不渲染（hooks 已在上，顺序稳定）
  if (!d || typeof d.nodeType !== "string") return null;
  const versionCount = d.versions?.length ?? 0;
  /** 旧图入版本档案（AI 重出/上传覆盖前调用）：prompt 归因它当时的提示词 */
  const archiveCurrent = () =>
    d.imageUrl
      ? {
          versions: [
            ...(d.versions ?? []),
            {
              url: d.imageUrl,
              at: new Date().toISOString().slice(5, 16).replace("T", " "),
              prompt: String(d.genPrompt ?? "").trim() || undefined,
            },
          ].slice(-12),
        }
      : {};

  /** AI 写设定（novanova 内联编辑 + ai-moive 字段模板的轻量合体）：
   *  按资产类型模板 + 源剧本背景生成设定正文。上下文优先 assetSource
   *  源卡（拆解来源的剧本/分镜表），回落画布第一张剧本卡 */
  const writeSetting = async () => {
    if (writing) return;
    const title = String(d.title ?? "").trim();
    if (!title) {
      setWriteMsg("先给资产起名，AI 才能写设定");
      return;
    }
    setWriting(true);
    setWriteMsg("");
    try {
      const st = useCanvasStore.getState();
      const srcId = typeof d.assetSource === "string" ? d.assetSource : "";
      const src =
        (srcId ? st.nodes.find((n) => n.id === srcId) : undefined) ??
        st.nodes.find((n) => n.data.nodeType === "script");
      const script = String((src?.data.body as string) ?? "").trim();
      const style = st.projectStyle.trim();
      // 考据简报是设定的事实依据（视觉细节/时代特征/常见误用，带来源）：
      // 有就喂给撰写，设定不再纯靠模型记忆猜
      const brief = String(d.researchBrief ?? "").trim();
      const result = await rewriteText({
        instruction: `你是影视美术设定师。为${NODE_META[kind].label}「${title}」写设定，覆盖：${ASSET_WRITE_HINT[kind]}。80 字内白描直给，不要客套与解释。${style ? `全局画风：${style}。` : ""}`,
        body: "",
        context: [
          script ? `剧情背景（节选）：\n${script.slice(0, 600)}` : "",
          brief ? `考据简报（事实依据，与剧情冲突时以剧情为准）：\n${brief.slice(0, CONTEXT_BODY_LIMIT)}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        model: String(d.textModel ?? "").trim() || undefined,
      });
      if (!String(d.body ?? "").trim()) update({ body: result });
      else setWritePreview(result);
    } catch (exc) {
      setWriteMsg(exc instanceof Error ? exc.message : "AI 撰写失败");
    } finally {
      setWriting(false);
    }
  };

  /** AI 出主图（定妆照/概念图/设定图）：一张卡一张图。造型变体不再挂本卡
   *  （拆解自动出图链已物化成独立图片卡并连线），历史 looks 数据装载时迁移 */
  const genLook = async () => {
    if (imgJob) return;
    // 画风闸（juben image_style_required 同款）：设定图是全片一致性锚点，
    // 无画风出图 = 风格随机漂移，拦下并自动弹出画风设定弹窗
    if (!projectStyle.trim()) {
      setStyleHint("未选画风：请在弹出的「项目画风」里设定，再 AI 出图");
      window.dispatchEvent(new CustomEvent(OPEN_STYLE_EVENT));
      return;
    }
    setStyleHint("");
    update({ status: "loading", errorMessage: undefined });
    setImgJob(true);
    try {
      // 卡片级出图覆盖（模型/档位/画幅，面板 chips 写入 data.gen）：
      // 生成本卡图片的入口统一读它；无显式画幅=自动，卡上无参考图，
      // flow 按资产类型默认幅面出图（四格定妆 16:9 / 道具平铺 4:3）
      const cardGen = saneGen(d.gen);
      const jobId = await startCharacterImageJob({
        rid: id,
        name: d.title || "资产",
        description: `${d.title || ""}。${d.body ?? ""}`.trim(),
        // 服饰卡的设定图按道具契约（4:3 单件）出图
        assetType: kind === "costume" ? "prop" : kind,
        visualNotes: projectStyle ? `全局视觉风格：${projectStyle}` : undefined,
        aspect: cardGen?.aspect || undefined,
        params: cardGen ?? undefined,
      });
      const usedStyle = projectStyle;
      const deadline = Date.now() + 5 * 60 * 1000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        let job;
        try {
          job = await getShotImageJob(jobId);
        } catch {
          if (Date.now() > deadline) throw new Error("出图超时");
          continue;
        }
        const item = job.images[0];
        if (item?.ok && item.imageUrl) {
          update({
            imageUrl: item.imageUrl,
            status: "ready",
            styleSnapshot: usedStyle,
            ...archiveCurrent(),
          });
          return;
        }
        if (item?.error) throw new Error(item.error);
        if (job.status === "done" || Date.now() > deadline)
          throw new Error("出图失败");
      }
    } catch (exc) {
      update({
        status: "error",
        errorMessage: exc instanceof Error ? exc.message : "出图失败",
      });
    } finally {
      setImgJob(false);
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || !f.type.startsWith("image/")) return;
    setUploading(true);
    void (async () => {
      try {
        const url = await uploadAsset(f, f.type);
        if (url) update({ imageUrl: url, ...archiveCurrent() });
      } finally {
        setUploading(false);
      }
    })();
  };

  return (
    <CardShell id={id} data={d} selected={selected} aspect={Boolean(d.imageUrl)}>
      <div
        className={`mt-1.5 flex min-h-[120px] w-full flex-1 items-center justify-center overflow-hidden rounded-md border border-hairline-soft bg-surface-2 ${
          d.status === "loading" ? "ws-loading-scan" : ""
        }`}
      >
        {lod === "nano" ? (
          <NanoBlock nodeType={d.nodeType} />
        ) : d.status === "loading" ? (
          <GenProgress nodeId={id} expected={60} />
        ) : d.status === "error" ? (
          <RetryPanel nodeId={id} errorMessage={d.errorMessage} />
        ) : d.imageUrl ? (
          <div
            className="nodrag group relative h-full w-full"
            onDoubleClick={(e) => {
              e.stopPropagation();
              focusCardView(rf, id);
            }}
            title="双击：视口聚焦本卡；右上角 ⌕ 看大图"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={assetThumbUrl(d.imageUrl)}
              alt={d.title}
              className="ws-media-in h-full w-full object-contain"
              {...mediaDragProps(id)}
            />
            {lod === "full" ? (
              <CornerActions>
                <button
                  type="button"
                  data-tip="版本历史（重生成/上传覆盖前的结果自动存档）" aria-label="版本历史（重生成/上传覆盖前的结果自动存档）"
                  className="nodrag flex items-center gap-0.5 rounded-md bg-black/40 p-1 text-[10px] text-white hover:bg-black/60"
                  data-track="card.version-history"
  onClick={(e) => {
                    e.stopPropagation();
                    setHistoryOpen(true);
                  }}
                >
                  <History className="h-3.5 w-3.5" />V{versionCount + 1}
                </button>
                <button
                  type="button"
                  data-tip="AI 重新出设定图（用设定正文）" aria-label="AI 重新出设定图（用设定正文）"
                  className="nodrag rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                  onClick={(e) => {
                    e.stopPropagation();
                    void genLook();
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  data-tip={`更换${imgLabel}`} aria-label={`更换${imgLabel}`}
                  className="nodrag rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                  onClick={(e) => {
                    e.stopPropagation();
                    fileRef.current?.click();
                  }}
                >
                  <Upload className="h-3.5 w-3.5" />
                </button>
                <a
                  href={d.imageUrl}
                  download={downloadName(d.title, d.imageUrl, "png")}
                  title="下载"
                  className="rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Download className="h-3.5 w-3.5" />
                </a>
                <button
                  type="button"
                  data-tip="查看大图（标注重绘/九宫格/版本在此操作）" aria-label="查看大图"
                  className="nodrag rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                  data-track="card.open-lightbox"
                  onClick={(e) => {
                    e.stopPropagation();
                    setZoom(true);
                  }}
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </button>
              </CornerActions>
            ) : null}
          </div>
        ) : (
          <MediaEmpty
            icon={(() => {
              const Icon = ASSET_ICON[kind];
              return <Icon className="h-5 w-5" />;
            })()}
            hint={`上传${imgLabel}`}
            sub={ASSET_EMPTY[kind].sub}
            busy={uploading}
            onClick={() => fileRef.current?.click()}
          />
        )}
      </div>
      {lod === "full" && d.status !== "loading" ? (
        <div className="mt-1.5 flex gap-1">
          <button
            type="button"
            data-tip={refRunning ? "调研中：AI 出词搜图 + 网页考据 + 终选" : "AI 出词搜图 + 网页考据，自动采纳前 3 张为参考图（其余候选点开增补）"} aria-label="调研参考图"
            className={`${ACT_BTN} ${refPending > 0 ? "border-accent-soft bg-accent-dim/60 font-medium text-text" : ""}`}
            data-track="asset.find-refs"
            onClick={(e) => {
              e.stopPropagation();
              setResearchOpen(true);
            }}
          >
            {refRunning ? (
              <Loader2 className="h-3 w-3 shrink-0 motion-safe:animate-spin" />
            ) : (
              <Search className="h-3 w-3" />
            )}
            调研
            {refPending > 0 ? <span className="text-accent">{refPending}</span> : null}
          </button>
          <button
            type="button"
            disabled={writing}
            data-tip="AI 按资产名与剧情背景补全设定（考据简报作事实依据）；已有设定时先预览再采用" aria-label="AI 写设定"
            className={ACT_BTN}
            data-track="asset.write"
            onClick={(e) => {
              e.stopPropagation();
              void writeSetting();
            }}
          >
            {writing ? (
              <Loader2 className="h-3 w-3 shrink-0 motion-safe:animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            {writing ? "撰写中" : "撰写"}
          </button>
          {!d.imageUrl ? (
            <button
              type="button"
              disabled={imgJob}
              data-tip={`按设定正文 AI 出${imgLabel}（直连出图，不经聊天）。需先在底部坞「画风」选项目画风`} aria-label={`按设定正文 AI 出${imgLabel}`}
              className={`${ACT_BTN} border-accent bg-accent-dim font-medium text-text`}
              data-track="asset.gen"
              onClick={(e) => {
                e.stopPropagation();
                void genLook();
              }}
            >
              <Sparkles className="h-3 w-3" />
              {imgJob ? "生成中" : "出图"}
            </button>
          ) : null}
        </div>
      ) : null}
      {lod === "full" && styleHint ? (
        <p className="ws-detail mt-1 text-[10px] text-warn">{styleHint}</p>
      ) : null}
      {lod === "full" ? (
        writePreview ? (
          <div className="ws-detail mt-1.5 rounded border border-accent-soft bg-surface-2 p-1.5">
            <p className="max-h-24 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-text-2">
              {writePreview}
            </p>
            <div className="mt-1 flex gap-1">
              <button
                type="button"
                data-tip="用 AI 生成的设定覆盖当前正文（旧正文进撤销栈可恢复）" aria-label="采用覆盖"
                className="nodrag rounded border border-accent bg-accent-dim px-1.5 py-0.5 text-[10px] font-medium text-text hover:bg-accent-soft"
                data-track="textwrite.apply"
  onClick={(e) => {
                  e.stopPropagation();
                  update({ body: writePreview });
                  setWritePreview(null);
                }}
              >
                采用覆盖
              </button>
              <button
                type="button"
                aria-label="放弃"
                className="nodrag rounded border border-hairline px-1.5 py-0.5 text-[10px] text-text-3 hover:text-text"
                onClick={(e) => {
                  e.stopPropagation();
                  setWritePreview(null);
                }}
              >
                放弃
              </button>
            </div>
          </div>
        ) : (
          <>
            <Editable
              value={d.body ?? ""}
              onSave={(body, opts) => update({ body }, opts)}
              multiline
              always
              placeholder={ASSET_BODY_PH[kind]}
              className="ws-detail mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-text-2"
            />
            {writeMsg ? (
              <p className="ws-detail mt-1 text-[10px] text-danger">{writeMsg}</p>
            ) : null}
          </>
        )
      ) : lod === "micro" && (d.body ?? "").trim() ? (
        <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-[11px] leading-relaxed text-text-3">
          {d.body}
        </p>
      ) : null}
      {zoom && d.imageUrl ? (
        <Lightbox
          images={[{ src: d.imageUrl, title: d.title }]}
          index={0}
          onIndex={() => undefined}
          onClose={() => setZoom(false)}
        />
      ) : null}
      {historyOpen && d.imageUrl ? (
        <VersionHistoryModal nodeId={id} data={d} onClose={() => setHistoryOpen(false)} />
      ) : null}
      {researchOpen ? (
        <RefResearchDialog nodeId={id} onClose={() => setResearchOpen(false)} />
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onFile}
      />
    </CardShell>
  );
}

/**
 * 生成进度（对标 viedeo-workflow 的"诚实进度"）：
 * elapsed/预期时长 推算百分比、封顶 95%（真实完成由 agent 回填 ready），
 * 超过 1.5 倍预期切换为排队提示；超过 5 倍预期落 error（看门狗，防 agent 失联永久转圈）。
 */
function GenProgress({
  nodeId,
  expected,
}: {
  nodeId: string;
  expected: number;
}) {
  const [sec, setSec] = useState(0);
  const flipped = useRef(false);
  // 任务 id 存在才可取消（面板直连出图在任务启动后写入）
  const jobId = useCanvasStore(
    (s) => s.nodes.find((n) => n.id === nodeId)?.data.imageJobId,
  );
  useEffect(() => {
    const t = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!flipped.current && sec > expected * 5) {
      flipped.current = true;
      useCanvasStore.getState().updateNodeData(nodeId, {
        status: "error",
        errorMessage: `等待超时（${sec}s 无响应），可点击重试`,
      });
    }
  }, [sec, expected, nodeId]);
  const pct = Math.min(95, Math.round((sec / expected) * 100));
  const slow = sec > expected * 1.5;
  return (
    <div className="w-full px-4 text-center">
      <div className="h-1 w-full overflow-hidden rounded-full bg-hairline-soft">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-1000 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-text-3">
        {slow ? `排队较久 · 已等 ${sec}s` : `生成中 ${pct}% · ${sec}s`}
        {jobId ? (
          <>
            {" · "}
            <button
              type="button"
              className="underline decoration-dotted underline-offset-2 hover:text-danger"
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(
                  new CustomEvent(CANCEL_GENERATION_EVENT, { detail: { nodeId } }),
                );
              }}
            >
              取消
            </button>
          </>
        ) : null}
      </p>
    </div>
  );
}

/** 图片/视频卡共用的错误态：点击重试 → RETRY_GENERATION_EVENT → 聊天指令 */
function RetryPanel({
  nodeId,
  errorMessage,
}: {
  nodeId: string;
  errorMessage?: string;
}) {
  return (
    <button
      type="button"
      className="nodrag flex flex-col items-center gap-1.5 px-4 text-center text-danger hover:opacity-80"
      onClick={(e) => {
        e.stopPropagation();
        window.dispatchEvent(
          new CustomEvent(RETRY_GENERATION_EVENT, { detail: { nodeId } }),
        );
      }}
    >
      <CircleAlert className="h-5 w-5" />
      <span className="text-xs">生成失败 · 点击重试</span>
      {errorMessage ? (
        <span className="line-clamp-2 text-[10px] text-text-4">
          {errorMessage}
        </span>
      ) : null}
    </button>
  );
}

/** 九宫格切图：3×3 裁块逐个上传，在原图右侧排成网格（对标 open-ai-canvas 切图） */
async function splitImageToGrid(nodeId: string, url: string, title: string) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("load failed"));
    img.src = url;
  });
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return;
  const st0 = useCanvasStore.getState();
  const source = st0.nodes.find((n) => n.id === nodeId);
  if (!source) return;
  const abs = absolutePosition(st0.nodes, source);
  const tileW = Math.max(64, Math.round(w / 3 / 2));
  const tileH = Math.round(tileW * (h / w));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w / 3);
  canvas.height = Math.round(h / 3);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let placed = 0;
  const createdIds: string[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, (w / 3) * c, (h / 3) * r, w / 3, h / 3, 0, 0, w / 3, h / 3);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9),
      );
      if (!blob) continue;
      const tileUrl = await uploadAsset(blob, "image/jpeg", `${title}_r${r}c${c}.jpg`);
      if (!tileUrl) continue;
      const st = useCanvasStore.getState();
      const tid = st.addNode({
        position: {
          x: abs.x + NODE_FOOTPRINT.image.w + 80 + c * (tileW + 16),
          y: abs.y + r * (tileH + 16),
        },
        data: {
          nodeType: "image",
          title: `${title || "图片"} · ${r * 3 + c + 1}/9`,
          body: "",
          imageUrl: tileUrl,
          status: "ready",
        },
      });
      createdIds.push(tid);
      placed += 1;
    }
  }
  if (placed > 0) {
    useCanvasStore.getState().flashNodes(createdIds);
  }
}

/** 图片卡：占位（上传 / 输入条生成）/ loading 进度 / error 重试 / ready（放大 + 重生成 + 候选切换 + 版本历史） */
function ImageCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const rf = useReactFlow();
  const update = makeUpdater(id);
  // 放大查看：进入时快照画布全部图片（可翻页）。本卡的候选/版本一并入列
  // 并带 meta——灯箱上下文动作（标注重绘/九宫格/设为主图/恢复版本）只对本卡
  // 图片出现："看图干活"的操作在大图做，缩略图悬浮条只留快捷动作
  const [zoom, setZoom] = useState<number | null>(null);
  const [gallery, setGallery] = useState<
    { src: string; title?: string; meta?: unknown }[]
  >([]);
  const [uploading, setUploading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [maskOpen, setMaskOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const lod = useLod();
  // 防御：异常数据不渲染（hooks 已在上，顺序稳定）
  if (!d || typeof d.nodeType !== "string") return null;

  const openZoom = () => {
    const gal: {
      src: string;
      title?: string;
      meta?: {
        nodeId: string;
        kind: "primary" | "candidate" | "version";
        idx?: number;
        at?: string;
        prompt?: string;
      };
    }[] = [];
    for (const n of useCanvasStore.getState().nodes) {
      if (n.data.nodeType !== "image" || !n.data.imageUrl) continue;
      if (n.id === id) {
        gal.push({
          src: d.imageUrl!,
          title: d.title ?? "",
          meta: { nodeId: id, kind: "primary" },
        });
        (d.imageUrls ?? []).forEach((u, i) => {
          if (u && u !== d.imageUrl)
            gal.push({
              src: u,
              title: `${d.title ?? ""} · 候选${i + 1}`,
              meta: { nodeId: id, kind: "candidate", idx: i },
            });
        });
        (d.versions ?? []).forEach((v, i) =>
          gal.push({
            src: v.url,
            title: `${d.title ?? ""} · ${v.at}`,
            meta: {
              nodeId: id,
              kind: "version",
              idx: i,
              at: v.at,
              prompt: v.prompt,
            },
          }),
        );
      } else {
        gal.push({
          src: n.data.imageUrl as string,
          title: n.data.title,
          meta: { nodeId: n.id, kind: "primary" },
        });
      }
    }
    setGallery(gal);
    const idx = gal.findIndex((g) => g.src === d.imageUrl);
    setZoom(idx >= 0 ? idx : 0);
  };

  // 恢复历史版本（与 NodeMediaHistory.restore 同逻辑：当前版入档、目标版
  // 出档回主图，genPrompt 一并回滚防串词；灯箱动作区调用）
  const restoreVersion = (v: { url: string; at?: string; prompt?: string }) => {
    const st = useCanvasStore.getState();
    st.commitHistory();
    st.updateNodeData(id, {
      imageUrl: v.url,
      genPrompt: v.prompt || d.genPrompt,
      versions: [
        ...(d.versions ?? []).filter((x) => x.url !== v.url),
        {
          url: d.imageUrl!,
          at: new Date().toISOString().slice(5, 16).replace("T", " "),
          prompt: String(d.genPrompt ?? "").trim() || undefined,
        },
      ],
    });
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || !f.type.startsWith("image/")) return;
    setUploading(true);
    void (async () => {
      try {
        const url = await uploadAsset(f, f.type, f.name);
        if (url)
          update({
            imageUrl: url,
            status: "ready",
            // 上传覆盖也入版本档案（prompt 归因旧图的 genPrompt）
            ...(d.imageUrl
              ? {
                  versions: [
                    ...(d.versions ?? []),
                    {
                      url: d.imageUrl,
                      at: new Date().toISOString().slice(5, 16).replace("T", " "),
                      prompt: String(d.genPrompt ?? "").trim() || undefined,
                    },
                  ].slice(-12),
                }
              : {}),
          });
      } finally {
        setUploading(false);
      }
    })();
  };

  const candidates = d.imageUrls ?? [];
  const versionCount = d.versions?.length ?? 0;

  return (
    <CardShell id={id} data={d} selected={selected} aspect={d.status === "ready"}>
      {/* 媒体区弹性伸缩（flex-1 + min-h-0）：卡被拖小（Look 卡/手动缩放）
          时跟着缩，object-contain 保图完整，内容永不溢出卡体 */}
      <div
        className={`mt-1.5 flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden rounded-md border border-hairline-soft bg-surface-2 ${
          d.status === "loading" ? "ws-loading-scan" : ""
        }`}
      >
        {lod === "nano" ? (
          <NanoBlock nodeType={d.nodeType} />
        ) : d.status === "loading" ? (
          <GenProgress nodeId={id} expected={22} />
        ) : d.status === "error" ? (
          <RetryPanel nodeId={id} errorMessage={d.errorMessage} />
        ) : d.imageUrl ? (
          <div
            className="nodrag group relative h-full w-full"
            onDoubleClick={(e) => {
              e.stopPropagation();
              focusCardView(rf, id);
            }}
            title="双击：视口聚焦本卡；右上角 ⌕ 看大图"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={assetThumbUrl(d.imageUrl)}
              alt={d.title}
              className="ws-media-in h-full w-full object-contain"
              {...mediaDragProps(id)}
            />
            {lod === "full" ? (
              <CornerActions>
              <button
                type="button"
                data-tip="版本历史（重生成前的结果自动存档）" aria-label="版本历史（重生成前的结果自动存档）"
                className="nodrag flex items-center gap-0.5 rounded-md bg-black/40 p-1 text-[10px] text-white hover:bg-black/60"
                data-track="card.version-history"
  onClick={(e) => {
                  e.stopPropagation();
                  setHistoryOpen(true);
                }}
              >
                <History className="h-3 w-3" />V{versionCount + 1}
              </button>
              {d.body || d.genPrompt ? (
                <button
                  type="button"
                  data-tip="复制提示词" aria-label="复制提示词"
                  className="rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                  data-track="card.copy-prompt"
  onClick={(e) => {
                    e.stopPropagation();
                    // 优先复制实际发出的生成提示词快照（批量/重生成后不再是
                    // 一句行文案）；无快照回退卡上正文
                    void navigator.clipboard
                      ?.writeText(
                        String(d.genPrompt ?? "").trim() || (d.body ?? ""),
                      )
                      .catch(() => undefined);
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                data-tip="下载图片（原图）" aria-label="下载图片（原图）"
                className="rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                data-track="image.download"
  onClick={(e) => {
                  e.stopPropagation();
                  void downloadMedia(d.imageUrl!, d.title || "image").catch(
                    (exc) =>
                      showToast(
                        `下载失败${exc instanceof Error && exc.message ? `：${exc.message}` : ""}`,
                      ),
                  );
                }}
              >
                <Download className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                data-tip="复制图片到剪贴板" aria-label="复制图片到剪贴板"
                className="rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                data-track="image.copy-image"
  onClick={(e) => {
                  e.stopPropagation();
                  void copyImageToClipboard(d.imageUrl!).catch((exc) =>
                    showToast(
                      `复制图片失败${exc instanceof Error && exc.message ? `：${exc.message}` : ""}`,
                    ),
                  );
                }}
              >
                <ImagePlus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                data-tip="重新生成" aria-label="重新生成"
                className="rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                data-track="card.regenerate"
  onClick={(e) => {
                  e.stopPropagation();
                  window.dispatchEvent(
                    new CustomEvent(RETRY_GENERATION_EVENT, {
                      detail: { nodeId: id },
                    }),
                  );
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                data-tip="查看大图（标注重绘/九宫格/版本在此操作）" aria-label="查看大图"
                className="nodrag rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                data-track="card.open-lightbox"
  onClick={(e) => {
                  e.stopPropagation();
                  openZoom();
                }}
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
            </CornerActions>
            ) : null}
          </div>
        ) : (
          <MediaEmpty
            icon={<ImageIcon className="h-5 w-5" />}
            hint="点击上传图片"
            sub="或选中卡片后在下方输入让 AI 生成"
            busy={uploading}
            onClick={() => fileRef.current?.click()}
          />
        )}
      </div>
      {lod === "full" && (candidates.length > 1 || Boolean(d.failedCandidates)) ? (
        <div className="ws-detail nowheel mt-1 flex items-center gap-1 overflow-x-auto">
          {candidates.length > 1 ? (
            <span className="shrink-0 text-[9px] text-text-4">
              候选{candidates.length}
            </span>
          ) : null}
          {candidates.map((u, i) => (
            <button
              key={`${u}_${i}`}
              type="button"
              data-tip="设为主图" aria-label="设为主图"
              className={`shrink-0 overflow-hidden rounded border transition-colors ${
                u === d.imageUrl ? "border-accent" : "border-hairline-soft hover:border-accent-soft"
              }`}
              data-track="shot.set-primary"
  onClick={(e) => {
                e.stopPropagation();
                update({ primaryIndex: i, imageUrl: u });
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={assetThumbUrl(u)} alt="" className="h-9 w-9 object-cover" />
            </button>
          ))}
          {Boolean(d.failedCandidates) ? (
            <button
              type="button"
              data-tip="重出失败的候选（沿用原提示词与参考图）" aria-label={`补出 ${d.failedCandidates} 张`}
              disabled={Boolean(d.supplementing)}
              className="flex shrink-0 items-center gap-0.5 rounded border border-dashed border-hairline px-1 py-1 text-[9px] text-text-3 transition-colors hover:border-accent hover:text-text disabled:opacity-50"
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(
                  new CustomEvent(SUPPLEMENT_CANDIDATES_EVENT, {
                    detail: { nodeId: id, count: d.failedCandidates },
                  }),
                );
              }}
            >
              {d.supplementing ? (
                <>
                  <Loader2 className="h-3 w-3 motion-safe:animate-spin" />
                  补出中…
                </>
              ) : (
                `补出 ${d.failedCandidates} 张`
              )}
            </button>
          ) : null}
        </div>
      ) : null}
      {lod === "full" && d.body ? (
        <p className="ws-detail mt-1 line-clamp-2 whitespace-pre-wrap text-[10px] leading-relaxed text-text-3">
          {d.body}
        </p>
      ) : null}
      {zoom !== null && gallery.length > 0 ? (
        <Lightbox
          images={gallery}
          index={zoom}
          onIndex={setZoom}
          onClose={() => setZoom(null)}
          actions={(item, api) => {
            const meta = item.meta as
              | {
                  nodeId: string;
                  kind: "primary" | "candidate" | "version";
                  idx?: number;
                  at?: string;
                  prompt?: string;
                }
              | undefined;
            if (meta?.nodeId !== id) return null;
            const btn =
              "rounded-full p-1.5 text-white/80 hover:bg-white/20 hover:text-white disabled:opacity-40";
            return (
              <>
                {meta.kind === "candidate" ? (
                  <button
                    type="button"
                    data-tip="设为主图" aria-label="设为主图"
                    className={btn}
                    disabled={item.src === d.imageUrl}
                    data-track="shot.set-primary"
  onClick={(e) => {
                      e.stopPropagation();
                      update({
                        primaryIndex: meta.idx ?? 0,
                        imageUrl: item.src,
                      });
                    }}
                  >
                    <ImageUp className="h-4 w-4" />
                  </button>
                ) : null}
                {meta.kind === "version" ? (
                  <button
                    type="button"
                    data-tip="恢复此版本（当前版自动存档）" aria-label="恢复此版本（当前版自动存档）"
                    className={btn}
                    data-track="lightbox.restore-version"
  onClick={(e) => {
                      e.stopPropagation();
                      restoreVersion({
                        url: item.src,
                        at: meta.at,
                        prompt: meta.prompt,
                      });
                      api.close();
                    }}
                  >
                    <Undo2 className="h-4 w-4" />
                  </button>
                ) : null}
                <button
                  type="button"
                  data-tip="标注重绘：涂出想改的区域让 AI 重绘" aria-label="标注重绘：涂出想改的区域让 AI 重绘"
                  className={btn}
                  data-track="card.mask-redraw"
  onClick={(e) => {
                    e.stopPropagation();
                    api.close();
                    setMaskOpen(true);
                  }}
                >
                  <Brush className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  data-tip="九宫格切图：拆成 9 张卡" aria-label="九宫格切图：拆成 9 张卡"
                  className={btn}
                  onClick={(e) => {
                    e.stopPropagation();
                    api.close();
                    void splitImageToGrid(id, item.src, item.title ?? "");
                  }}
                >
                  <Grid3X3 className="h-4 w-4" />
                </button>
              </>
            );
          }}
        />
      ) : null}
      {historyOpen ? (
        <VersionHistoryModal nodeId={id} data={d} onClose={() => setHistoryOpen(false)} />
      ) : null}
      {maskOpen && d.imageUrl ? (
        <MaskEditDialog
          nodeId={id}
          src={d.imageUrl}
          title={d.title ?? ""}
          onClose={() => setMaskOpen(false)}
        />
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onFile}
      />
    </CardShell>
  );
}

/** 视频放大播放：点击遮罩或 Esc 关闭；右上角下载（blob 落盘，同 Lightbox） */
function VideoLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [dl, setDl] = useState<"idle" | "busy" | "done" | "error">("idle");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const base =
    decodeURIComponent(src.split("?")[0].split("/").pop() ?? "") || "视频";
  return (
    <OverlayModal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
      onClick={onClose}
    >
      <video
        src={src}
        controls
        autoPlay
        playsInline
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      <div className="absolute right-4 top-4 flex items-center gap-2">
        <button
          type="button"
          data-tip="下载" aria-label="下载"
          disabled={dl === "busy"}
          className="rounded-full bg-white/10 p-2 text-white hover:bg-white/20 disabled:opacity-40"
          onClick={async (e) => {
            e.stopPropagation();
            if (dl === "busy") return;
            setDl("busy");
            try {
              await downloadMedia(src, base);
              setDl("done");
            } catch {
              setDl("error");
            }
            setTimeout(() => setDl("idle"), 1600);
          }}
        >
          {dl === "busy" ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : dl === "done" ? (
            <Check className="h-5 w-5" />
          ) : (
            <Download className="h-5 w-5" />
          )}
        </button>
        <button
          type="button"
          className="rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          onClick={onClose}
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </OverlayModal>
  );
}

/** 抽帧：等距取 count 帧缩略图 dataURL（同源视频不污染画布）。
 *  width/quality 可调：缩略条用 96px，AI 拉片要 320px 保细节 */
async function extractVideoFrames(
  src: string,
  count: number,
  width = 96,
  quality = 0.72,
): Promise<{ t: number; data: string }[]> {
  const v = document.createElement("video");
  v.src = src;
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  await new Promise<void>((resolve, reject) => {
    v.onloadeddata = () => resolve();
    v.onerror = () => reject(new Error("video load failed"));
  });
  const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
  const canvas = document.createElement("canvas");
  const w = width;
  canvas.width = w;
  canvas.height = Math.max(
    1,
    Math.round(w * ((v.videoHeight || 9) / (v.videoWidth || 16))),
  );
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  const out: { t: number; data: string }[] = [];
  for (let i = 0; i < count; i++) {
    const t = Math.min((dur * (i + 0.5)) / count, Math.max(0, dur - 0.05));
    await new Promise<void>((resolve) => {
      v.onseeked = () => resolve();
      v.currentTime = t;
    });
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    out.push({ t, data: canvas.toDataURL("image/jpeg", quality) });
  }
  return out;
}

/** dataURL → Blob（上传用） */
function dataUrlToBlob(data: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const [head, b64] = data.split(",");
    const mime = head.match(/data:(.+?);/)?.[1] ?? "image/jpeg";
    const bin = atob(b64 ?? "");
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    resolve(new Blob([arr], { type: mime }));
  });
}

/** 抽取原生分辨率的一帧 → 上传 → 建连线的 image 卡（对标 AIGCCanvasFlow 的"+图"） */
async function captureFrameAsNode(
  videoNodeId: string,
  src: string,
  t: number,
): Promise<void> {
  const v = document.createElement("video");
  v.src = src;
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  await new Promise<void>((resolve, reject) => {
    v.onloadeddata = () => resolve();
    v.onerror = () => reject(new Error("video load failed"));
  });
  await new Promise<void>((resolve) => {
    v.onseeked = () => resolve();
    v.currentTime = t;
  });
  const canvas = document.createElement("canvas");
  canvas.width = v.videoWidth || 640;
  canvas.height = v.videoHeight || 360;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92),
  );
  if (!blob) return;
  const url = await uploadAsset(blob, "image/jpeg");
  if (!url) return;
  const st = useCanvasStore.getState();
  const source = st.nodes.find((n) => n.id === videoNodeId);
  if (!source) return;
  const abs = absolutePosition(st.nodes, source);
  const label = `帧 ${t.toFixed(1)}s`;
  const id = st.addNode({
    position: { x: abs.x + 380, y: abs.y + 60 },
    data: {
      nodeType: "image",
      title: label,
      body: `截取自视频 ${t.toFixed(1)}s`,
      imageUrl: url,
      status: "ready",
    },
  });
  st.connect({ source: videoNodeId, target: id });
  useCanvasStore.getState().selectNodes([id]);
}

/** 视频卡：占位（本地上传 / 输入条让 AI 生成）/ loading 进度 / error 重试 / ready 内联播放 */
function VideoCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const update = makeUpdater(id);
  const [zoom, setZoom] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [frames, setFrames] = useState<{ t: number; data: string }[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [frameCount, setFrameCount] = useState(6);
  const [historyOpen, setHistoryOpen] = useState(false);
  const framesFor = useRef("");
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lod = useLod();
  // 选中即静音预览、失焦即停（对标 viedeo-workflow 的扫片体验）
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (selected) {
      v.muted = true;
      void v.play().catch(() => undefined);
    } else {
      v.pause();
    }
  }, [selected]);
  // 就绪后按选定帧数抽缩略图（异步；失败静默——跨域或解码不支持就不出条）。
  // LOD 门控：micro/nano 不渲染缩略图条，抽帧解码纯浪费
  useEffect(() => {
    if (lod !== "full") return;
    const url = (data as WingNodeData | undefined)?.videoUrl;
    const key = url ? `${url}_${frameCount}` : "";
    if (!url || framesFor.current === key) return;
    framesFor.current = key;
    void (async () => {
      try {
        setFrames(await extractVideoFrames(url, frameCount));
      } catch {
        setFrames([]);
      }
    })();
  }, [data, frameCount, lod]);
  // 防御：异常数据不渲染（hooks 已在上，顺序稳定）
  if (!d || typeof d.nodeType !== "string") return null;
  const versionCount = d.versions?.length ?? 0;

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setUploading(true);
    void (async () => {
      try {
        const url = await uploadAsset(f, f.type);
        if (url) update({ videoUrl: url, status: "ready" });
      } finally {
        setUploading(false);
      }
    })();
  };

  /** AI 拉片：抽 8 帧（320px）上传成资产 → 事件 → 桥接层组装聊天指令给 agent 做镜头语言分析 */
  const runFrameAnalysis = async () => {
    if (!d.videoUrl || analyzing) return;
    setAnalyzing(true);
    try {
      const shots = await extractVideoFrames(d.videoUrl, 8, 320, 0.7);
      const uploaded: { url: string; t: number }[] = [];
      for (const s of shots) {
        const blob = await dataUrlToBlob(s.data);
        const url = blob ? await uploadAsset(blob, "image/jpeg", `frame_${s.t.toFixed(1)}s.jpg`) : null;
        if (url) uploaded.push({ url, t: s.t });
      }
      if (uploaded.length > 0) {
        window.dispatchEvent(
          new CustomEvent(FRAME_ANALYSIS_EVENT, {
            detail: { nodeId: id, frames: uploaded },
          }),
        );
      }
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <CardShell id={id} data={d} selected={selected} aspect={d.status === "ready"}>
      <div
        className={`mt-1.5 flex h-44 min-h-44 w-full flex-1 items-center justify-center overflow-hidden rounded-md border border-hairline-soft bg-surface-2 ${
          d.status === "loading" ? "ws-loading-scan" : ""
        }`}
      >
        {d.status === "loading" ? (
          <GenProgress nodeId={id} expected={90} />
        ) : d.status === "error" ? (
          <RetryPanel nodeId={id} errorMessage={d.errorMessage} />
        ) : lod !== "full" ? (
          lod === "nano" || !d.imageUrl ? (
            <NanoBlock nodeType={d.nodeType} />
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={assetThumbUrl(d.imageUrl)}
              alt={d.title}
              className="ws-media-in h-full w-full object-contain"
            />
          )
        ) : d.videoUrl ? (
          <div className="nowheel nodrag group relative h-full w-full">
            <video
              ref={videoRef}
              src={d.videoUrl}
              poster={d.imageUrl}
              controls
              preload="metadata"
              playsInline
              className="ws-media-in h-full w-full bg-black object-contain"
              onClick={(e) => e.stopPropagation()}
            />
            <CornerActions>
              {versionCount > 0 ? (
                <button
                  type="button"
                  data-tip="版本历史（重生成前的结果自动存档）" aria-label="版本历史（重生成前的结果自动存档）"
                  className="flex items-center gap-0.5 rounded-md bg-black/40 px-1 py-0.5 text-[10px] text-white hover:bg-black/60"
                  data-track="card.version-history"
  onClick={(e) => {
                    e.stopPropagation();
                    setHistoryOpen(true);
                  }}
                >
                  <History className="h-3 w-3" />V{versionCount + 1}
                </button>
              ) : null}
              <button
                type="button"
                data-tip={analyzing ? "抽帧上传中…" : "AI 拉片：抽帧分析镜头语言"} aria-label={analyzing ? "抽帧上传中…" : "AI 拉片：抽帧分析镜头语言"}
                disabled={analyzing}
                className="rounded-md bg-black/40 p-1 text-white hover:bg-black/60 disabled:opacity-50"
                onClick={(e) => {
                  e.stopPropagation();
                  void runFrameAnalysis();
                }}
              >
                <ScanSearch className="h-3.5 w-3.5" />
              </button>
              <a
                href={d.videoUrl}
                download={downloadName(d.title, d.videoUrl, "mp4")}
                title="下载视频"
                className="rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                onClick={(e) => e.stopPropagation()}
              >
                <Download className="h-3.5 w-3.5" />
              </a>
              <button
                type="button"
                data-tip="放大播放" aria-label="放大播放"
                className="rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                onClick={(e) => {
                  e.stopPropagation();
                  setZoom(true);
                }}
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            </CornerActions>
          </div>
        ) : (
          <MediaEmpty
            icon={<Film className="h-5 w-5" />}
            hint="点击上传视频"
            sub="或选中卡片后在下方输入让 AI 生成"
            busy={uploading}
            onClick={() => fileRef.current?.click()}
          />
        )}
      </div>
      {lod === "full" && d.body ? (
        <p className="ws-detail mt-1 line-clamp-2 whitespace-pre-wrap text-[10px] leading-relaxed text-text-3">
          {d.body}
        </p>
      ) : null}
      {/* 抽帧条：hover 某帧出"+图"，点击抽原生分辨率帧建连线图片卡；帧数可切换 */}
      {lod === "full" && d.videoUrl && frames.length > 0 ? (
        <div className="ws-detail nowheel mt-1 flex items-center gap-1 overflow-x-auto">
          {[6, 12, 24].map((n) => (
            <button
              key={n}
              type="button"
              data-tip={`抽 ${n} 帧`} aria-label={`抽 ${n} 帧`}
              className={`shrink-0 rounded border px-1 py-0.5 text-[9px] transition-colors ${
                frameCount === n
                  ? "border-accent bg-accent-dim text-text"
                  : "border-hairline text-text-4 hover:text-text-2"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                setFrameCount(n);
              }}
            >
              {n}帧
            </button>
          ))}
          {frames.map((f) => (
            <button
              key={f.t}
              type="button"
              className="nodrag group relative shrink-0 overflow-hidden rounded border border-hairline-soft transition-colors hover:border-accent"
              data-tip={`${f.t.toFixed(1)}s · 点击抽帧建图卡`} aria-label={`${f.t.toFixed(1)}s · 点击抽帧建图卡`}
              onClick={(e) => {
                e.stopPropagation();
                void captureFrameAsNode(id, d.videoUrl as string, f.t);
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.data} className="h-10 w-auto object-cover" alt="" />
              <span className="absolute inset-0 grid place-items-center bg-black/45 text-[9px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                +图
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {!d.status && !d.videoUrl ? (
        <p className="ws-detail mt-1.5 text-center text-[10px] text-text-4">
          选中卡片后可在下方输入区让 AI 生成
        </p>
      ) : null}
      {zoom && d.videoUrl ? (
        <VideoLightbox src={d.videoUrl} onClose={() => setZoom(false)} />
      ) : null}
      {historyOpen ? (
        <VersionHistoryModal nodeId={id} data={d} onClose={() => setHistoryOpen(false)} />
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={onFile}
      />
    </CardShell>
  );
}

/** 音频卡：上传占位 / 自定义播放器（配音 / 音效 / BGM；波形裁剪后续迭代） */
function AudioCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const update = makeUpdater(id);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const lod = useLod();
  // 防御：异常数据不渲染（hooks 已在上，顺序稳定）
  if (!d || typeof d.nodeType !== "string") return null;

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || !f.type.startsWith("audio/")) return;
    setUploading(true);
    void (async () => {
      try {
        const url = await uploadAsset(f, f.type, f.name);
        if (url) update({ audioUrl: url });
      } finally {
        setUploading(false);
      }
    })();
  };

  return (
    <CardShell id={id} data={d} selected={selected}>
      <div className="mt-1.5 flex min-h-14 w-full flex-1 items-center justify-center rounded-md border border-hairline-soft bg-surface-2 px-2.5 py-1.5">
        {lod !== "full" ? (
          <div className="flex w-full items-center gap-1.5 text-text-3">
            <Music className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[11px]">
              {d.title || "音频"}
            </span>
          </div>
        ) : d.audioUrl ? (
          <AudioPlayer src={d.audioUrl} title={d.title ?? ""} />
        ) : (
          <MediaEmpty
            icon={<Music className="h-4 w-4" />}
            hint="上传音频"
            sub="配音 / 音效 / BGM"
            busy={uploading}
            onClick={() => fileRef.current?.click()}
          />
        )}
      </div>
      {lod === "full" ? (
        <Editable
          value={d.title}
          onSave={(title, opts) => update({ title }, opts)}
          className="mt-1.5 line-clamp-1 text-xs font-medium text-text"
          placeholder="（无标题）"
        />
      ) : null}
      {lod === "full" && d.body ? (
        <p className="ws-detail mt-1 line-clamp-2 whitespace-pre-wrap text-[10px] leading-relaxed text-text-3">
          {d.body}
        </p>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={onFile}
      />
    </CardShell>
  );
}

/** 合成卡：连线接入的视频按序拼接（novanova 的连线排序式；执行走服务端 ffmpeg 直连） */
function ComposeCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const update = makeUpdater(id);
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  // 连线进来的视频源（video/compose 且有产物），新连的自动追加到序列尾
  const sources = useMemo(() => {
    const out: { sid: string; node: WingNode }[] = [];
    for (const e of edges) {
      if (e.target !== id) continue;
      const n = nodes.find((x) => x.id === e.source);
      if (n?.data.videoUrl) out.push({ sid: e.source, node: n });
    }
    return out;
  }, [edges, id, nodes]);
  const sourcesKey = sources.map((s) => s.sid).join(",");

  // 新连入的源追加进 itemIds（顺序权威存 data；被移除的源边已断，不会回来）
  useEffect(() => {
    const list = (d.itemIds as string[] | undefined) ?? [];
    const fresh = sources.filter((s) => !list.includes(s.sid));
    if (fresh.length === 0) return;
    update({ itemIds: [...list, ...fresh.map((s) => s.sid)] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesKey]);

  const lod = useLod();
  // 防御：异常数据不渲染（hooks 已在上，顺序稳定）
  if (!d || typeof d.nodeType !== "string") return null;

  const order = (d.itemIds as string[] | undefined) ?? [];
  const listed = sources.filter((s) => order.includes(s.sid));
  const items = [
    ...listed.sort((a, b) => order.indexOf(a.sid) - order.indexOf(b.sid)),
    ...sources.filter((s) => !order.includes(s.sid)),
  ];

  const move = (i: number, dir: -1 | 1) => {
    const ids = items.map((s) => s.sid);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    update({ itemIds: ids });
  };
  const removeSource = (sid: string) => {
    useCanvasStore.getState().commitHistory();
    useCanvasStore.setState((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, itemIds: (n.data.itemIds ?? []).filter((x) => x !== sid) } } : n,
      ),
      edges: s.edges.filter((e) => !(e.target === id && e.source === sid)),
    }));
  };

  // 合成走共用实现（与分镜表「一键成片」同一份取源/排序/落盘逻辑）
  const runCompose = () => composeFromCard(id);

  return (
    <CardShell id={id} data={d} selected={selected}>
      {d.videoUrl ? (
        <div className="mt-1.5 min-h-28 w-full flex-1 overflow-hidden rounded-md border border-hairline-soft bg-surface-2">
          {lod !== "full" ? (
            <NanoBlock nodeType={d.nodeType} />
          ) : (
            <video
              src={d.videoUrl}
              controls
              preload="metadata"
              playsInline
              className="nodrag nowheel ws-media-in h-full w-full bg-black object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      ) : null}
      {lod === "full" ? (
      <div className="ws-detail mt-1.5 flex max-h-36 shrink-0 flex-col gap-1 overflow-auto nowheel">
        {items.length === 0 ? (
          <p className="rounded-md border border-dashed border-hairline px-2 py-3 text-center text-[10px] text-text-4">
            把视频卡连线到这里，按序拼接成片
          </p>
        ) : (
          items.map((s, i) => (
            <div
              key={s.sid}
              className="flex items-center gap-1 rounded-md border border-hairline bg-surface-2 px-1.5 py-1"
            >
              <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent-dim text-[9px] font-semibold tabular-nums text-text">
                {i + 1}
              </span>
              <span
                className="ws-card-dot shrink-0"
                style={{ background: NODE_META[s.node.data.nodeType].dot }}
              />
              <span className="min-w-0 flex-1 truncate text-[11px] text-text-2">
                {s.node.data.title || s.sid}
              </span>
              <button type="button" data-tip="上移" aria-label="上移" disabled={i === 0}
                className="nodrag text-text-4 hover:text-text disabled:opacity-30"
                onClick={(e) => { e.stopPropagation(); move(i, -1); }}>
                <ChevronUp className="h-3 w-3" />
              </button>
              <button type="button" data-tip="下移" aria-label="下移" disabled={i === items.length - 1}
                className="nodrag text-text-4 hover:text-text disabled:opacity-30"
                onClick={(e) => { e.stopPropagation(); move(i, 1); }}>
                <ChevronDown className="h-3 w-3" />
              </button>
              <button type="button" data-tip="从合成移除（断开连线）" aria-label="从合成移除（断开连线）"
                className="nodrag text-text-4 hover:text-danger"
                onClick={(e) => { e.stopPropagation(); removeSource(s.sid); }}>
                <X className="h-3 w-3" />
              </button>
            </div>
          ))
        )}
      </div>
      ) : null}
      {d.status === "loading" ? (
        <GenProgress nodeId={id} expected={30} />
      ) : d.status === "error" ? (
        <button
          type="button"
          className="nodrag mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-danger/40 bg-danger/10 py-1.5 text-[11px] text-danger hover:bg-danger/20"
          onClick={(e) => {
            e.stopPropagation();
            void runCompose();
          }}
        >
          <CircleAlert className="h-3.5 w-3.5" />
          {d.errorMessage || "合成失败"} · 点击重试
        </button>
      ) : lod === "full" ? (
        <button
          type="button"
          disabled={items.length === 0}
          className="nodrag mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-accent bg-accent-dim py-1.5 text-[11px] font-medium text-text transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:border-hairline disabled:bg-surface-2 disabled:text-text-4"
          onClick={(e) => {
            e.stopPropagation();
            void runCompose();
          }}
        >
          <Combine className="h-3.5 w-3.5" />
          合成成片（{items.length} 段）
        </button>
      ) : null}
    </CardShell>
  );
}

/** 分镜卡字段 chip：双击就地编辑（镜号 / 景别 / 运镜 / 时长共用）。
 *  accent：镜号用——数字章样式，从其他字段里跳出来 */
/** 枚举下拉（景别/运镜，搬 novanova 的受控下拉范式）：固定选项集 +
 *  当前自定义值兜底显示（历史数据/自由输入不丢） */
function ShotSelect({
  label,
  value,
  options,
  onSave,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onSave: (v: string) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1 rounded border border-hairline bg-surface-2 px-1 text-[10px] leading-4">
      <span className="text-text-4">{label}</span>
      <select
        value={options.includes(value) ? value : value ? "__custom__" : ""}
        onChange={(e) => onSave(e.target.value === "__custom__" ? value : e.target.value)}
        title="点击选择（下拉外的历史值会保留显示）"
        className="nodrag nowheel min-w-6 cursor-pointer bg-transparent py-0.5 text-[10px] text-text-2 outline-none"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {!options.includes(value) && value ? (
          <option value="__custom__">{value}（自定义）</option>
        ) : null}
      </select>
    </label>
  );
}

function ShotChip({
  label,
  value,
  accent,
  onSave,
}: {
  label: string;
  value: string;
  accent?: boolean;
  onSave: (v: string, opts?: NodeDataUpdateOpts) => void;
}) {
  return (
    <span
      className={`inline-flex min-w-11 max-w-full items-center gap-1 rounded border px-1 text-[10px] leading-4 ${
        accent
          ? "border-accent bg-accent-dim font-semibold tabular-nums text-text"
          : "border-hairline bg-surface-2 text-text-3"
      }`}
      // 长值（光影/音效常是整句）：列宽内尽量展示，超出悬停看全文
      title={value || undefined}
    >
      <span className={`shrink-0 ${accent ? "text-accent" : "text-text-4"}`}>{label}</span>
      <Editable
        value={value}
        onSave={onSave}
        always
        placeholder="—"
        className="max-w-full text-text-2"
      />
    </span>
  );
}

/** 分镜卡：宽卡 + 镜号/景别/运镜/时长字段行 + 台词（导演台入口在右键菜单） */
function StoryboardCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const update = makeUpdater(id);
  const lod = useLod();
  if (!d || typeof d.nodeType !== "string") return null;
  return (
    <CardShell id={id} data={d} selected={selected}>
      {lod === "full" ? (
        <>
          <div className="ws-detail mt-1.5 flex flex-wrap gap-1">
            <ShotChip accent label="镜号" value={d.shotNumber ?? ""} onSave={(shotNumber, opts) => update({ shotNumber }, opts)} />
            <ShotChip label="景别" value={d.shotSize ?? ""} onSave={(shotSize, opts) => update({ shotSize }, opts)} />
            <ShotChip label="运镜" value={d.cameraMove ?? ""} onSave={(cameraMove, opts) => update({ cameraMove }, opts)} />
            <ShotChip label="时长" value={d.duration ?? ""} onSave={(duration, opts) => update({ duration }, opts)} />
          </div>
          <Editable
            value={d.body ?? ""}
            onSave={(body, opts) => update({ body }, opts)}
            multiline
            always
            placeholder="画面描述（谁、在哪、做什么）"
            className="ws-detail nowheel mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-text-2"
          />
          <Editable
            value={d.dialogue ?? ""}
            onSave={(dialogue, opts) => update({ dialogue }, opts)}
            multiline
            always
            placeholder="台词 / 旁白"
            className="ws-detail mt-1.5 line-clamp-2 border-l-2 border-hairline pl-1.5 text-xs italic leading-relaxed text-text-3"
          />
        </>
      ) : (d.body ?? "").trim() && lod === "micro" ? (
        <p className="line-clamp-6 whitespace-pre-wrap text-[11px] leading-relaxed text-text-3">
          {d.body}
        </p>
      ) : null}
    </CardShell>
  );
}

/** 分组框：虚线容器（子节点由 React Flow parentId 机制跟随移动，坐标相对本组），
 *  可整体缩放、折叠成胶囊（子卡隐藏，尺寸存 data.prevSize 待还原） */
function GroupCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const update = makeUpdater(id);
  const childCount = useCanvasStore(
    (s) => s.nodes.filter((n) => n.parentId === id).length,
  );
  if (!d || typeof d.nodeType !== "string") return null;
  const collapsed = Boolean(d.collapsed);
  return (
    <div
      className={`flex h-full w-full flex-col rounded-xl border border-dashed ${
        collapsed ? "bg-surface-1/70" : "bg-surface-1/30"
      } ${selected ? "border-accent" : "border-hairline"}`}
    >
      <NodeResizer
        isVisible={selected && !collapsed}
        minWidth={220}
        minHeight={160}
        handleClassName="ws-resize-handle"
        lineClassName="ws-resize-line"
      />
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <button
          type="button"
          data-tip={collapsed ? "展开分组" : "折叠分组（隐藏子卡）"} aria-label={collapsed ? "展开分组" : "折叠分组（隐藏子卡）"}
          className="nodrag shrink-0 text-text-3 transition-colors hover:text-text"
          onClick={(e) => {
            e.stopPropagation();
            useCanvasStore.getState().toggleGroupCollapse(id);
          }}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
        {(() => {
          const GroupIcon = TYPE_ICONS.group;
          return <GroupIcon className="h-3 w-3 shrink-0 text-text-4" />;
        })()}
        <Editable
          value={d.title}
          onSave={(title, opts) => update({ title }, opts)}
          className="truncate text-xs font-medium text-text-3"
          placeholder="分组名"
        />
        <span className="ml-auto shrink-0 text-[10px] text-text-4">
          {childCount} 卡
        </span>
      </div>
    </div>
  );
}

/** 分镜行出图提示词合成（八段式轻量版；finalPrompt 有值时由调用方直用）。
 *  全局视觉风格收尾（novanova visualStyle 段），供合成与批量出图共用。
 *  只收静态图能表达的段：景别（景框）/画面/光影/风格。时长与运镜（推拉
 *  摇移跟升降手持）是镜头运动语言，静帧表达不了；台词旁白与音效是听觉
 *  信息，混进画面提示词只会成为噪点——它们保留在行字段与分镜表导出里
 *  （制片交付与将来的行出视频用），不进生图提示词 */
function composeShotPrompt(r: ShotRow, visualStyle: string): string {
  const seg = [
    `镜头规格：${r.shotSize || "中景"}`,
    `画面内容：${r.action || "（无）"}`,
    r.lighting ? `光影氛围：${r.lighting}` : "",
    visualStyle ? `视觉风格：${visualStyle}` : "",
  ].filter(Boolean);
  return `${seg.join("。")}。`;
}

/** 拆解资产共享实现（ShotListCard 与 ScriptCard 的「拆解资产」都走这里）：
 *  直连拆解 flow，角色/场景/道具各成一个组框建在锚点卡正下方（同名跳过）。
 *  锚点是分镜表时才做遗留 分镜表→资产 边的翻转；内部自捕获异常并经 onError
 *  上报，永不 reject，调用方只需管 busy 态 */
async function runAssetDecompose(opts: {
  anchorId: string;
  scriptSource: string;
  /** 拆解文本模型覆盖（models.py 目录 id，缺省=flow 出厂模型；出图链不受影响） */
  model?: string;
  onMsg: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { anchorId, scriptSource } = opts;
  try {
    // 画布已有资产名单喂给拆解 flow：同指资产沿用旧名（跨次拆解可去重合并）；
    // 带卡上定妆照/已有 Look 造型名，供自动链给已有角色补 Look
    const st0 = useCanvasStore.getState();
    const existing = st0.nodes
      .filter(
        (n) =>
          ["character", "scene", "prop", "costume"].includes(
            String(n.data.nodeType),
          ) && n.data.title,
      )
      .map((n) => {
        const entry: ExistingAsset = {
          type: String(n.data.nodeType),
          name: n.data.title as string,
        };
        // 卡上现图：已有角色补 Look 的身份锚点（免重出定妆照）
        if (n.data.imageUrl) entry.image_url = n.data.imageUrl as string;
        // 已有 Look 卡的造型名：重拆时对名跳过不重出
        if (entry.type === "character") {
          const labels = st0.nodes
            .filter(
              (m) =>
                isLookCard(m, st0.nodes, st0.edges) &&
                st0.edges.some((e) => e.source === n.id && e.target === m.id),
            )
            .map((m) => (m.data.title as string).slice(entry.name.length + 1))
            .filter(Boolean);
          if (labels.length > 0) entry.looks = labels;
        }
        return entry;
      });
    // 拆解只建卡不出图（流程重排）：后续走「调研参考图 → 审阅采纳 →
    // 补资产图（带参考序列）」，调研结果才赶得上进出图参考序列；
    // 原 autoLooks 自动链（画风已选即自动出定妆照）停用
    const { assets, errors: decompErrors, imagesNote } = await decomposeAssets(
      scriptSource,
      existing,
      {
        autoLooks: false,
        visualStyle: useCanvasStore.getState().projectStyle ?? "",
        model: opts.model,
        onPhase: ({ phase, progress }) => {
          if (phase === "images" && progress?.total)
            opts.onMsg(`拆解完成，自动出图中 ${progress.done}/${progress.total}…`);
        },
      },
    );
    const styleNote = "";
    const imageNote = imagesNote ? `｜${imagesNote}` : "";
    const chars = assets;
    if (chars.length === 0) {
      // 全空时 errors 字典就是真因（各类型 flow 的失败原因），直接亮出来，
      // 不吞成「没拆出可用资产」让用户以为剧本没资产
      const failNote = Object.entries(decompErrors)
        .map(([t, e]) => `${t}：${e}`)
        .join("；");
      opts.onMsg(failNote ? `拆解失败：${failNote}` : "剧本里没拆出可用资产");
      return;
    }
    const st = useCanvasStore.getState();
    const src = st.nodes.find((n) => n.id === anchorId);
    if (!src) return;
    const abs = absolutePosition(st.nodes, src);
    // 排布（novanova 资产分组范式）：角色/场景/道具各成一个组框，
    // 组内 2 列网格；三个组从左到右排开（整组矩形一次性避让找空地，
    // 逐卡避让会散）。重复拆解时同名卡跳过、组框按需补建
    const KIND_ORDER = [
      { type: "character" as const, label: "角色" },
      { type: "scene" as const, label: "场景" },
      { type: "prop" as const, label: "道具" },
      { type: "costume" as const, label: "服饰" },
    ];
    const created: string[] = [];
    const groupIds: string[] = [];
    // （角色迭代的）Look 卡登记：卡在角色迭代内建，服饰→Look 边等四类卡
    // 全部建完后再连（服饰卡在角色之后才建，创建时连不上）
    const lookJobs: {
      charId: string;
      charName: string;
      looks: DecomposedLook[];
    }[] = [];
    const lookEdges: { lookId: string; costume: string }[] = [];
    const kindCounts: Record<string, number> = {};
    let existed = 0;
    // 资产带放锚点卡正下方（脚注区）：左侧是上游来向（剧本→分镜表的连线方向）、
    // 右侧是下游产物（镜头图方阵/成片卡），只有下方是中性空地——放左侧会压进
    // 上游剧本卡的地盘（findFreePosition 只向下避让，组框被楔在剧本卡底下）。
    // 组框在带内从左往右排，行 Y 取首个落点（避让推下去后全行跟随对齐）
    let groupLeft = abs.x;
    let rowY = abs.y + nodeSize(src).h + 80;
    let charGroupRight = 0; // 角色组右缘：造型图框的贴靠锚点
    for (const { type, label } of KIND_ORDER) {
      const cur = useCanvasStore.getState();
      const items = chars.filter((a) => a.type === type);
      const fresh = items.filter(
        (a) =>
          !cur.nodes.some(
            (n) => n.data.nodeType === type && n.data.title === a.name,
          ),
      );
      existed += items.length - fresh.length;
      // 同名既有卡认领到本卡名下：assetSource 是「补资产图」的圈定键，
      // 历史无来源的存量卡由重复拆解自然 heal，不做单独的存量迁移
      for (const a of items) {
        if (fresh.includes(a)) continue;
        const owner = cur.nodes.find(
          (n) => n.data.nodeType === type && n.data.title === a.name,
        );
        if (owner && owner.data.assetSource !== anchorId)
          useCanvasStore.getState().updateNodeData(owner.id, {
            assetSource: anchorId,
          });
        // 已存在角色的 Look 补齐物化：agent 只回带 image_url 的新造型，
        // 挂到既有角色卡下（同名 Look 卡已由 agent 对名跳过，这里双保险）
        if (type === "character" && owner) {
          const newLooks = (a.looks ?? []).filter(
            (l) =>
              l.image_url &&
              !cur.nodes.some(
                (n) =>
                  n.data.nodeType === "image" &&
                  n.data.title === `${a.name}·${l.label}`,
              ),
          );
          if (newLooks.length > 0)
            lookJobs.push({ charId: owner.id, charName: a.name, looks: newLooks });
        }
      }
      if (fresh.length === 0) continue;
      kindCounts[type] = fresh.length;
      const fp = NODE_FOOTPRINT[type] ?? NODE_FOOTPRINT.note;
      // 列数随规模自适应（√n，1~3 封顶）：大拆解不再固定 2 列竖长条
      // （10 卡会拉到 1770px 高），组框接近方形，与镜头图方阵同一启发式
      const kcols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(fresh.length))));
      const kw = kcols * (fp.w + 60) - 60;
      const kh = Math.ceil(fresh.length / kcols) * (fp.h + 54) - 54;
      const origin = findFreePosition(cur.nodes, { x: groupLeft, y: rowY }, {
        w: kw,
        h: kh,
      });
      if (type === "character") charGroupRight = origin.x + kw;
      const ids: string[] = [];
      fresh.forEach((a, i) => {
        const st2 = useCanvasStore.getState();
        const nid = st2.addNode({
          position: {
            x: origin.x + (i % kcols) * (fp.w + 60),
            y: origin.y + Math.floor(i / kcols) * (fp.h + 54),
          },
          data: {
            nodeType: type,
            title: a.name,
            body: [a.description, a.visual_notes ? `视觉：${a.visual_notes}` : ""]
              .filter(Boolean)
              .join("\n"),
            // 来源锚点：补资产图按它圈定「本卡资产」
            assetSource: anchorId,
            // 全自动出图产物：定妆照即本卡唯一一张图（一张卡一张图）
            ...(a.image_url
              ? { imageUrl: a.image_url, status: "ready" as const }
              : {}),
          },
        });
        ids.push(nid);
        // Look 造型图物化成独立图片卡（连线表达「派生自角色」），不在角色卡上挂多图
        const looks = (a.looks ?? []).filter((l) => l.image_url);
        if (type === "character" && looks.length > 0)
          lookJobs.push({ charId: nid, charName: a.name, looks });
      });
      const gid = useCanvasStore.getState().groupNodes(ids, label);
      if (gid) groupIds.push(gid);
      created.push(...ids);
      groupLeft = origin.x + kw + 80;
      rowY = Math.max(rowY, origin.y);
      // 角色组右侧预留造型图框位：带内后续组从造型图框再往右排
      if (type === "character" && lookJobs.length > 0) {
        const lfp = NODE_FOOTPRINT.image;
        const colsMax = Math.max(...lookJobs.map((j) => j.looks.length), 1);
        groupLeft = charGroupRight + 64 + (colsMax * (lfp.w + 32) - 32) + 64;
      }
    }
    // Look 造型图收进专属组框「造型图」：贴角色组右缘（推导方向 左入右出），
    // 一行一角色、行内造型并排。不混进角色组——角色组是「一格一资产」的均匀
    // 网格，Look 是 1:N 衍生物；独立成框与四类资产组同款交互（整框拖动/避让）
    if (lookJobs.length > 0) {
      const st2 = useCanvasStore.getState();
      const lfp = NODE_FOOTPRINT.image;
      const colsMax = Math.max(...lookJobs.map((j) => j.looks.length), 1);
      const low = colsMax * (lfp.w + 32) - 32;
      const loh = lookJobs.length * (lfp.h + 32) - 32;
      const lorigin = findFreePosition(
        st2.nodes,
        {
          // 角色组右侧的预留位；无角色组（角色均已存在）时从带首向下避让
          x: charGroupRight > 0 ? charGroupRight + 64 : groupLeft,
          y: rowY,
        },
        { w: low, h: loh },
      );
      const lookIds: string[] = [];
      lookJobs.forEach(({ charId, charName, looks }, ri) => {
        looks.forEach((l, li) => {
          const st3 = useCanvasStore.getState();
          const lid = st3.addNode({
            position: {
              x: lorigin.x + li * (lfp.w + 32),
              y: lorigin.y + ri * (lfp.h + 32),
            },
            style: { width: lfp.w, height: lfp.h },
            data: {
              nodeType: "image",
              title: `${charName}·${l.label}`.slice(0, 40),
              body: l.description ?? "",
              imageUrl: l.image_url,
              status: "ready" as const,
            },
          });
          st3.connect({ source: charId, target: lid });
          // 进 lookIds/created（组框子节点/选中闪烁），不进类型组的 ids
          lookIds.push(lid);
          created.push(lid);
          lookEdges.push({ lookId: lid, costume: (l.costume ?? "").trim() });
        });
      });
      const lgid = useCanvasStore.getState().groupNodes(lookIds, "造型图");
      if (lgid) groupIds.push(lgid);
    }
    // 服饰绑定：Look 造型卡与服饰卡按名对上（互含即算）→ 连 服饰→Look 边，
    // 表达「该造型的衣着结构以服饰卡为准」（juben 参考图2 协议的画布化）。
    // 放在四类卡全部建完之后：服饰卡在角色之后才建，建 Look 时还不存在
    for (const { lookId, costume } of lookEdges) {
      if (!costume) continue;
      const st4 = useCanvasStore.getState();
      const cid = st4.nodes.find(
        (n) =>
          n.data.nodeType === "costume" &&
          (() => {
            const cn = (n.data.title ?? "").trim();
            return Boolean(cn) && (cn.includes(costume) || costume.includes(cn));
          })(),
      );
      if (cid) st4.connect({ source: cid.id, target: lookId });
    }
    if (created.length > 0) {
      const end = useCanvasStore.getState();
      const focusIds = groupIds.length > 0 ? groupIds : created;
      end.selectNodes(groupIds.length > 0 ? groupIds : created);
      end.flashNodes(created);
      window.dispatchEvent(
        new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: focusIds } }),
      );
    }
    if (created.length === 0 && existed > 0) {
      // 全部已存在：把混在通用组框（「资产」/「分组」等旧命名）里的卡解散，
      // 连同散卡一起按类型收拢重排、各自成组；已在类型组内的不动
      const end = useCanvasStore.getState();
      const matched = end.nodes.filter((n) =>
        chars.some((a) => a.type === n.data.nodeType && a.name === n.data.title),
      );
      const KIND_TITLES = KIND_ORDER.map((k) => k.label);
      const genericGroups = [
        ...new Set(matched.map((n) => n.parentId).filter(Boolean)),
      ]
        .map((pid) => end.nodes.find((n) => n.id === pid))
        .filter(
          (g): g is WingNode =>
            Boolean(g) &&
            g!.data.nodeType === "group" &&
            !KIND_TITLES.includes(g!.data.title ?? ""),
        );
      for (const g of genericGroups) end.ungroupNode(g.id);
      // 重排同新拆解的落位规则：锚点正下方的资产带，从左往右一行排开
      let groupLeft2 = abs.x;
      let rowY2 = abs.y + nodeSize(src).h + 80;
      const newGroups: string[] = [];
      for (const { type, label } of KIND_ORDER) {
        const cur = useCanvasStore.getState();
        const items = cur.nodes.filter(
          (n) =>
            n.data.nodeType === type &&
            !n.parentId &&
            chars.some((a) => a.type === type && a.name === n.data.title),
        );
        if (items.length === 0) continue;
        const fp = NODE_FOOTPRINT[type] ?? NODE_FOOTPRINT.note;
        const kcols = Math.min(
          3,
          Math.max(1, Math.ceil(Math.sqrt(items.length))),
        );
        const kw = kcols * (fp.w + 60) - 60;
        const kh = Math.ceil(items.length / kcols) * (fp.h + 54) - 54;
        const origin = findFreePosition(cur.nodes, { x: groupLeft2, y: rowY2 }, {
          w: kw,
          h: kh,
        });
        useCanvasStore.setState((s) => ({
          nodes: s.nodes.map((n) => {
            const idx = items.findIndex((m) => m.id === n.id);
            if (idx === -1) return n;
            return {
              ...n,
              position: {
                x: origin.x + (idx % kcols) * (fp.w + 60),
                y: origin.y + Math.floor(idx / kcols) * (fp.h + 54),
              },
            };
          }),
        }));
        const gid = useCanvasStore
          .getState()
          .groupNodes(items.map((m) => m.id), label);
        if (gid) newGroups.push(gid);
        groupLeft2 = origin.x + kw + 80;
        rowY2 = Math.max(rowY2, origin.y);
      }
      // 历史遗留的 分镜表→资产 边统一翻转为 资产→分镜表（仅分镜表锚点做：
      // 剧本卡锚点下翻成 资产→剧本 无意义）
      const anchorType = useCanvasStore
        .getState()
        .nodes.find((n) => n.id === anchorId)?.data.nodeType;
      if (anchorType === "shotlist") {
        const matchedIds = new Set(matched.map((m) => m.id));
        useCanvasStore.setState((s) => ({
          edges: s.edges.map((e) =>
            e.source === anchorId && matchedIds.has(e.target)
              ? { ...e, source: e.target, target: anchorId }
              : e,
          ),
        }));
      }
      if (newGroups.length > 0) {
        useCanvasStore.getState().selectNodes(newGroups);
        window.dispatchEvent(
          new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: newGroups } }),
        );
      }
      opts.onMsg(
        newGroups.length > 0
          ? `${existed} 项资产均已存在：已按 角色/场景/道具 收拢成组`
          : `${existed} 项资产均已存在（已在类型组内，不重排）`,
      );
      return;
    }
    const kindSummary = KIND_ORDER.filter((k) => kindCounts[k.type])
      .map((k) => `${k.label} ${kindCounts[k.type]}`)
      .join("・");
    const failNote = Object.entries(decompErrors)
      .map(([t, e]) => `${t}：${e}`)
      .join("；");
    opts.onMsg(
      created.length > 0
        ? `拆出 ${chars.length} 项资产：新建 ${created.length} 张` +
            (kindSummary ? `（${kindSummary}）` : "") +
            (existed ? `，${existed} 项已存在跳过` : "") +
            (failNote ? `｜部分类型失败：${failNote}` : "") +
            styleNote +
            imageNote
        : `${existed} 项资产均已存在，未新建` +
            (failNote ? `｜部分类型失败：${failNote}` : "") +
            styleNote,
    );
  } catch (exc) {
    opts.onError(exc instanceof Error ? exc.message : "拆解失败");
  }
}

/** 分镜表卡出图设置（ShotGenSettings 写入的数据，随卡持久化）：画幅 w:h、
 *  每镜候选张数、模型覆盖。批量出图/补缺图从这里取参 */
const ASPECT_OPTIONS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

/** 分镜卡出图设置 chip：{画幅}·{N张}，点开 popover 改画幅/候选/模型
 *  （模型缺省跟随项目级 store.imagegen，可本卡覆盖 data.gen）。
 *  资产设定图不开放画幅——幅面与四格/平铺布局契约绑定 */
function ShotGenSettings({ nodeId }: { nodeId: string }) {
  const data = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId)?.data);
  const project = useCanvasStore((s) => s.imagegen);
  const { models } = useImageModels();
  const [open, setOpen] = useState(false);
  const aspect = String(data?.aspect ?? "").trim() || "16:9";
  const genCount = Math.max(1, Math.min(4, Number(data?.genCount) || 1));
  const cardGen = saneGen(data?.gen);
  const effective = cardGen ?? project;
  const option = findModelOption(effective.model, models);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  useDismissOnOutside(wrapRef, open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const pickModel = (modelId: string) => {
    const opt = findModelOption(modelId, models);
    useCanvasStore.getState().updateNodeData(nodeId, {
      gen: {
        model: modelId,
        resolution: opt?.resolutions.includes(effective.resolution)
          ? effective.resolution
          : (opt?.default_resolution ?? effective.resolution),
      },
    });
  };

  return (
    <span ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        data-tip={`本卡出图设置：画幅 ${aspect} · 每镜候选 ${genCount} 张 · 模型 ${
          cardGen ? (option?.label ?? effective.model) : `跟随项目（${option?.label ?? effective.model}）`
        }`}
        aria-label="本卡出图设置"
        className={`nodrag whitespace-nowrap rounded border bg-surface-1 px-1.5 py-0.5 text-text-2 transition-colors hover:border-accent hover:text-text ${
          cardGen ? "border-accent" : "border-hairline"
        }`}
        data-track="card.gen-settings"
  onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {aspect} · {genCount}张
      </button>
      {open ? (
        <span
          className="absolute bottom-full right-0 z-30 mb-1.5 block w-64 rounded-md border border-hairline bg-surface-1 p-2 text-left shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="block text-[10px] font-medium text-text-4">画幅（分镜图）</span>
          <span className="mt-1 flex flex-wrap gap-1">
            {ASPECT_OPTIONS.map((a) => (
              <button
                key={a}
                type="button"
                className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                  aspect === a
                    ? "border-accent bg-accent-dim text-text"
                    : "border-hairline text-text-3 hover:text-text"
                }`}
                onClick={() => useCanvasStore.getState().updateNodeData(nodeId, { aspect: a })}
              >
                {a}
              </button>
            ))}
          </span>
          <span className="mt-2 block text-[10px] font-medium text-text-4">每镜候选张数</span>
          <span className="mt-1 flex gap-1">
            {[1, 2, 4].map((n) => (
              <button
                key={n}
                type="button"
                className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                  genCount === n
                    ? "border-accent bg-accent-dim text-text"
                    : "border-hairline text-text-3 hover:text-text"
                }`}
                onClick={() =>
                  useCanvasStore.getState().updateNodeData(nodeId, { genCount: n })
                }
              >
                {n} 张
              </button>
            ))}
          </span>
          <span className="mt-2 block border-t border-hairline pt-1.5 text-[10px] font-medium text-text-4">
            出图模型
            {cardGen ? (
              <button
                type="button"
                className="ml-2 text-accent hover:underline"
                onClick={() =>
                  useCanvasStore.getState().updateNodeData(nodeId, { gen: undefined })
                }
              >
                回退跟随项目
              </button>
            ) : null}
          </span>
          <span className="mt-1 block max-h-32 space-y-0.5 overflow-y-auto">
            {models === null ? (
              <span className="block text-[10px] text-text-4">加载模型目录…</span>
            ) : (
              models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`block w-full rounded px-1.5 py-1 text-left transition-colors ${
                    m.id === effective.model ? "bg-accent-dim" : "hover:bg-surface-2"
                  }`}
                  onClick={() => pickModel(m.id)}
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

/** 批量出图单张结果回填：rid → 行的 imageNodeId 节点置 ready/error。 *  行数据读 live store（批量轮询与刷新恢复共用，防闭包过期）。
 *  候选变体（rid 带 #k 后缀，一镜多张）：成功图并入该行图卡的 imageUrls
 *  变体（主图取首张）；全部失败才置败——恢复轮询路径没有总量信息，
 *  按「来一张并一张」尽力聚合，与主动出图路径的精确聚合互不冲突 */
function applyShotImageItem(cardId: string, item: ShotImageResult) {
  const st = useCanvasStore.getState();
  const card = st.nodes.find((n) => n.id === cardId);
  const rows = (card?.data.rows as ShotRow[] | undefined) ?? [];
  const rowRid = item.rid.split("#")[0];
  const row = rows.find((r) => r.rid === rowRid);
  const targetId = row?.imageNodeId;
  if (!targetId || !st.nodes.some((n) => n.id === targetId)) return;
  if (!(item.ok && item.imageUrl)) {
    st.updateNodeData(targetId, { status: "error", errorMessage: item.error || "出图失败" });
    return;
  }
  const url = item.imageUrl;
  const node = st.nodes.find((n) => n.id === targetId);
  const prevUrls = node?.data.imageUrls ?? [];
  const merged = prevUrls.includes(url) ? prevUrls : [...prevUrls, url];
  st.updateNodeData(targetId, {
    status: "ready",
    imageUrl: node?.data.imageUrl || url,
    primaryIndex: node?.data.primaryIndex ?? 0,
    ...(merged.length > 1 ? { imageUrls: merged } : {}),
  });
}

/** agent 重启丢任务：把本卡所有停在 loading 的图卡置败（不静默悬挂）并清旗标 */
function failLoadingShotImages(cardId: string, message: string) {
  const st = useCanvasStore.getState();
  const card = st.nodes.find((n) => n.id === cardId);
  const rows = (card?.data.rows as ShotRow[] | undefined) ?? [];
  for (const r of rows) {
    if (!r.imageNodeId) continue;
    const n = st.nodes.find((x) => x.id === r.imageNodeId);
    if (n?.data.status === "loading")
      st.updateNodeData(r.imageNodeId, { status: "error", errorMessage: message });
  }
  st.updateNodeData(cardId, { imageJobId: undefined });
}

/** 执行成片卡合成：按 itemIds 顺序取连线视频源 → compose → 产物写回卡上
 *  （ComposeCard 按钮与分镜表「一键成片」共用） */
async function composeFromCard(composeId: string) {
  const st = useCanvasStore.getState();
  const card = st.nodes.find((n) => n.id === composeId);
  if (!card) return;
  const order = (card.data.itemIds as string[] | undefined) ?? [];
  const sources = st.edges
    .filter((e) => e.target === composeId)
    .map((e) => st.nodes.find((n) => n.id === e.source))
    .filter((n): n is WingNode => Boolean(n?.data.videoUrl));
  const items = [
    ...sources
      .filter((s) => order.includes(s.id))
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)),
    ...sources.filter((s) => !order.includes(s.id)),
  ];
  if (items.length === 0 || !st.projectId) {
    st.updateNodeData(composeId, {
      status: "error",
      errorMessage: st.projectId ? "没有可合成的视频源" : "无项目上下文，无法合成",
    });
    return;
  }
  st.updateNodeData(composeId, { status: "loading", errorMessage: undefined });
  const res = await composeVideos(st.projectId, items.map((s) => s.data.videoUrl as string));
  if (res?.url) st.updateNodeData(composeId, { videoUrl: res.url, status: "ready" });
  else st.updateNodeData(composeId, { status: "error", errorMessage: "合成失败（源文件不兼容或服务端异常），可重试" });
}

/** 补资产图：收集本卡（assetSource=sourceId）拆解出的缺设定图资产卡批量出图
 *  （novanova 资产批量范式）。画风闸内；返回 null=无缺图/用户取消，否则返回汇报文案 */
async function fillAssetImages(sourceId: string): Promise<string | null> {
  const st = useCanvasStore.getState();
  const projectStyle = st.projectStyle.trim();
  if (!projectStyle) {
    window.dispatchEvent(new CustomEvent(OPEN_STYLE_EVENT));
    return "未选画风：已在弹出的「项目画风」里，选好后再补资产图";
  }
  const targets = st.nodes.filter(
    (n) =>
      (n.data.assetSource === sourceId || !n.data.assetSource) &&
      ["character", "scene", "prop", "costume"].includes(String(n.data.nodeType)) &&
      (n.data.title as string)?.trim() &&
      (n.data.body as string)?.trim() &&
      !n.data.imageUrl &&
      n.data.status !== "loading",
  );
  if (targets.length === 0) return null;
  const ask =
    targets.length === 1
      ? `为「${targets[0].data.title}」补出设定图（消耗出图额度）？`
      : `将为 ${targets.length} 张缺图的资产卡批量出图（每张数十秒并消耗出图额度）。确认开始？`;
  if (!window.confirm(ask)) return null;
  const cst = useCanvasStore.getState();
  for (const n of targets) {
    cst.updateNodeData(n.id, { status: "loading", errorMessage: undefined });
  }
  try {
    const jobId = await startShotImageJob(
      targets.map((n) => {
        // 参考序列：资产卡上游连线卡（考据参考卡/设定图卡），带图才收。
        // 调研→采纳→连线后，补资产图自动带上参考（职责段按 refSource 分流）
        const refCards = st.edges
          .filter((e) => e.target === n.id)
          .map((e) => st.nodes.find((m) => m.id === e.source))
          .filter((m): m is WingNode => Boolean(m?.data.imageUrl))
          .slice(0, 4);
        return {
          rid: n.id,
          name: n.data.title as string,
          description: `${n.data.title}。${n.data.body}`,
          // 服饰卡的设定图按道具契约（4:3 单件）出图
          assetType:
            n.data.nodeType === "costume"
              ? "prop"
              : (n.data.nodeType as "character" | "scene" | "prop"),
          visualNotes: `全局视觉风格：${projectStyle}`,
          referenceImages: refCards.map((m) => m.data.imageUrl as string),
          referenceLabels: refCards.map((m) => ({
            type:
              m.data.refSource === "research"
                ? "reference"
                : String(m.data.nodeType),
            name: String(m.data.title || "参考"),
          })),
          // 卡片级模型/档位覆盖（PromptBar chips 写入的 data.gen）
          params: saneGen(n.data.gen) ?? undefined,
        };
      }),
    );
    const done: string[] = [];
    const failed: string[] = [];
    const outcome = await pollShotImageJob(jobId, (item) => {
      const ust = useCanvasStore.getState();
      const name =
        (targets.find((t) => t.id === item.rid)?.data.title as string) || item.rid;
      if (item.ok && item.imageUrl) {
        ust.updateNodeData(item.rid, { imageUrl: item.imageUrl, status: "ready" });
        done.push(name);
      } else {
        ust.updateNodeData(item.rid, {
          status: "error",
          errorMessage: item.error || "出图失败",
        });
        failed.push(name);
      }
    });
    if (outcome === "gone") {
      const ust = useCanvasStore.getState();
      for (const t of targets) {
        ust.updateNodeData(t.id, {
          status: "error",
          errorMessage: "出图任务已失效（agent 重启），请重试",
        });
      }
      return "出图任务已失效（agent 重启），请重试";
    }
    return `补资产图完成：成功 ${done.length} 张${
      failed.length > 0 ? `，失败 ${failed.length} 张（${failed.join("、")}，可在卡上重试）` : ""
    }`;
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : "批量出图失败";
    const ust = useCanvasStore.getState();
    for (const t of targets) {
      ust.updateNodeData(t.id, { status: "error", errorMessage: msg });
    }
    return msg;
  }
}

/** 本卡（assetSource=sourceId）拆解出的资产卡里缺设定图的张数（补资产图按钮的计数与显隐）。
 *  assetSource 为空的存量卡兜底计入，否则历史项目的补图/调研按钮永远不出现 */
function countAssetsMissingImage(nodes: WingNode[], sourceId: string): number {
  return nodes.filter(
    (n) =>
      (n.data.assetSource === sourceId || !n.data.assetSource) &&
      ["character", "scene", "prop", "costume"].includes(String(n.data.nodeType)) &&
      (n.data.title as string)?.trim() &&
      (n.data.body as string)?.trim() &&
      !n.data.imageUrl &&
      n.data.status !== "loading",
  ).length;
}

/**
 * 本卡拆出的「待调研」资产：尚无考据参考卡连线的资产卡（不论是否已有
 * 设定图——已出图的资产重出时同样要带参考）。assetSource 为空的存量卡
 * （旧版拆解/聊天建卡）兜底计入本卡，否则历史项目永远数出 0。
 */
function researchTargetsOf(
  nodes: WingNode[],
  edges: { target: string; source: string }[],
  sourceId: string,
): WingNode[] {
  const researchSources = new Set(
    nodes.filter((n) => n.data.refSource === "research").map((n) => n.id),
  );
  return nodes.filter(
    (n) =>
      (n.data.assetSource === sourceId || !n.data.assetSource) &&
      ["character", "scene", "prop", "costume"].includes(String(n.data.nodeType)) &&
      (n.data.title as string)?.trim() &&
      (n.data.body as string)?.trim() &&
      n.data.status !== "loading" &&
      !edges.some((e) => e.target === n.id && researchSources.has(e.source)),
  );
}

/**
 * 批量调研本卡拆出的缺参考资产（ScriptCard/ShotListCard「调研参考图」共用）：
 * 串行调研（AI 出词→双渠道→终选）。返回终态 job（供审阅面板打开）；
 * 用户取消/无目标/无 projectId 返回 null。
 */
/** 圈定本卡资产并发起批量调研：任务 id 锚进卡数据（refBatchJobId），进度与
 *  收尾（审阅面板）由 useBatchRefJob 续链——卡片移出视口被卸载/页面刷新都不丢。
 *  返回 null = 没有需要调研的资产（调用方提示）。失败 throw（调用方明报）。 */
async function startBatchResearchForCard(sourceId: string): Promise<string | null> {
  const st = useCanvasStore.getState();
  const projectId = st.projectId;
  if (!projectId) throw new Error("项目未保存：先等画布保存完成再调研");
  const targets = researchTargetsOf(st.nodes, st.edges, sourceId);
  if (targets.length === 0) return null;
  // 直接开跑（调研可中途放弃、号池按量计费，无需确认弹窗打断）
  const batchId = await startBatchRefResearch(
    projectId,
    targets.map((n) => ({
      nodeId: n.id,
      name: String(n.data.title),
      type: String(n.data.nodeType),
      description: `${n.data.title}。${String(n.data.body ?? "")}`.slice(0, 600),
    })),
  );
  st.updateNodeData(sourceId, { refBatchJobId: batchId });
  return batchId;
}

/** 分镜表卡：一张卡管整场戏（行=镜头，双击改格），支持拆解资产与镜头级批量出图 */
/** 分镜生成预期时长（秒）：45s 底 + 剧本每 40 字 1s（大输入→大 JSON 输出线性
 *  变慢），封顶 240s——按剧本字数动态估算，避免大剧本被 45s 静态预期误报"排队" */
function shotlistExpected(scriptLen: number): number {
  return Math.min(240, Math.max(45, Math.round(45 + scriptLen / 40)));
}

function ShotListCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const update = makeUpdater(id);
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  // 宫格大图合成中（纯前端 canvas，帧多时秒级）
  const [gridBusy, setGridBusy] = useState(false);
  // 生成已等秒数：驱动进度条与「排队较久」提示
  const [genSec, setGenSec] = useState(0);
  const [rowSeq, setRowSeq] = useState(0);
  const [imgGenerating, setImgGenerating] = useState(false);
  // 行选择：null = 全选（默认全选，取消勾选即收窄到子集）
  const [selRows, setSelRows] = useState<Set<string> | null>(null);
  // 行缩略图放大：url + 行号（点击行内大缩略图开灯箱）
  const [rowZoom, setRowZoom] = useState<{ url: string; seq: number } | null>(null);
  // 行列表滚动容器：加一行（按钮在顶部）后滚到新行
  const [fillingAssets, setFillingAssets] = useState(false);
  const rowsScrollRef = useRef<HTMLDivElement>(null);
  const [decomposing, setDecomposing] = useState(false);
  const [decomposeMsg, setDecomposeMsg] = useState("");
  const [researching, setResearching] = useState(false);
  const [researchMsg, setResearchMsg] = useState("");
  const [reviewBatch, setReviewBatch] = useState<BatchRefJob | null>(null);
  // 批量调研续链：锚在卡数据上，移出视口卸载/刷新后恢复进度与终态面板
  const refJob = useBatchRefJob(id);
  // 调研收尾（含跨卸载恢复到的终态）：清锚 + 弹审阅面板
  useEffect(() => {
    const j = refJob.job;
    if (!j || j.status === "running") return;
    useCanvasStore.getState().updateNodeData(id, { refBatchJobId: undefined });
    void (async () => {
      await Promise.resolve();
      setReviewBatch(j);
    })();
  }, [refJob.job, id]);
  // 续链查询失败（任务不存在等）：清锚 + 明报
  useEffect(() => {
    if (!refJob.error) return;
    useCanvasStore.getState().updateNodeData(id, { refBatchJobId: undefined });
    void (async () => {
      await Promise.resolve();
      setResearchMsg(refJob.error);
    })();
  }, [refJob.error, id]);
  // 行内 @引用候选：rid=正在输入的行，draft=@ 后的过滤词，
  // rect=输入框视口坐标（候选面板 portal 到 body，fixed 定位防滚动容器裁剪）
  const [mention, setMention] = useState<{
    rid: string;
    draft: string;
    rect: { left: number; top: number; bottom: number };
  } | null>(null);
  const projectStyle = useCanvasStore((s) => s.projectStyle);
  const lod = useLod();
  // 剧本卡「拆分镜表」的一次性远程触发（hook 须在 early return 之前）：
  // 剧本卡给本卡置位 autoGenerate 旗标 → 消费并走本卡 generate（带镜头数/
  // 风格/名单注入/refIds 绑定全套参数），避免跨卡直调的挂载时序问题。
  // generate 在 guard 之后定义，经 ref 间接引用；latest-ref 渲染期赋值是
  // 刻意模式（幂等、无渲染输出依赖），编译器规则按意图豁免
  const genRef = useRef<() => void>(() => {});
  // eslint-disable-next-line react-hooks/refs
  genRef.current = () => {
    update({ autoGenerate: undefined });
    void generate();
  };
  const autoGen = d?.autoGenerate === true;
  useEffect(() => {
    if (!autoGen) return;
    genRef.current();
  }, [autoGen]);
  // 断点恢复：imageJobId 还在卡上 = 上一批出图没收尾（出图中刷新/关标签过）。
  // 挂载后自动续轮询把结果收回来；agent 重启丢任务表（gone）→ 图卡置败不悬挂
  const imageJobId = d?.imageJobId as string | undefined;
  const resumeRef = useRef(false);
  useEffect(() => {
    if (!imageJobId || resumeRef.current || imgGenerating) return;
    resumeRef.current = true;
    setImgGenerating(true);
    void (async () => {
      const outcome = await pollShotImageJob(imageJobId, (item) =>
        applyShotImageItem(id, item),
      );
      if (outcome === "gone")
        failLoadingShotImages(id, "出图任务已失效（agent 重启），请重试失败镜头");
      else if (outcome === "timeout")
        failLoadingShotImages(id, "出图超时，请补缺图重试");
      useCanvasStore.getState().updateNodeData(id, { imageJobId: undefined });
      setImgGenerating(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageJobId, id]);
  // 生成等待计时：generating 期间每秒走表（归零在 generate() 启动时做）
  useEffect(() => {
    if (!generating) return;
    const t = setInterval(() => setGenSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [generating]);
  // 防御：异常数据不渲染（hooks 已在上，顺序稳定）
  if (!d || typeof d.nodeType !== "string") return null;
  const rows = d.rows ?? [];

  /** 生成来源：上游连线卡的正文（剧本优先），回落到本卡正文 */
  const scriptSource = (() => {
    const ups = edges
      .filter((e) => e.target === id)
      .map((e) => nodes.find((n) => n.id === e.source))
      .filter(
        (n): n is WingNode =>
          Boolean(
            n &&
              !["character", "scene", "prop", "costume"].includes(
                String(n.data.nodeType),
              ) &&
              (n.data.body ?? "").trim(),
          ),
      );
    const pick =
      ups.find((n) => n.data.nodeType === "script") ??
      ups.find((n) => n.data.nodeType === "note") ??
      ups[0];
    return pick ? (pick.data.body ?? "").trim() : (d.body ?? "").trim();
  })();
  // 进度条预期：随本次生成实际用的剧本长度伸缩
  const genExpected = shotlistExpected(scriptSource.length);

  /** 一键生成分镜（直连 langflow flow，不经聊天）：结果写回 rows */
  const generate = async () => {
    if (generating) return;
    if (!scriptSource) {
      setGenError("没有可拆的剧本正文：把剧本卡连线到本卡，或在本卡写正文");
      return;
    }
    setGenerating(true);
    setGenSec(0);
    setGenError("");
    try {
      const next = await generateShotlist(scriptSource, {
        // 项目画风打底 + 分镜表风格叠加
        visualStyle: [
          projectStyle.trim() ? `全局：${projectStyle.trim()}` : "",
          (d.visualStyle ?? "").trim(),
        ]
          .filter(Boolean)
          .join("；") || undefined,
        // 卡片级文本模型覆盖（chip 选择，空=跟随默认）
        model: (d.textModel ?? "").trim() || undefined,
        // 硬约束 + @引用名单（ai-moive-studio 范式）：分镜只用画布已有资产，
        // 行内提到它们时用 @名称
        assets: nodes
          .filter(
            (n) =>
              ["character", "scene", "prop", "costume"].includes(
                String(n.data.nodeType),
              ) && n.data.title,
          )
          .map((n) => ({
            type: String(n.data.nodeType),
            name: n.data.title as string,
          })),
      });
      if (next.length === 0) {
        setGenError("生成结果为空");
        return;
      }
      // 生成结果自动绑 refIds：flow 每行输出的 assets 名单（agent 已按名单
      // 校验过）+ 行内 @名称 与画布资产卡同名即绑定；assets 转完即弃不落库
      const titleToId = new Map(
        nodes
          .filter(
            (n) =>
              ["character", "scene", "prop", "costume"].includes(
                String(n.data.nodeType),
              ) && n.data.title,
          )
          .map((n) => [n.data.title as string, n.id]),
      );
      // @名称 后面直接跟正文（无分隔符），按最长前缀匹配资产名
      const bound = next.map((r) => {
        const action = r.action ?? "";
        const ids = new Set<string>();
        let i = action.indexOf("@");
        while (i !== -1) {
          for (const [t, nid] of titleToId) {
            if (t && action.startsWith(t, i + 1)) {
              ids.add(nid);
              i += t.length;
              break;
            }
          }
          i = action.indexOf("@", i + 1);
        }
        for (const name of r.assets ?? []) {
          const nid = titleToId.get(name);
          if (nid) ids.add(nid);
        }
        const rest = { ...r };
        delete rest.assets;
        return ids.size > 0 ? { ...rest, refIds: [...ids] } : rest;
      });
      update({ rows: bound, status: "ready" });
    } catch (exc) {
      setGenError(exc instanceof Error ? exc.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  };

  const setRow = (
    rid: string,
    patch: Partial<ShotRow>,
    opts?: NodeDataUpdateOpts,
  ) => {
    update(
      {
        rows: rows.map((r) => (r.rid === rid ? { ...r, ...patch } : r)),
      },
      opts,
    );
  };
  const addRow = () => {
    const n = rowSeq + 1;
    setRowSeq(n);
    update({
      rows: [...rows, { rid: `m${n}`, action: "" }],
    });
    // 加一行按钮在列表顶部，新行落在末尾：滚过去让结果可见
    requestAnimationFrame(() => {
      rowsScrollRef.current?.scrollTo({
        top: rowsScrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    });
  };
  const removeRow = (rid: string) => {
    update({ rows: rows.filter((r) => r.rid !== rid) });
  };

  /** 行引用资产 → 一致性参考描述（资产卡标题+设定节选） */
  const refNotesFor = (r: ShotRow) =>
    rowRefNodes(r)
      .map((n) => `【${n.data.title}】${(n.data.body ?? "").slice(0, CONTEXT_BODY_LIMIT)}`)
      .join("；");

  /** 选中 @候选：补全名称、写入结构化 refIds（改名不失联） */
  const pickMention = (rid: string, node: WingNode) => {
    const r = rows.find((x) => x.rid === rid);
    if (!r) return;
    const title = node.data.title as string;
    const action = r.action ?? "";
    const m = /@([^@\n]*)$/.exec(action);
    const next = (
      m ? action.slice(0, m.index) + `@${title} ` : `${action}@${title} `
    ).trimEnd();
    const refIds = Array.from(new Set([...(r.refIds ?? []), node.id]));
    setRow(rid, { action: `${next} `, refIds });
    setMention(null);
  };

  /** 行引用资产 → 设定图 URL（一致性锚点，直连出图时传给 flow 当参考图） */
  const refImagesFor = (r: ShotRow) =>
    rowRefNodes(r)
      .map((n) => (n?.data.imageUrl as string | undefined) ?? "")
      .filter(Boolean);

  /** 行出图提示词：最终提示词优先，否则按行字段合成（与 synthRow 同构，
   *  全局视觉风格收尾——novanova 八段式轻量版） */
  const composeRowPrompt = (r: ShotRow) => {
    if (r.finalPrompt?.trim()) return r.finalPrompt.trim();
    return composeShotPrompt(r, (d.visualStyle ?? "").trim());
  };

  /** 行引用解析 → 参考卡列表（共享解析器 shotRefs，与 sanitize 存量迁移
   *  同源；结构化 refIds 优先，文本 @名称 最长匹配兜底；行文字命中造型/
   *  服饰名时 Look 图替换定妆照——juben look 范式） */
  const rowRefNodes = (r: ShotRow) =>
    preferLookRefs(r, resolveRowRefIds(r, nodes, edges), nodes, edges)
      .map((nid) => nodes.find((n) => n.id === nid))
      .filter((n): n is WingNode => Boolean(n));

  /** 补资产图：本卡拆解出的缺图资产卡一键批量出图（画风闸内） */
  const fillAssets = async () => {
    if (fillingAssets) return;
    setFillingAssets(true);
    setDecomposeMsg("");
    try {
      const msg = await fillAssetImages(id);
      if (msg) setDecomposeMsg(msg);
    } finally {
      setFillingAssets(false);
    }
  };
  /** 拆解资产（novanova「分镜同时出资产清单」的独立化）：共享实现
   *  runAssetDecompose，锚点=本卡（资产组建在左侧） */
  const decompose = async () => {
    if (decomposing || !scriptSource) return;
    setDecomposing(true);
    setDecomposeMsg("");
    await runAssetDecompose({
      anchorId: id,
      scriptSource,
      model: (d.textModel ?? "").trim() || undefined,
      onMsg: setDecomposeMsg,
      onError: setGenError,
    });
    setDecomposing(false);
  };

  /** 批量调研：圈定本卡资产开跑，任务锚进卡数据（进度/收尾由 refJob 续链） */
  const researchRefs = async () => {
    if (researching || refJob.batchId) return;
    setResearching(true);
    setResearchMsg("");
    try {
      const batchId = await startBatchResearchForCard(id);
      if (!batchId) setResearchMsg("没有需要调研的资产（缺参考的资产为 0）");
    } catch (exc) {
      setResearchMsg(exc instanceof Error ? exc.message : "批量调研失败");
    } finally {
      setResearching(false);
    }
  };

  /** 批量物化镜头图（novanova 分镜视频的图片版）：选中行 → 画布右侧
   *  √n 列近似方阵网格建图片卡（已有关联卡则原卡重跑）+ 自动连线 + 直连
   *  imagegen flow 批量生成（并发 3，不经聊天 LLM），结果回填各节点。
   *  行缩略图读关联节点 */
  const genShotImages = async (targets: { row: ShotRow; seq: number }[]) => {
    if (imgGenerating || targets.length === 0) return;
    // 画风闸（juben 硬闸同款）：只认全局画风——风格唯一入口在底部坞「画风」，
    // 否则同批镜头图风格必然漂移；拦下同时自动弹出画风设定弹窗
    if (!projectStyle.trim()) {
      setGenError("未选画风：请在弹出的「项目画风」里设定，再出图");
      window.dispatchEvent(new CustomEvent(OPEN_STYLE_EVENT));
      return;
    }
    // 软闸（asset-first 守护）：无参考行将纯文生图、一致性打折；合并大额
    // 确认为一次弹窗。点名具体镜头（解析走 refIds + @名称 + 全名兜底全通道）；
    // 空镜/氛围镜头属合法场景，故警告不硬拦
    const unrefSeqs = targets
      .filter((t) => refImagesFor(t.row).length === 0)
      .map((t) => t.seq + 1);
    if (unrefSeqs.length > 0 || targets.length > 8) {
      const parts: string[] = [];
      if (unrefSeqs.length > 0) {
        const label =
          unrefSeqs.length <= 6
            ? unrefSeqs.map((s) => `镜${s}`).join("、")
            : `${unrefSeqs.slice(0, 6).map((s) => `镜${s}`).join("、")} 等 ${unrefSeqs.length} 镜`;
        parts.push(
          `${label}未引用已出图的资产设定图，将纯文生图、角色一致性打折（行内 @资产名 可绑定参考）`,
        );
      }
      if (targets.length > 8)
        parts.push(
          `将批量出图 ${targets.length} 张（每张需数十秒并消耗出图额度）`,
        );
      const ask =
        parts.join("；") +
        "。" +
        (unrefSeqs.length > 0
          ? "可先拆解资产并出设定图，或在行内 @资产名。仍要继续？"
          : "确认开始？");
      if (!window.confirm(ask)) return;
    }
    const st = useCanvasStore.getState();
    const src = st.nodes.find((n) => n.id === id);
    if (!src) return;
    setImgGenerating(true);
    // 网格锚点：整块区域 findFreePosition 避让已有卡，块内按 √n 取列数
    // 铺成近似方阵（固定双列在镜头多时纵向拉得过长；空位只是画布留白不可见）
    const abs = absolutePosition(st.nodes, src);
    const sz = nodeSize(src);
    const fp = NODE_FOOTPRINT.image;
    const colW = fp.w + 54;
    const rowH = fp.h + 54;
    const cols = Math.min(targets.length, Math.ceil(Math.sqrt(targets.length)));
    const origin = findFreePosition(st.nodes, { x: abs.x + sz.w + 80, y: abs.y }, {
      w: cols * colW - 54,
      h: Math.ceil(targets.length / cols) * rowH - 54,
    });
    const styleStack = [
      (d.visualStyle ?? "").trim() ? `分镜表风格：${(d.visualStyle ?? "").trim()}` : "",
      projectStyle.trim() ? `全局视觉风格：${projectStyle.trim()}` : "",
    ].filter(Boolean);
    // 本卡出图设置（ShotGenSettings 写入）：画幅/每镜候选张数/模型覆盖
    const aspect = (d.aspect ?? "").trim() || "16:9";
    const genCount = Math.max(1, Math.min(4, Number(d.genCount) || 1));
    const cardGen = saneGen(d.gen);
    const created: string[] = [];
    const jobs: { rid: string; nodeId: string }[] = [];
    const ridToNode = new Map<string, string>();
    // 参考落卡（open-ai-canvas「storyboard-asset-reference」范式）：行解析出的
    // 参考资产写进图卡 refIds 并逐个建「资产→镜头图」连线——画布可见派生关系，
    // 面板 chips（连线即引用）与重跑上下文随之自洽
    const edgeKeys = new Set(st.edges.map((e) => `${e.source}\u0000${e.target}`));
    for (let i = 0; i < targets.length; i++) {
      const { row } = targets[i];
      const refIds = preferLookRefs(
        row,
        resolveRowRefIds(row, st.nodes, st.edges),
        st.nodes,
        st.edges,
      );
      const connectRefs = (nid: string) => {
        for (const rid of refIds) {
          const key = `${rid}\u0000${nid}`;
          if (edgeKeys.has(key)) continue;
          edgeKeys.add(key);
          st.connect({ source: rid, target: nid });
        }
      };
      const existing = row.imageNodeId
        ? st.nodes.find((n) => n.id === row.imageNodeId)
        : null;
      if (existing) {
        // 原卡重跑：保留位置与连线；参考随本次行解析刷新（换参考清旧边不叠加）
        const staleIds = new Set<string>();
        for (const e of st.edges) {
          if (e.target !== existing.id || refIds.includes(e.source)) continue;
          const src = st.nodes.find((n) => n.id === e.source);
          if (
            !["character", "scene", "prop", "costume"].includes(
              String(src?.data.nodeType),
            )
          )
            continue;
          staleIds.add(e.id);
          edgeKeys.delete(`${e.source}\u0000${e.target}`);
        }
        if (staleIds.size > 0) useCanvasStore.getState().removeEdges([...staleIds]);
        useCanvasStore
          .getState()
          .updateNodeData(existing.id, { status: "loading", errorMessage: undefined, imageUrl: undefined, refIds });
        connectRefs(existing.id);
        jobs.push({ rid: row.rid, nodeId: existing.id });
        ridToNode.set(row.rid, existing.id);
        continue;
      }
      const col = i % cols;
      const gridRow = Math.floor(i / cols);
      const nid = st.addNode({
        position: { x: origin.x + col * colW, y: origin.y + gridRow * rowH },
        data: {
          nodeType: "image",
          title: `镜头 ${String(targets[i].seq + 1).padStart(2, "0")} 图`,
          body: row.action ?? "",
          status: "loading",
          styleSnapshot: styleStack.join("；"),
          ...(refIds.length > 0 ? { refIds } : {}),
        },
      });
      st.connect({ source: id, target: nid });
      connectRefs(nid);
      created.push(nid);
      jobs.push({ rid: row.rid, nodeId: nid });
      ridToNode.set(row.rid, nid);
    }
    // imageNodeId 回填一次性落 store（逐行 setRow 会相互覆盖）
    if (ridToNode.size > 0) {
      useCanvasStore.getState().updateNodeData(id, {
        rows: rows.map((r) =>
          ridToNode.has(r.rid) ? { ...r, imageNodeId: ridToNode.get(r.rid) } : r,
        ),
      });
    }
    st.selectNodes(jobs.map((j) => j.nodeId));
    if (created.length > 0) st.flashNodes(created);
    window.dispatchEvent(
      new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: jobs.map((j) => j.nodeId) } }),
    );
    try {
      // 每镜 genCount 张候选：rid 带 #k 后缀，全部完成后聚合成该行图卡的
      // 变体（imageUrls，主图取首张）——「一卡一图」画布语义不裂多卡。
      // 逐镜把实际发出的提示词与参考快照落图卡 genPrompt/genShot（novanova
      // final_prompt 落库范式）：重试/面板预填/复制用真实内容，不再只有
      // 一句行文案——批量链路的提示词从此不是黑箱
      const requests: ShotImageRequest[] = [];
      const snapshots = new Map<
        string,
        { genPrompt: string; genShot: NonNullable<WingNode["data"]["genShot"]> }
      >();
      for (const j of jobs) {
        const t = targets.find((x) => x.row.rid === j.rid)!;
        // 参考资产带图者才收：URL 与职责标签同源对齐（无图引用卡不占位）
        const refAssets = rowRefNodes(t.row).filter((n) =>
          Boolean(n.data.imageUrl),
        );
        // @ 是画布引用记号，出图模型不认识——剥成裸名字（juben 剥 []同款）
        const description = composeRowPrompt(t.row).replace(/@/g, "");
        const visualNotes = [refNotesFor(t.row), ...styleStack]
          .filter(Boolean)
          .join("；");
        const referenceImages = refAssets.map((n) => n.data.imageUrl as string);
        const referenceLabels = refAssets.map((n) => ({
          type: String(n.data.nodeType),
          name: String(n.data.title || "无题"),
        }));
        snapshots.set(j.rid, {
          genPrompt: description,
          genShot: {
            description,
            // 镜头剧照契约（flow 侧 shot 布局：有人物有剧情，区别于场景空镜）
            assetType: "shot",
            visualNotes,
            referenceImages,
            referenceLabels,
            aspect,
          },
        });
        for (let k = 0; k < genCount; k++) {
          requests.push({
            rid: genCount > 1 ? `${j.rid}#${k}` : j.rid,
            name: `镜头${t.seq + 1}`,
            description,
            assetType: "shot",
            visualNotes,
            referenceImages,
            referenceLabels,
            aspect,
          });
        }
      }
      const jobId = await startShotImageJob(requests, cardGen ?? undefined);
      for (const j of jobs) {
        const snap = snapshots.get(j.rid);
        if (snap) useCanvasStore.getState().updateNodeData(j.nodeId, snap);
      }
      // jobId 落卡：出图中刷新/关标签后挂载续轮询收尾（完事即清）
      useCanvasStore.getState().updateNodeData(id, { imageJobId: jobId });
      // 轮询任务：按镜聚合候选（张张计票，齐了才回填该行图卡）
      const agg = new Map<string, { urls: string[]; errors: string[] }>();
      const applyRow = (rowRid: string) => {
        const a = agg.get(rowRid);
        if (!a || a.urls.length + a.errors.length < genCount) return;
        const ust = useCanvasStore.getState();
        const nodeId = ridToNode.get(rowRid);
        if (!nodeId) return;
        if (a.urls.length === 0) {
          ust.updateNodeData(nodeId, {
            status: "error",
            errorMessage: a.errors[0] || "出图失败",
          });
          return;
        }
        ust.updateNodeData(nodeId, {
          status: "ready",
          imageUrl: a.urls[0],
          primaryIndex: 0,
          ...(a.urls.length > 1 ? { imageUrls: a.urls } : {}),
          ...(a.errors.length > 0
            ? { errorMessage: `${a.errors.length}/${genCount} 张候选失败` }
            : {}),
        });
      };
      const outcome = await pollShotImageJob(jobId, (item) => {
        const rowRid = item.rid.split("#")[0];
        const a = agg.get(rowRid) ?? { urls: [], errors: [] };
        agg.set(rowRid, a);
        if (item.ok && item.imageUrl) a.urls.push(item.imageUrl);
        else a.errors.push(item.error || "出图失败");
        applyRow(rowRid);
      });
      if (outcome === "gone")
        failLoadingShotImages(id, "出图任务已失效（agent 重启），请重试失败镜头");
      else if (outcome === "timeout")
        failLoadingShotImages(id, "出图超时（部分镜头可能仍在跑），可补缺图重试");
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : "批量出图失败";
      setGenError(msg);
      const ust = useCanvasStore.getState();
      for (const j of jobs) {
        ust.updateNodeData(j.nodeId, { status: "error", errorMessage: msg });
      }
    } finally {
      useCanvasStore.getState().updateNodeData(id, { imageJobId: undefined });
      setImgGenerating(false);
    }
  };

  /** 展开态切换（收起光影/音效/最终提示词等完整字段） */

  /** 按本行字段合成最终提示词（novanova 八段式的轻量版；已有则确认覆盖，
   *  与竞品一致：不自动联动，手动触发） */

  const copyRow = (rid: string) => {
    const i = rows.findIndex((r) => r.rid === rid);
    if (i === -1) return;
    const n = rowSeq + 1;
    setRowSeq(n);
    const copy: ShotRow = { ...rows[i], rid: `m${n}`, imageUrl: undefined };
    const next = [...rows];
    next.splice(i + 1, 0, copy);
    update({ rows: next });
  };

  const moveRow = (rid: string, dir: -1 | 1) => {
    const i = rows.findIndex((r) => r.rid === rid);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    update({ rows: next });
  };

  const missingAssetCount = countAssetsMissingImage(nodes, id);
  const researchCount = researchTargetsOf(nodes, edges, id).length;
  const totalDur = rows.reduce((sum, r) => {
    // LLM 可能返回数字型 duration（JSON 数值），String 化防 .match 崩渲染树
    const m = String(r.duration ?? "").match(/(\d+(?:\.\d+)?)/);
    return sum + (m ? parseFloat(m[1]) : 0);
  }, 0);

  // 可出图行（有画面描述或最终提示词）∩ 勾选行（null = 全选）
  const genableRows = rows.filter(
    (r) => r.finalPrompt?.trim() || (r.action ?? "").trim(),
  );
  const selectedGenRows =
    selRows === null ? genableRows : genableRows.filter((r) => selRows.has(r.rid));

  // 批次聚合：行的图卡实时状态汇总（批量出图/单镜重跑/刷新恢复共用一份数据）
  const imgAgg = (() => {
    let ready = 0;
    let loading = 0;
    let error = 0;
    for (const r of rows) {
      const n = r.imageNodeId ? nodes.find((x) => x.id === r.imageNodeId) : null;
      if (!n) continue;
      if (n.data.status === "loading") loading++;
      else if (n.data.status === "error") error++;
      else if (n.data.status === "ready") ready++;
    }
    return { ready, loading, error };
  })();
  // 缺图行 = 可出图但没图卡/图卡失败（补缺图一键只打这些，跳过已完成的）
  const missingRows = genableRows.filter((r) => {
    const n = r.imageNodeId ? nodes.find((x) => x.id === r.imageNodeId) : null;
    return !n || (n.data.status !== "ready" && n.data.status !== "loading");
  });
  // 相邻镜头视频（双向连线、有产物；成片卡除外），画布从左到右即镜头序
  const videoSources = (() => {
    const seen = new Set<string>();
    const out: { id: string; x: number; y: number }[] = [];
    for (const e of edges) {
      if (e.source !== id && e.target !== id) continue;
      const other = e.source === id ? e.target : e.source;
      if (seen.has(other)) continue;
      seen.add(other);
      const n = nodes.find((x) => x.id === other);
      if (!n || !n.data.videoUrl || n.data.nodeType === "compose") continue;
      out.push({ id: n.id, x: n.position.x, y: n.position.y });
    }
    return out.sort((a, b) => a.x - b.x || a.y - b.y);
  })();

  /** 一键成片：相邻镜头视频按画布从左到右 → 建/复用成片卡依序连线 → 立即合成
   *  （画布阅读序即镜头序，viedeo-workflow 同款；顺序可在成片卡里微调） */
  const composeShots = async () => {
    if (videoSources.length < 2) {
      setGenError("成片至少要 2 段镜头视频：把视频卡连到本卡（双向连线均可）再试");
      return;
    }
    const st = useCanvasStore.getState();
    // 相邻已有成片卡就复用，否则本卡右侧新建
    let composeId: string | null = null;
    for (const e of st.edges) {
      if (e.source !== id && e.target !== id) continue;
      const other = e.source === id ? e.target : e.source;
      const n = st.nodes.find((x) => x.id === other);
      if (n?.data.nodeType === "compose") {
        composeId = n.id;
        break;
      }
    }
    if (!composeId) {
      const created = createConnectedNode(id, "compose");
      if (!created) return;
      composeId = created;
    }
    const ordered = videoSources.map((v) => v.id);
    const cst = useCanvasStore.getState();
    for (const vid of ordered) {
      if (!cst.edges.some((e) => e.source === vid && e.target === composeId))
        cst.connect({ source: vid, target: composeId });
    }
    cst.updateNodeData(composeId, { itemIds: ordered });
    cst.selectNodes([composeId]);
    cst.flashNodes([composeId]);
    window.dispatchEvent(
      new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: [composeId] } }),
    );
    setGenError("");
    await composeFromCard(composeId);
  };

  /** 导出分镜表：txt/md 每镜一节，docx 横版表格（入口在底栏「导出」菜单） */
  const doExport = (format: ExportFormat) => {
    if (rows.length === 0) return;
    const title = (d.title || "").trim() || "分镜表";
    const style = (d.visualStyle ?? "").trim();
    if (format === "docx")
      void exportDocxFile(title, shotlistToDocxBlocks(title, rows, style), {
        landscape: true,
      });
    else if (format === "md")
      exportTextFile(title, shotlistToMarkdown(title, rows, style), "md");
    else exportTextFile(title, shotlistToText(title, rows, style), "txt");
  };

  /** 分镜帧合成宫格大图（P1-3 交付格式：帧编号+画面备注）。
   *  行图优先行内 imageUrl，物化节点行读节点实时主图 */
  const exportGrid = async () => {
    if (gridBusy) return;
    const st = useCanvasStore.getState();
    const frames = rows
      .map((r, i) => {
        const url =
          r.imageUrl ??
          (r.imageNodeId
            ? (st.nodes.find((n) => n.id === r.imageNodeId)?.data.imageUrl as
                | string
                | undefined)
            : undefined);
        return url
          ? {
              url,
              label: `镜${i + 1}`,
              note:
                (r.action ?? r.dialogue ?? "").replace(/\s+/g, " ").trim() ||
                undefined,
            }
          : null;
      })
      .filter((f): f is NonNullable<typeof f> => Boolean(f));
    if (frames.length === 0) return;
    setGridBusy(true);
    try {
      const blob = await mergeImagesToGrid(frames);
      downloadBlobFile(
        `${(d.title || "").trim() || "分镜表"}·宫格.png`,
        blob,
      );
    } catch (e) {
      showToast(
        `宫格导出失败${e instanceof Error && e.message ? `：${e.message}` : ""}`,
      );
    } finally {
      setGridBusy(false);
    }
  };

  return (
    <CardShell id={id} data={d} selected={selected}>
      {/* 深缩放（micro/nano）只留标题+统计概览：行编辑器是全画布最重的
          DOM（每行= chips×4 + Editable×3 + 缩略图 + 行操作×5），拉远看
          全图的平移/卸载成本主要就在这里 */}
      {lod === "full" ? (
      <>
      {/* 行编辑工具条（贴列表顶部）：加一行是编辑动作，跟着列表走 */}
      <div className="ws-detail nodrag nowheel mb-1 flex items-center">
        <button
          type="button"
          className="nodrag flex items-center gap-0.5 rounded border border-dashed border-hairline px-1.5 py-0.5 text-[10px] text-text-3 transition-colors hover:border-accent hover:text-text"
          onClick={(e) => {
            e.stopPropagation();
            addRow();
          }}
        >
          <Plus className="h-3 w-3" />
          加一行
        </button>
      </div>
      <div ref={rowsScrollRef} className="ws-detail nowheel min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-1">
          {rows.length === 0 ? (
            <p className="rounded-md border border-dashed border-hairline px-2 py-4 text-center text-[11px] text-text-4">
              从剧本卡「拆分镜表」生成、在下方对话框让 AI 写，或手动「加一行」
            </p>
          ) : null}
          {rows.map((r, i) => {
            const linked = r.imageNodeId
              ? nodes.find((n) => n.id === r.imageNodeId)
              : null;
            const rowImg =
              (r.imageUrl as string | undefined) ??
              (linked?.data.imageUrl as string | undefined);
            const thumbLoading = linked?.data.status === "loading";
            // 出图提示词预览：手写覆盖优先，否则按本行字段实时合成（改动字段即联动）
            const autoPrompt = composeShotPrompt(r, (d.visualStyle ?? "").trim());
            const overridden = (r.finalPrompt ?? "").trim() !== "";
            const thumbError = linked?.data.status === "error";
            return (
            <div
              key={r.rid}
              className="group/row relative rounded-md border border-hairline bg-surface-2/60 px-1 py-1"
            >
              <div className="flex items-start gap-1">
                {/* 左轨：勾选+序号在上（贴左），缩略图吊在其下 */}
                <div className="flex shrink-0 flex-col items-start gap-1">
                  <div className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      className="nodrag h-3 w-3 shrink-0 cursor-pointer accent-[var(--color-accent)]"
                      checked={selRows === null || selRows.has(r.rid)}
                      title="勾选参与批量出图"
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => {
                        setSelRows((cur) => {
                          const base = cur ?? new Set(rows.map((x) => x.rid));
                          const next = new Set(base);
                          if (next.has(r.rid)) next.delete(r.rid);
                          else next.add(r.rid);
                          return next;
                        });
                      }}
                    />
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-accent-dim text-[10px] font-semibold tabular-nums text-text">
                      {i + 1}
                    </span>
                  </div>
                  {rowImg ? (
                    <button
                      type="button"
                      data-tip="点击放大" aria-label="点击放大"
                      className="nodrag block"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRowZoom({ url: rowImg, seq: i });
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={assetThumbUrl(rowImg)}
                        alt=""
                        className="aspect-video w-28 cursor-zoom-in rounded border border-hairline object-cover"
                      />
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-tip={
                        thumbLoading
                          ? "正在出图…"
                          : thumbError
                            ? `出图失败：${(linked?.data.errorMessage as string) ?? "可重试"}`
                            : refImagesFor(r).length === 0
                              ? "为这个镜头出图。注意：此镜未引用已出图的资产设定图，将纯文生图、一致性弱（可先拆解资产并出图，或行内 @资产名）"
                              : "为这个镜头出图（出图卡自动摆到本卡右侧并连线）"
                      } aria-label={
                        thumbLoading
                          ? "正在出图…"
                          : thumbError
                            ? `出图失败：${(linked?.data.errorMessage as string) ?? "可重试"}`
                            : refImagesFor(r).length === 0
                              ? "为这个镜头出图。注意：此镜未引用已出图的资产设定图，将纯文生图、一致性弱（可先拆解资产并出图，或行内 @资产名）"
                              : "为这个镜头出图（出图卡自动摆到本卡右侧并连线）"
                      }
                      className={`nodrag flex aspect-video w-28 flex-col items-center justify-center gap-0.5 rounded border border-dashed transition-colors hover:border-accent hover:text-text-2 ${
                        thumbError
                          ? "border-danger/60 text-danger"
                          : "border-hairline text-text-4"
                      }`}
                      disabled={thumbLoading}
                      onClick={(e) => {
                        e.stopPropagation();
                        void genShotImages([{ row: r, seq: i }]);
                      }}
                    >
                      {thumbLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : thumbError ? (
                        <RefreshCw className="h-4 w-4" />
                      ) : (
                        <ImageIcon className="h-4 w-4" />
                      )}
                      <span className="text-[9px]">
                        {thumbLoading ? "出图中…" : thumbError ? "出图失败·重试" : "出图"}
                      </span>
                    </button>
                  )}
                </div>
                <div className="relative flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-1">
                    <ShotSelect label="景别" value={r.shotSize ?? ""} options={SHOT_SIZES} onSave={(v) => setRow(r.rid, { shotSize: v })} />
                    <ShotChip label="运镜" value={r.cameraMove ?? ""} onSave={(v, opts) => setRow(r.rid, { cameraMove: v }, opts)} />
                    <ShotChip label="时长" value={r.duration ?? ""} onSave={(v, opts) => setRow(r.rid, { duration: v }, opts)} />
                    <ShotChip label="光影" value={r.lighting ?? ""} onSave={(v, opts) => setRow(r.rid, { lighting: v }, opts)} />
                    <ShotChip label="音效" value={r.sound ?? ""} onSave={(v, opts) => setRow(r.rid, { sound: v }, opts)} />
                  </div>
                  <div className="flex items-start gap-1">
                    <span className="mt-0.5 w-7 shrink-0 text-[9px] leading-5 text-text-4">画面</span>
                    <Editable
                    value={r.action ?? ""}
                    onSave={(action, opts) => {
                      setRow(r.rid, { action }, opts);
                      // 光标感知：草稿 = 光标前最近 @ 到光标；草稿带空格即收起
                      const ta = document.activeElement as HTMLTextAreaElement | null;
                      const caret =
                        ta && ta.tagName === "TEXTAREA" ? ta.selectionStart : null;
                      const before = caret !== null ? action.slice(0, caret) : action;
                      const at = before.lastIndexOf("@");
                      if (at === -1) {
                        setMention(null);
                        return;
                      }
                      const draft = before.slice(at + 1);
                      if (draft.length > 0 && draft.trim() !== draft) {
                        setMention(null);
                        return;
                      }
                      if (!ta) {
                        setMention(null);
                        return;
                      }
                      const rect = ta.getBoundingClientRect();
                      setMention({
                        rid: r.rid,
                        draft,
                        rect: { left: rect.left, top: rect.top, bottom: rect.bottom },
                      });
                    }}
                    multiline
                    always
                    placeholder="画面描述（谁、在哪、做什么，@资产名 引用角色）"
                    className="min-w-0 flex-1 text-[11px] leading-relaxed text-text-2"
                  />
                  </div>
                  <div className="flex items-start gap-1">
                    <span className="mt-0.5 w-7 shrink-0 text-[9px] leading-5 text-text-4">旁白</span>
                    <Editable
                    value={r.dialogue ?? ""}
                    onSave={(dialogue, opts) => setRow(r.rid, { dialogue }, opts)}
                    multiline
                    always
                    placeholder="台词 / 旁白"
                    className="min-w-0 flex-1 border-l-2 border-hairline pl-1.5 text-[11px] italic leading-relaxed text-text-3"
                  />
                  </div>
                  {/* 出图提示词与画面/旁白同列对齐；未覆盖时显示按本行字段
                      自动合成的结果（等于自动值不落 finalPrompt，不留冗余覆盖） */}
                  <div className="flex items-start gap-1 rounded border border-hairline-soft bg-surface-2/40 p-1">
                    <span className="mt-0.5 w-7 shrink-0 text-[9px] leading-5 text-text-4">出图</span>
                    <Editable
                      value={r.finalPrompt ?? autoPrompt}
                      onSave={(finalPrompt, opts) =>
                        setRow(
                          r.rid,
                          {
                            finalPrompt:
                              finalPrompt.trim() && finalPrompt.trim() !== autoPrompt.trim()
                                ? finalPrompt
                                : undefined,
                          },
                          opts,
                        )
                      }
                      multiline
                      always
                      placeholder="出图提示词（默认按本行字段自动合成，可直接改）"
                      className="min-w-0 flex-1 text-[10px] leading-relaxed text-text-3"
                    />
                    {overridden ? (
                      <button
                        type="button"
                        data-tip="清除自定义，恢复按本行字段自动合成" aria-label="清除自定义，恢复按本行字段自动合成"
                        className="nodrag mt-0.5 shrink-0 text-text-4 transition-colors hover:text-accent"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRow(r.rid, { finalPrompt: undefined });
                        }}
                      >
                        <RotateCcw className="h-3 w-3" />
                      </button>
                    ) : null}
                  </div>
                </div>
                {/* 行动作浮层：hover 才现身（带底色压在内容上），不常驻占位——
                    曾因 opacity-0 常驻让每行右侧空出一条 ~100px 的死空间 */}
                <div className="absolute right-1 top-1 z-10 flex items-start gap-1 rounded border border-hairline bg-surface-1/95 p-0.5 shadow-sm opacity-0 transition-opacity group-hover/row:opacity-100">
                  <button
                    type="button"
                    data-tip={r.finalPrompt?.trim() ? "重新出图（用最终提示词）" : r.imageUrl ? "重新出图" : "出图"} aria-label={r.finalPrompt?.trim() ? "重新出图（用最终提示词）" : r.imageUrl ? "重新出图" : "出图"}
                    className="nodrag text-text-4 hover:text-accent"
                    onClick={(e) => {
                      e.stopPropagation();
                      void genShotImages([{ row: r, seq: i }]);
                    }}
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                  <button type="button" data-tip="复制此行（排到下一行，不带出图）" aria-label="复制此行（排到下一行，不带出图）" className="nodrag text-text-4 hover:text-text" onClick={(e) => { e.stopPropagation(); copyRow(r.rid); }}>
                    <Copy className="h-3 w-3" />
                  </button>
                  <button type="button" data-tip="上移" aria-label="上移" className="nodrag text-text-4 hover:text-text disabled:opacity-30" disabled={i === 0} onClick={(e) => { e.stopPropagation(); moveRow(r.rid, -1); }}>
                    <ChevronUp className="h-3 w-3" />
                  </button>
                  <button type="button" data-tip="下移" aria-label="下移" className="nodrag text-text-4 hover:text-text disabled:opacity-30" disabled={i === rows.length - 1} onClick={(e) => { e.stopPropagation(); moveRow(r.rid, 1); }}>
                    <ChevronDown className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    data-tip="删除此行" aria-label="删除此行"
                    className="nodrag text-text-4 hover:text-danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRow(r.rid);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            </div>
            );
          })}
        </div>
      </div>
      </>
      ) : null}
      {rowZoom ? (
        <Lightbox
          images={[{ src: rowZoom.url, title: `镜头 ${rowZoom.seq + 1}` }]}
          index={0}
          onIndex={() => undefined}
          onClose={() => setRowZoom(null)}
        />
      ) : null}
      {generating ? (
        <div className="ws-detail nodrag nowheel mt-1.5 rounded-md border border-hairline-soft bg-surface-2/50 px-1.5 py-1.5 text-[10px] text-text-3">
          <div className="flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent" />
            <span className="shrink-0 tabular-nums">
              {genSec > genExpected * 1.5
                ? `生成较慢 · 已等 ${genSec}s（大剧本通常需要几分钟）`
                : `分镜生成中 · ${genSec}s`}
            </span>
          </div>
          <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-hairline-soft">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-1000 ease-linear"
              style={{
                width: `${Math.min(95, Math.round((genSec / genExpected) * 100))}%`,
              }}
            />
          </div>
        </div>
      ) : null}
      {decomposeMsg ? (
        <p className="ws-detail mt-1 text-[10px] text-text-3">{decomposeMsg}</p>
      ) : null}
      {researchMsg ? (
        <p className="ws-detail mt-1 text-[10px] text-text-3">{researchMsg}</p>
      ) : null}
      {genError ? (
        <p className="ws-detail mt-1 text-[10px] text-danger">{genError}</p>
      ) : null}
      {reviewBatch ? (
        <RefReviewDialog
          projectId={useCanvasStore.getState().projectId ?? ""}
          batch={reviewBatch}
          onClose={() => setReviewBatch(null)}
        />
      ) : null}
      {/* 深缩放底栏只留统计概览（行操作/管线动作需拉近再用） */}
      {lod !== "full" ? (
        <p className="mt-1.5 flex items-center gap-1 border-t border-hairline pt-1.5 text-[10px] tabular-nums text-text-4">
          {generating ? (
            <Loader2 className="h-3 w-3 shrink-0 motion-safe:animate-spin text-accent" />
          ) : null}
          {rows.length} 镜
          {refJob.running && refJob.job
            ? ` · 调研中 ${refJob.job.done}/${refJob.job.total}`
            : ""}
          {imgAgg.ready + imgAgg.loading + imgAgg.error > 0
            ? ` · 已出图 ${imgAgg.ready}${
                imgAgg.loading > 0 ? ` · 出图中 ${imgAgg.loading}` : ""
              }${imgAgg.error > 0 ? ` · 失败 ${imgAgg.error}` : ""}`
            : ""}
        </p>
      ) : (
      <>
      {/* 底栏 = 统计 + 行操作 + 管线动作（左→右即管线顺序：拆解资产 → 出图；
          出图降级样式+无参考行/大额确认防误触） */}
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1 border-t border-hairline pt-1.5 text-[10px] text-text-4">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate">
            {rows.length} 镜 · 总时长约 {totalDur > 0 ? `${Math.round(totalDur * 10) / 10}s` : "—"}
            {imgAgg.ready + imgAgg.loading + imgAgg.error > 0 ? (
              <>
                {" · "}
                已出图 {imgAgg.ready}
                {imgAgg.loading > 0 ? ` · 出图中 ${imgAgg.loading}` : ""}
                {imgAgg.error > 0 ? (
                  <span className="text-danger"> · 失败 {imgAgg.error}</span>
                ) : null}
              </>
            ) : null}
          </span>
          <ExportMenuButton
            onExport={doExport}
            disabled={rows.length === 0}
            track="shotlist"
          />
          <button
            type="button"
            data-tip="分镜帧合成宫格大图（帧编号+画面备注）" aria-label="分镜帧合成宫格大图"
            disabled={gridBusy || !rows.some((r) => r.imageUrl || r.imageNodeId)}
            data-track="shotlist.grid-export"
            className="flex items-center gap-0.5 rounded px-1 py-0.5 transition-colors hover:text-text disabled:opacity-40"
            onClick={(e) => {
              e.stopPropagation();
              void exportGrid();
            }}
          >
            {gridBusy ? (
              <Loader2 className="h-3 w-3 motion-safe:animate-spin" />
            ) : (
              <Grid3X3 className="h-3 w-3" />
            )}
            宫格图
          </button>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <label
            className="flex cursor-pointer items-center gap-1 transition-colors hover:text-text"
            title={selRows === null ? "全选（取消勾选可自选行）" : "全选"}
          >
            <input
              type="checkbox"
              checked={selRows === null}
              className="nodrag h-3 w-3 cursor-pointer accent-[var(--color-accent)]"
              onChange={() => setSelRows((cur) => (cur === null ? new Set<string>() : null))}
            />
            全选
          </label>
          <span className="mx-0.5 h-3.5 w-px bg-hairline" />
          <button
            type="button"
            disabled={decomposing || !scriptSource}
            data-tip="用拆解技能从剧本提取角色/场景/道具/服饰 → 自动分组建卡（只建卡不出图）。出分镜图前建议先调研参考图再补资产图，一致性最好" aria-label="用拆解技能从剧本提取角色/场景/道具/服饰 → 自动分组建卡（只建卡不出图）"
            className="nodrag shrink-0 rounded border border-hairline bg-surface-1 px-1.5 py-0.5 text-text-2 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            data-track="script.decompose"
  onClick={(e) => {
              e.stopPropagation();
              void decompose();
            }}
          >
            {decomposing ? "拆解中…" : "拆解资产"}
          </button>
            {researchCount > 0 ? (
              <button
                type="button"
                disabled={!scriptSource || researching || !!refJob.batchId}
                data-tip="为缺参考的资产批量搜网络考据图（AI 出词→Google 搜索（Serper 号池）→模型终选），完成后逐资产勾选采纳；真实类题材建议先调研再补图" aria-label="批量调研参考图"
                className="nodrag shrink-0 rounded border border-hairline bg-surface-1 px-1.5 py-0.5 text-text-2 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                data-track="card.batch-research"
  onClick={(e) => {
                  e.stopPropagation();
                  void researchRefs();
                }}
              >
                {researching || refJob.batchId
                  ? refJob.running && refJob.job
                    ? `调研中 ${refJob.job.done}/${refJob.job.total}`
                    : "调研中…"
                  : `调研参考图·${researchCount}`}
              </button>
            ) : null}
            {missingAssetCount > 0 ? (
              <button
                type="button"
                disabled={!scriptSource || fillingAssets}
                data-tip="为本卡拆解出的缺设定图资产卡批量出图（按卡上设定正文，画风闸内）" aria-label="为本卡拆解出的缺设定图资产卡批量出图（按卡上设定正文，画风闸内）"
                className="nodrag shrink-0 rounded border border-hairline bg-surface-1 px-1.5 py-0.5 text-text-2 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                onClick={(e) => {
                  e.stopPropagation();
                  void fillAssets();
                }}
              >
                {fillingAssets ? "补图中…" : `补资产图·${missingAssetCount}`}
              </button>
            ) : null}
          <ShotGenSettings nodeId={id} />
          <button
            type="button"
            disabled={imgGenerating || selectedGenRows.length === 0}
            data-tip="勾选行批量出图：每镜一张图片卡，自动摆到本卡右侧并连线（直连出图，不经聊天）。消耗出图额度；无参考行会先确认" aria-label="勾选行批量出图：每镜一张图片卡，自动摆到本卡右侧并连线（直连出图，不经聊天）。消耗出图额度；无参考行会先确认"
            className="nodrag shrink-0 rounded border border-accent bg-accent-dim px-1.5 py-0.5 font-medium text-text transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:border-hairline disabled:bg-surface-2 disabled:text-text-4"
            data-track="shotlist.batch-images"
  onClick={(e) => {
              e.stopPropagation();
              void genShotImages(selectedGenRows.map((row) => ({ row, seq: rows.indexOf(row) })));
            }}
          >
            {imgGenerating ? "出图中…" : `出图·${selectedGenRows.length} 镜`}
          </button>
          {missingRows.length > 0 ? (
            <button
              type="button"
              disabled={imgGenerating}
              data-tip={`为还没出图/出图失败的 ${missingRows.length} 镜补图（自动跳过已完成的镜）`} aria-label={`为还没出图/出图失败的 ${missingRows.length} 镜补图（自动跳过已完成的镜）`}
              className="nodrag shrink-0 rounded border border-hairline bg-surface-1 px-1.5 py-0.5 text-text-2 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
              onClick={(e) => {
                e.stopPropagation();
                void genShotImages(missingRows.map((row) => ({ row, seq: rows.indexOf(row) })));
              }}
            >
              补缺图·{missingRows.length}
            </button>
          ) : null}
          <button
            type="button"
            disabled={videoSources.length < 2}
            data-tip="把与本卡连线的镜头视频按画布从左到右拼接成片：自动建/复用成片卡、依序连线并合成（顺序可在成片卡里微调）" aria-label="把与本卡连线的镜头视频按画布从左到右拼接成片：自动建/复用成片卡、依序连线并合成（顺序可在成片卡里微调）"
            className="nodrag shrink-0 rounded border border-hairline bg-surface-1 px-1.5 py-0.5 text-text-2 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            data-track="compose.one-click"
  onClick={(e) => {
              e.stopPropagation();
              void composeShots();
            }}
          >
            <Combine className="mr-0.5 inline h-3 w-3 align-[-1px]" />
            成片
          </button>
        </span>
      </div>
      </>
      )}

      {mention
        ? createPortal(
            <div
              className="nodrag nowheel fixed z-50 max-h-52 w-64 overflow-auto rounded-md border border-hairline bg-surface-1 p-1 shadow-lg"
              style={{ left: mention.rect.left, top: mention.rect.bottom + 4 }}
            >
              <p className="px-1.5 py-0.5 text-[9px] text-text-4">引用资产卡</p>
              {(() => {
                const cands = nodes.filter(
                  (n) =>
                    (["character", "scene", "prop", "costume"].includes(
                      String(n.data.nodeType),
                    ) ||
                      isLookCard(n, nodes, edges)) &&
                    n.data.title &&
                    (n.data.title as string).includes(mention.draft),
                );
                if (cands.length === 0)
                  return (
                    <p className="px-1.5 py-1 text-[10px] text-text-4">
                      没有匹配的资产卡
                    </p>
                  );
                return cands.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className="nodrag flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[10px] text-text-2 transition-colors hover:bg-surface-2"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      pickMention(mention.rid, n);
                    }}
                  >
                    {n.data.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={assetThumbUrl(n.data.imageUrl)}
                        alt=""
                        className="h-6 w-8 rounded bg-surface-2 object-contain"
                      />
                    ) : (
                      <span className="grid h-6 w-8 place-items-center rounded bg-surface-2 text-[8px] text-text-4">
                        {NODE_META[n.data.nodeType]?.label ?? "?"}
                      </span>
                    )}
                    <span className="truncate">{n.data.title}</span>
                  </button>
                ));
              })()}
            </div>,
            document.body,
          )
        : null}
    </CardShell>
  );
}

/** 调研卡：深度调研任务的画布锚点。卡面是任务实况的只读视图（进度/卷宗摘要/
 * 计数），真相在 agent research_jobs 表，凭 researchId 轮询；读卷宗进
 * ResearchReader（「看图干活进大图」同哲学——卡是句柄，长文进灯箱） */
function ResearchCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const projectId = useCanvasStore((s) => s.projectId);
  const [job, setJob] = useState<ResearchJob | null>(null);
  const [readerOpen, setReaderOpen] = useState(false);
  const researchId = d.researchId ?? "";
  const lod = useLod();

  // 轮询：运行中 4s，终态后停（首次终态多取一次即止）
  useEffect(() => {
    if (!projectId || !researchId) return;
    let dead = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const j = await getResearch(projectId, researchId);
        if (dead) return;
        setJob(j);
        if (j.status === "running" || j.status === "planning") {
          timer = window.setTimeout(() => void tick(), 4000);
        }
      } catch {
        if (!dead) timer = window.setTimeout(() => void tick(), 8000);
      }
    };
    void tick();
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, researchId]);

  if (!d || typeof d.nodeType !== "string") return null;
  const status = job?.status;
  return (
    <CardShell id={id} data={d} selected={selected}>
      {lod === "full" ? (
        <>
          {/* 状态行 */}
          <div className="mt-1 flex items-center gap-1.5 text-[10px]">
            {status ? (
              <>
                <span
                  className={`inline-flex h-1.5 w-1.5 rounded-full ${
                    status === "running" ? "animate-pulse" : ""
                  }`}
                  style={{
                    background:
                      status === "done"
                        ? "var(--color-good)"
                        : status === "error"
                          ? "var(--color-danger)"
                          : status === "running"
                            ? "var(--color-accent)"
                            : "var(--color-warn)",
                  }}
                />
                <span className="text-text-3">
                  {RESEARCH_STATUS_LABEL[status]}
                  {status === "running" && job?.stage
                    ? ` · ${RESEARCH_STAGE_LABEL[job.stage] || job.stage}（第 ${job.roundsDone}/${job.roundsTotal} 轮）`
                    : ""}
                  {job?.depth ? ` · ${RESEARCH_DEPTH_LABEL[job.depth]}` : ""}
                </span>
                {job ? (
                  <span className="ml-auto tabular-nums text-text-4">
                    源 {job.sourcesCount} · 事实 {job.findingsCount}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-text-4">…</span>
            )}
          </div>
          {/* 卷宗摘要 / 开题方向 / 错误 */}
          {job?.dossier ? (
            <p className="ws-detail mt-1.5 line-clamp-4 text-[10px] leading-relaxed text-text-3">
              <span className="font-medium text-text">{job.dossier.headline}</span>
              {"　"}
              {job.dossier.summary}
            </p>
          ) : status === "error" || status === "interrupted" ? (
            <p className="ws-detail mt-1.5 line-clamp-2 text-[10px] leading-relaxed text-danger">
              {job?.error || "已中断（可补研续跑）"}
            </p>
          ) : status === "planning" && job?.plan ? (
            <p className="ws-detail mt-1.5 line-clamp-2 text-[10px] leading-relaxed text-text-3">
              开题：{job.plan.viewingQuestion}（{job.plan.directions.length} 个方向待确认）
            </p>
          ) : null}
          {/* 动作 */}
          <div className="mt-1.5 flex items-center gap-1">
            <button
              type="button"
              className="nodrag flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-accent transition-colors hover:bg-surface-2"
              data-tip="打开调研卷宗" aria-label="打开调研卷宗"
              onClick={(e) => {
                e.stopPropagation();
                if (projectId && researchId) setReaderOpen(true);
              }}
            >
              <BookOpen className="h-3 w-3" />
              卷宗
            </button>
          </div>
          {readerOpen && projectId && researchId ? (
            <ResearchReader
              projectId={projectId}
              researchId={researchId}
              onClose={() => setReaderOpen(false)}
            />
          ) : null}
        </>
      ) : null}
    </CardShell>
  );
}

export const nodeTypes = {
  note: memo(NoteCard),
  script: memo(ScriptCard),
  character: memo(AssetCard),
  scene: memo(AssetCard),
  prop: memo(AssetCard),
  costume: memo(AssetCard),
  image: memo(ImageCard),
  video: memo(VideoCard),
  audio: memo(AudioCard),
  compose: memo(ComposeCard),
  storyboard: memo(StoryboardCard),
  shotlist: memo(ShotListCard),
  research: memo(ResearchCard),
  group: memo(GroupCard),
};
