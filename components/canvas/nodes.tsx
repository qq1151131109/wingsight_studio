"use client";

import {
  Fragment,
  memo,
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
  type NodeProps,
} from "@xyflow/react";
import {
  Brush,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Combine,
  Copy,
  Download,
  Drama,
  Film,
  Sparkles,
  Grid3X3,
  History,
  Image as ImageIcon,
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
  Shirt,
  Trash2,
  Upload,
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
  type ShotRow,
  type WingNode,
  type WingNodeData,
  type WingNodeType,
} from "@/lib/canvas/store";
import { TYPE_ICONS } from "@/lib/canvas/type-icons";
import {
  dispatchFocusEdit,
  FOCUS_EDIT_EVENT,
  FOCUS_NODES_EVENT,
  FRAME_ANALYSIS_EVENT,
  NODE_INFO_EVENT,
  type FocusEditDetail,
  type NodeInfoDetail,
} from "@/lib/canvas/events";
import { GENERATE_EVENT, type GenerateDetail } from "./PromptBar";
import { Lightbox } from "./Lightbox";
import { createPortal } from "react-dom";
import OverlayModal from "./OverlayModal";
import { composeVideos, uploadAsset } from "@/lib/projects";
import {
  decomposeAssets,
  generateShotlist,
  getShotImageJob,
  startCharacterImageJob,
  startShotImageJob,
  ShotJobGoneError,
  type DecomposedLook,
  type ShotImageResult,
} from "@/lib/shotlist";
import VersionHistoryModal from "./NodeMediaHistory";
import MaskEditDialog from "./MaskEditDialog";

/** 重试生成事件：image 卡 error 态发出，CanvasAgentBridge 监听并转成聊天指令 */
export const RETRY_GENERATION_EVENT = "wingsight:retry-generation";

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
    data: { nodeType: type, title: NODE_META[type].hint, body: "" },
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
    data: { nodeType: type, title: NODE_META[type].hint, body: "" },
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

/** 悬浮工具条按钮（选中节点上方浮现的常用操作，libtv 范式） */
function ToolBtn({
  title,
  danger,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={`grid h-6 w-6 place-items-center rounded-md transition-colors hover:bg-surface-2 ${
        danger
          ? "text-text-3 hover:bg-danger/10 hover:text-danger"
          : "text-text-3 hover:text-text"
      }`}
    >
      {children}
    </button>
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
  // LOD：低缩放时只留标题（布尔选择器，只有跨阈值才触发重渲）
  const tiny = useCanvasStore((s) => s.viewport.zoom < 0.5);
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
        keepAspectRatio={aspect}
        handleClassName="ws-resize-handle"
        lineClassName="ws-resize-line"
      />
      {/* 悬浮工具条（libtv 范式）：选中即在卡上方浮现常用操作，更多动作在右键菜单。
          offset 36：越过卡外标题行，不压住标题 */}
      <NodeToolbar isVisible={selected && !tiny} position={Position.Top} offset={36}>
        <div className="flex items-center gap-0.5 rounded-lg border border-hairline bg-surface-1 p-0.5 shadow-md">
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
        {locked ? (
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-2">
            {data.title || "（无标题）"}
          </span>
        ) : (
          <Editable
            value={data.title}
            onSave={(title) => update({ title })}
            placeholder="（无标题）"
            className="min-w-0 flex-1 truncate text-xs font-medium text-text-2"
          />
        )}
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
          title={playing ? "暂停" : "播放"}
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
  always,
}: {
  value: string;
  onSave: (next: string) => void;
  className?: string;
  multiline?: boolean;
  placeholder?: string;
  fill?: boolean;
  /** 远程聚焦信号：命令此块把焦点移入正文（agent 建卡通道） */
  editingOn?: boolean;
  /** 常驻编辑：不经过展示态，永远是输入框 */
  always?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // agent 建卡后的远程聚焦：常驻卡也要能被命令"光标就位"
  useEffect(() => {
    if (!editingOn) return;
    return focusWhenVisible(ref);
  }, [editingOn]);

  const commit = () => {
    setEditing(false);
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
        value={value}
        placeholder={placeholder}
        rows={multiline ? Math.min(10, Math.max(always ? 1 : 3, value.split("\n").length)) : 1}
        onBlur={commit}
        onChange={(e) => {
          // 实时写回（novanova 范式）：每击落 store，编辑中途点别处零丢失。
          // 代价：打字不进撤销栈（与竞品一致，⌘Z 仍可撤手势类操作）
          onSave(e.currentTarget.value);
        }}
        onClick={variant === "accent" ? (e) => e.stopPropagation() : undefined}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
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

  if (!editing) {
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

/** 节点数据更新器（普通函数，非 hook） */
function makeUpdater(id: string) {
  return (patch: Partial<WingNodeData>) =>
    useCanvasStore.getState().updateNodeData(id, patch);
}

/** 聚焦直到真正落位：xyflow 新节点首帧 visibility:hidden（等待测量），
 *  此窗口内 focus() 静默失败。逐帧重试（上限 20 帧），返回取消函数。 */
function focusWhenVisible(ref: React.RefObject<HTMLElement | null>) {
  let raf = 0;
  let tries = 0;
  const step = () => {
    const el = ref.current;
    if (!el) return;
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
        title={`以本文为提示词，右侧新建${label}卡并生成`}
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
  return (
    <CardShell id={id} data={data} selected={selected}>
      <div className="flex min-h-0 flex-1 flex-col">
        <Editable
          value={data.body ?? ""}
          onSave={(body) => update({ body })}
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
        </div>
      ) : null}
      {footer}
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
  const [decomposing, setDecomposing] = useState(false);
  const [decomposeMsg, setDecomposeMsg] = useState("");
  const [genError, setGenError] = useState("");
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

  /** 拆解资产：共享实现 runAssetDecompose，锚点=本卡（资产组建在左侧） */
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
    useCanvasStore.getState().updateNodeData(tid, { autoGenerate: true });
    window.dispatchEvent(
      new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: [tid] } }),
    );
  };

  const exportMd = () => {
    const text = freshBody();
    if (!text) return;
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(d.title || "剧本").slice(0, 40)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <TextCard
      data={d}
      id={id}
      selected={selected}
      editorial
      footer={
        <>
          <div className="ws-detail nodrag nowheel mt-1.5 flex items-center gap-1.5 rounded-md border border-hairline-soft bg-surface-2/50 px-1.5 py-1 text-[10px] text-text-3">
            <span
              className="min-w-0 shrink tabular-nums text-text-4"
              title={body.slice(0, 120)}
            >
              {body.length} 字
              {sceneCount > 0 ? ` · ${sceneCount} 场` : ""}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              disabled={empty}
              title="把剧本正文导出为 .md 文件"
              className="nodrag flex shrink-0 items-center gap-0.5 rounded border border-hairline px-1.5 py-0.5 text-text-3 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
              onClick={(e) => {
                e.stopPropagation();
                exportMd();
              }}
            >
              <Download className="h-3 w-3" />
              导出
            </button>
            <button
              type="button"
              disabled={empty || decomposing}
              title="用拆解技能从剧本提取角色/场景/道具 → 自动分组建卡在本卡左侧。出分镜图前先给资产出设定图，一致性最好"
              className="nodrag shrink-0 rounded border border-hairline bg-surface-1 px-1.5 py-0.5 text-text-2 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
              onClick={(e) => {
                e.stopPropagation();
                decompose();
              }}
            >
              {decomposing ? "拆解中…" : "拆解资产"}
            </button>
            <button
              type="button"
              disabled={empty}
              title="在本卡右侧新建分镜表卡并自动生成分镜（已连分镜表则重新生成）"
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
          {genError ? (
            <p className="ws-detail mt-1 text-[10px] text-danger">{genError}</p>
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

function AssetCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
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
  const fileRef = useRef<HTMLInputElement>(null);
  // 防御：异常数据不渲染（hooks 已在上，顺序稳定）
  if (!d || typeof d.nodeType !== "string") return null;

  /** AI 出主图（定妆照/概念图/设定图）：一张卡一张图。造型变体不再挂本卡
   *  （拆解自动出图链已物化成独立图片卡并连线），历史 looks 数据装载时迁移 */
  const genLook = async () => {
    if (imgJob) return;
    // 画风闸（juben image_style_required 同款）：设定图是全片一致性锚点，
    // 无画风出图 = 风格随机漂移，拦下并引导底部坞
    if (!projectStyle.trim()) {
      setStyleHint("未选画风：请先在底部坞「画风」选项目画风，再 AI 出图");
      return;
    }
    setStyleHint("");
    update({ status: "loading", errorMessage: undefined });
    setImgJob(true);
    try {
      const jobId = await startCharacterImageJob({
        rid: id,
        name: d.title || "资产",
        description: `${d.title || ""}。${d.body ?? ""}`.trim(),
        // 服饰卡的设定图按道具契约（4:3 单件）出图
        assetType: kind === "costume" ? "prop" : kind,
        visualNotes: projectStyle ? `全局视觉风格：${projectStyle}` : undefined,
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
          update({ imageUrl: item.imageUrl, status: "ready", styleSnapshot: usedStyle });
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
        if (url) update({ imageUrl: url });
      } finally {
        setUploading(false);
      }
    })();
  };

  return (
    <CardShell id={id} data={d} selected={selected} aspect={Boolean(d.imageUrl)}>
      <div
        className={`ws-detail mt-1.5 flex min-h-40 w-full flex-1 items-center justify-center overflow-hidden rounded-md border border-hairline-soft bg-surface-2 ${
          d.status === "loading" ? "ws-loading-scan" : ""
        }`}
      >
        {d.status === "loading" ? (
          <GenProgress nodeId={id} expected={60} />
        ) : d.status === "error" ? (
          <RetryPanel nodeId={id} errorMessage={d.errorMessage} />
        ) : d.imageUrl ? (
          <div
            role="button"
            tabIndex={0}
            className="nodrag group relative h-full w-full cursor-zoom-in"
            onClick={(e) => {
              e.stopPropagation();
              setZoom(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") setZoom(true);
            }}
            title="点击放大"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={d.imageUrl}
              alt={d.title}
              className="ws-media-in h-full w-full object-contain"
              {...mediaDragProps(id)}
            />
            <CornerActions>
              <button
                type="button"
                title="AI 重新出设定图（用设定正文）"
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
                title={`更换${imgLabel}`}
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
            </CornerActions>
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
      {!d.imageUrl && d.status !== "loading" ? (
        <button
          type="button"
          disabled={imgJob}
          title={`按设定正文 AI 出${imgLabel}（直连出图，不经聊天）。需先在底部坞「画风」选项目画风`}
          className="nodrag mt-1.5 flex items-center justify-center gap-1 rounded-md border border-dashed border-hairline px-2 py-1 text-[10px] text-text-3 transition-colors hover:border-accent hover:text-text disabled:opacity-40"
          onClick={(e) => {
            e.stopPropagation();
            void genLook();
          }}
        >
          <Sparkles className="h-3 w-3" />
          {imgJob ? "生成中…" : "AI 出图（按设定正文）"}
        </button>
      ) : null}
      {styleHint ? (
        <p className="ws-detail mt-1 text-[10px] text-warn">{styleHint}</p>
      ) : null}
      <Editable
        value={d.body ?? ""}
        onSave={(body) => update({ body })}
        multiline
        always
        placeholder={ASSET_BODY_PH[kind]}
        className="ws-detail mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-text-2"
      />
      {zoom && d.imageUrl ? (
        <Lightbox
          images={[{ src: d.imageUrl, title: d.title }]}
          index={0}
          onIndex={() => undefined}
          onClose={() => setZoom(false)}
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
  const update = makeUpdater(id);
  // 放大查看：进入时快照画布全部图片（可翻页）
  const [zoom, setZoom] = useState<number | null>(null);
  const [gallery, setGallery] = useState<{ src: string; title: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [maskOpen, setMaskOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // 防御：异常数据不渲染（hooks 已在上，顺序稳定）
  if (!d || typeof d.nodeType !== "string") return null;

  const openZoom = () => {
    const gal = useCanvasStore
      .getState()
      .nodes.filter((n) => n.data.nodeType === "image" && n.data.imageUrl)
      .map((n) => ({ src: n.data.imageUrl as string, title: n.data.title }));
    setGallery(gal);
    const idx = gal.findIndex((g) => g.src === d.imageUrl);
    setZoom(idx >= 0 ? idx : 0);
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || !f.type.startsWith("image/")) return;
    setUploading(true);
    void (async () => {
      try {
        const url = await uploadAsset(f, f.type, f.name);
        if (url) update({ imageUrl: url, status: "ready" });
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
        {d.status === "loading" ? (
          <GenProgress nodeId={id} expected={22} />
        ) : d.status === "error" ? (
          <RetryPanel nodeId={id} errorMessage={d.errorMessage} />
        ) : d.imageUrl ? (
          <div
            role="button"
            tabIndex={0}
            className="nodrag group relative h-full w-full cursor-zoom-in"
            onClick={(e) => {
              e.stopPropagation();
              openZoom();
            }}
            title="点击放大（可翻页）"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={d.imageUrl}
              alt={d.title}
              className="ws-media-in h-full w-full object-contain"
              {...mediaDragProps(id)}
            />
            {versionCount > 0 ? (
              <button
                type="button"
                title="版本历史（重生成前的结果自动存档）"
                className="absolute left-1.5 top-1.5 flex items-center gap-0.5 rounded-md bg-black/40 px-1 py-0.5 text-[10px] text-white opacity-0 transition-opacity hover:bg-black/60 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  setHistoryOpen(true);
                }}
              >
                <History className="h-3 w-3" />V{versionCount + 1}
              </button>
            ) : null}
            <CornerActions>
              <a
                href={d.imageUrl}
                download={downloadName(d.title, d.imageUrl, "png")}
                title="下载"
                className="rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                onClick={(e) => e.stopPropagation()}
              >
                <Download className="h-3.5 w-3.5" />
              </a>
              {d.body ? (
                <button
                  type="button"
                  title="复制提示词"
                  className="rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                  onClick={(e) => {
                    e.stopPropagation();
                    void navigator.clipboard
                      ?.writeText(d.body ?? "")
                      .catch(() => undefined);
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                title="标注重绘：涂出想改的区域让 AI 重绘"
                className="rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                onClick={(e) => {
                  e.stopPropagation();
                  setMaskOpen(true);
                }}
              >
                <Brush className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="九宫格切图：拆成 9 张卡"
                className="rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
                onClick={(e) => {
                  e.stopPropagation();
                  void splitImageToGrid(id, d.imageUrl!, d.title ?? "");
                }}
              >
                <Grid3X3 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="重新生成"
                className="rounded-md bg-black/40 p-1 text-white hover:bg-black/60"
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
              <span className="rounded-md bg-black/40 p-1 text-white">
                <ZoomIn className="h-3.5 w-3.5" />
              </span>
            </CornerActions>
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
      {candidates.length > 1 ? (
        <div className="ws-detail nowheel mt-1 flex items-center gap-1 overflow-x-auto">
          <span className="shrink-0 text-[9px] text-text-4">
            候选{candidates.length}
          </span>
          {candidates.map((u, i) => (
            <button
              key={`${u}_${i}`}
              type="button"
              title="设为主图"
              className={`shrink-0 overflow-hidden rounded border transition-colors ${
                u === d.imageUrl ? "border-accent" : "border-hairline-soft hover:border-accent-soft"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                update({ primaryIndex: i, imageUrl: u });
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="" className="h-9 w-9 object-cover" />
            </button>
          ))}
        </div>
      ) : null}
      {d.body ? (
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

/** 视频放大播放：点击遮罩或 Esc 关闭 */
function VideoLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
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
      <button
        type="button"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        onClick={onClose}
      >
        <X className="h-5 w-5" />
      </button>
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
  // 就绪后按选定帧数抽缩略图（异步；失败静默——跨域或解码不支持就不出条）
  useEffect(() => {
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
  }, [data, frameCount]);
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
                  title="版本历史（重生成前的结果自动存档）"
                  className="flex items-center gap-0.5 rounded-md bg-black/40 px-1 py-0.5 text-[10px] text-white hover:bg-black/60"
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
                title={analyzing ? "抽帧上传中…" : "AI 拉片：抽帧分析镜头语言"}
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
                title="放大播放"
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
      {d.body ? (
        <p className="ws-detail mt-1 line-clamp-2 whitespace-pre-wrap text-[10px] leading-relaxed text-text-3">
          {d.body}
        </p>
      ) : null}
      {/* 抽帧条：hover 某帧出"+图"，点击抽原生分辨率帧建连线图片卡；帧数可切换 */}
      {d.videoUrl && frames.length > 0 ? (
        <div className="ws-detail nowheel mt-1 flex items-center gap-1 overflow-x-auto">
          {[6, 12, 24].map((n) => (
            <button
              key={n}
              type="button"
              title={`抽 ${n} 帧`}
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
              title={`${f.t.toFixed(1)}s · 点击抽帧建图卡`}
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
      <div className="ws-detail mt-1.5 flex min-h-14 w-full flex-1 items-center justify-center rounded-md border border-hairline-soft bg-surface-2 px-2.5 py-1.5">
        {d.audioUrl ? (
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
      <Editable
        value={d.title}
        onSave={(title) => update({ title })}
        className="mt-1.5 line-clamp-1 text-xs font-medium text-text"
        placeholder="（无标题）"
      />
      {d.body ? (
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
          <video
            src={d.videoUrl}
            controls
            preload="metadata"
            playsInline
            className="nodrag nowheel ws-media-in h-full w-full bg-black object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : null}
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
              <button type="button" title="上移" disabled={i === 0}
                className="nodrag text-text-4 hover:text-text disabled:opacity-30"
                onClick={(e) => { e.stopPropagation(); move(i, -1); }}>
                <ChevronUp className="h-3 w-3" />
              </button>
              <button type="button" title="下移" disabled={i === items.length - 1}
                className="nodrag text-text-4 hover:text-text disabled:opacity-30"
                onClick={(e) => { e.stopPropagation(); move(i, 1); }}>
                <ChevronDown className="h-3 w-3" />
              </button>
              <button type="button" title="从合成移除（断开连线）"
                className="nodrag text-text-4 hover:text-danger"
                onClick={(e) => { e.stopPropagation(); removeSource(s.sid); }}>
                <X className="h-3 w-3" />
              </button>
            </div>
          ))
        )}
      </div>
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
      ) : (
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
      )}
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
  onSave: (v: string) => void;
}) {
  return (
    <span
      className={`inline-flex min-w-11 items-center gap-1 rounded border px-1 text-[10px] leading-4 ${
        accent
          ? "border-accent bg-accent-dim font-semibold tabular-nums text-text"
          : "border-hairline bg-surface-2 text-text-3"
      }`}
    >
      <span className={`shrink-0 ${accent ? "text-accent" : "text-text-4"}`}>{label}</span>
      <Editable
        value={value}
        onSave={onSave}
        always
        placeholder="—"
        className="max-w-32 text-text-2"
      />
    </span>
  );
}

/** 分镜卡：宽卡 + 镜号/景别/运镜/时长字段行 + 台词（导演台入口在右键菜单） */
function StoryboardCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const update = makeUpdater(id);
  if (!d || typeof d.nodeType !== "string") return null;
  return (
    <CardShell id={id} data={d} selected={selected}>
      <div className="ws-detail mt-1.5 flex flex-wrap gap-1">
        <ShotChip accent label="镜号" value={d.shotNumber ?? ""} onSave={(shotNumber) => update({ shotNumber })} />
        <ShotChip label="景别" value={d.shotSize ?? ""} onSave={(shotSize) => update({ shotSize })} />
        <ShotChip label="运镜" value={d.cameraMove ?? ""} onSave={(cameraMove) => update({ cameraMove })} />
        <ShotChip label="时长" value={d.duration ?? ""} onSave={(duration) => update({ duration })} />
      </div>
      <Editable
        value={d.body ?? ""}
        onSave={(body) => update({ body })}
        multiline
        always
        placeholder="画面描述（谁、在哪、做什么）"
        className="ws-detail nowheel mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-text-2"
      />
      <Editable
        value={d.dialogue ?? ""}
        onSave={(dialogue) => update({ dialogue })}
        multiline
        always
        placeholder="台词 / 旁白"
        className="ws-detail mt-1.5 line-clamp-2 border-l-2 border-hairline pl-1.5 text-xs italic leading-relaxed text-text-3"
      />
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
          title={collapsed ? "展开分组" : "折叠分组（隐藏子卡）"}
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
          onSave={(title) => update({ title })}
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
 *  全局视觉风格收尾（novanova visualStyle 段），供合成与批量出图共用 */
function composeShotPrompt(r: ShotRow, visualStyle: string): string {
  const seg = [
    `镜头规格：${r.shotSize || "中景"}，${r.duration || 5} 秒`,
    `画面内容：${r.action || "（无）"}`,
    r.lighting ? `光影氛围：${r.lighting}` : "",
    r.cameraMove ? `运镜：${r.cameraMove}` : "",
    `声音：${[r.dialogue, r.sound].filter(Boolean).join("；") || "无"}`,
    visualStyle ? `视觉风格：${visualStyle}` : "",
  ].filter(Boolean);
  return `${seg.join("。")}。`;
}

/** 拆解资产共享实现（ShotListCard 与 ScriptCard 的「拆解资产」都走这里）：
 *  直连拆解 flow，角色/场景/道具各成一个组框建在锚点卡左侧（同名跳过）。
 *  锚点是分镜表时才做遗留 分镜表→资产 边的翻转；内部自捕获异常并经 onError
 *  上报，永不 reject，调用方只需管 busy 态 */
async function runAssetDecompose(opts: {
  anchorId: string;
  scriptSource: string;
  onMsg: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { anchorId, scriptSource } = opts;
  try {
    const nodes = useCanvasStore.getState().nodes;
    // 画布已有资产名单喂给拆解 flow：同指资产沿用旧名（跨次拆解可去重合并）
    const existing = nodes
      .filter(
        (n) =>
          ["character", "scene", "prop", "costume"].includes(
            String(n.data.nodeType),
          ) && n.data.title,
      )
      .map((n) => ({ type: String(n.data.nodeType), name: n.data.title as string }));
    // 全自动（juben 范式）：拆解后 agent 直接跑角色出图链（定妆照→逐 Look），
    // 项目画风注入每张图；阶段进度经 onMsg 显示在卡上。
    // 画风闸：无全局画风时只拆文字不自动出图（与出图按钮同一道闸）
    const styleReady = Boolean(
      (useCanvasStore.getState().projectStyle ?? "").trim(),
    );
    const { assets, errors: decompErrors, imagesNote } = await decomposeAssets(
      scriptSource,
      existing,
      {
        autoLooks: styleReady,
        visualStyle: useCanvasStore.getState().projectStyle ?? "",
        onPhase: ({ phase, progress }) => {
          if (phase === "images" && progress?.total)
            opts.onMsg(`拆解完成，自动出图中 ${progress.done}/${progress.total}…`);
        },
      },
    );
    const styleNote = styleReady
      ? ""
      : "｜未选画风，未自动出图（底部坞「画风」选好后可在资产卡上单独出图）";
    const imageNote = imagesNote ? `｜${imagesNote}` : "";
    const chars = assets;
    if (chars.length === 0) {
      opts.onMsg("剧本里没拆出可用资产");
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
    // 资产卡放锚点卡左侧（推导方向：左入右出），组框贴着左缘往左排
    let groupRight = abs.x - 80;
    const anchorY = abs.y;
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
      if (fresh.length === 0) continue;
      kindCounts[type] = fresh.length;
      const fp = NODE_FOOTPRINT[type] ?? NODE_FOOTPRINT.note;
      const kcols = Math.min(2, fresh.length);
      const kw = kcols * (fp.w + 60) - 60;
      const kh = Math.ceil(fresh.length / kcols) * (fp.h + 54) - 54;
      const origin = findFreePosition(cur.nodes, { x: groupRight - kw, y: anchorY }, {
        w: kw,
        h: kh,
      });
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
      // 角色组框右侧竖排 Look 卡（findFreePosition 整块避让锚点卡等已有内容）
      for (const { charId, charName, looks } of lookJobs) {
        const st2 = useCanvasStore.getState();
        // 尺寸与普通图片卡一致（用户要求通用容器）：特殊小卡会让媒体区溢出卡体
        const lfp = NODE_FOOTPRINT.image;
        const lcols = Math.min(2, looks.length);
        const low = lcols * (lfp.w + 32) - 32;
        const loh = Math.ceil(looks.length / lcols) * (lfp.h + 32) - 32;
        const lorigin = findFreePosition(
          st2.nodes,
          { x: origin.x + kw + 64, y: anchorY },
          { w: low, h: loh },
        );
        looks.forEach((l, li) => {
          const st3 = useCanvasStore.getState();
          const lid = st3.addNode({
            position: {
              x: lorigin.x + (li % lcols) * (lfp.w + 32),
              y: lorigin.y + Math.floor(li / lcols) * (lfp.h + 32),
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
          // 只进 created（选中/闪烁用），不进 ids——ids 会成为角色组框的
          // 子节点（坐标转相对），Look 卡是画布层卡，不归组
          created.push(lid);
          lookEdges.push({ lookId: lid, costume: (l.costume ?? "").trim() });
        });
      }
      const gid = useCanvasStore.getState().groupNodes(ids, label);
      if (gid) groupIds.push(gid);
      created.push(...ids);
      groupRight = origin.x - 80;
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
      let groupRight2 = abs.x - 80;
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
        const kcols = Math.min(2, items.length);
        const kw = kcols * (fp.w + 60) - 60;
        const kh = Math.ceil(items.length / kcols) * (fp.h + 54) - 54;
        const origin = findFreePosition(cur.nodes, { x: groupRight2 - kw, y: anchorY }, {
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
        groupRight2 = origin.x - 80;
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

/** 轮询批量出图任务：每张完成即回调 onItem。返回 done/timeout/gone
 *  （gone=agent 重启丢内存任务表）。单次网络抖动不判死，超 deadline 才放弃。
 *  批量出图与刷新恢复共用 */
async function pollShotImageJob(
  jobId: string,
  onItem: (item: ShotImageResult) => void,
  deadlineMs = 10 * 60 * 1000,
): Promise<"done" | "timeout" | "gone"> {
  const deadline = Date.now() + deadlineMs;
  const applied = new Set<string>();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    let job;
    try {
      job = await getShotImageJob(jobId);
    } catch (exc) {
      if (exc instanceof ShotJobGoneError) return "gone";
      if (Date.now() > deadline) return "timeout";
      continue;
    }
    for (const item of job.images) {
      if (applied.has(item.rid) || (!item.ok && !item.error)) continue;
      applied.add(item.rid);
      onItem(item);
    }
    if (job.status === "done") return "done";
    if (Date.now() > deadline) return "timeout";
  }
}

/** 批量出图单张结果回填：rid → 行的 imageNodeId 节点置 ready/error。
 *  行数据读 live store（批量轮询与刷新恢复共用，防闭包过期） */
function applyShotImageItem(cardId: string, item: ShotImageResult) {
  const st = useCanvasStore.getState();
  const card = st.nodes.find((n) => n.id === cardId);
  const rows = (card?.data.rows as ShotRow[] | undefined) ?? [];
  const targetId = rows.find((r) => r.rid === item.rid)?.imageNodeId;
  if (!targetId || !st.nodes.some((n) => n.id === targetId)) return;
  st.updateNodeData(
    targetId,
    item.ok && item.imageUrl
      ? { imageUrl: item.imageUrl, status: "ready" }
      : { status: "error", errorMessage: item.error || "出图失败" },
  );
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

/** 分镜表卡：一张卡管整场戏（行=镜头，双击改格），支持拆解资产与镜头级批量出图 */
function ShotListCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const update = makeUpdater(id);
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const [rowSeq, setRowSeq] = useState(0);
  const [imgGenerating, setImgGenerating] = useState(false);
  // 行选择：null = 全选（默认全选，取消勾选即收窄到子集）
  const [selRows, setSelRows] = useState<Set<string> | null>(null);
  // 行列表滚动容器：加一行（按钮在顶部）后滚到新行
  const rowsScrollRef = useRef<HTMLDivElement>(null);
  const [decomposing, setDecomposing] = useState(false);
  const [decomposeMsg, setDecomposeMsg] = useState("");
  // 行内 @引用候选：rid=正在输入的行，draft=@ 后的过滤词，
  // rect=输入框视口坐标（候选面板 portal 到 body，fixed 定位防滚动容器裁剪）
  const [mention, setMention] = useState<{
    rid: string;
    draft: string;
    rect: { left: number; top: number; bottom: number };
  } | null>(null);
  const projectStyle = useCanvasStore((s) => s.projectStyle);
  // 剧本卡「拆分镜表」的一次性远程触发（hook 须在 early return 之前）：
  // 剧本卡给本卡置位 autoGenerate 旗标 → 消费并走本卡 generate（带镜头数/
  // 风格/名单注入/refIds 绑定全套参数），避免跨卡直调的挂载时序问题。
  // generate 在 guard 之后定义，经 ref 间接引用
  const genRef = useRef<() => void>(() => {});
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

  /** 一键生成分镜（直连 langflow flow，不经聊天）：结果写回 rows */
  const generate = async () => {
    if (generating || !scriptSource) return;
    setGenerating(true);
    setGenError("");
    try {
      const next = await generateShotlist(scriptSource, {
        // 项目画风打底 + 分镜表风格叠加
        visualStyle:
          [
            projectStyle.trim() ? `全局：${projectStyle.trim()}` : "",
            (d.visualStyle ?? "").trim(),
          ]
            .filter(Boolean)
            .join("；") || undefined,
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
      // 生成结果自动绑 refIds：行内 @名称 与画布资产卡同名即绑定
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
          for (const [t, id] of titleToId) {
            if (t && action.startsWith(t, i + 1)) {
              ids.add(id);
              i += t.length;
              break;
            }
          }
          i = action.indexOf("@", i + 1);
        }
        return ids.size > 0 ? { ...r, refIds: [...ids] } : r;
      });
      update({ rows: bound, status: "ready" });
    } catch (exc) {
      setGenError(exc instanceof Error ? exc.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  };

  const setRow = (rid: string, patch: Partial<ShotRow>) => {
    update({
      rows: rows.map((r) => (r.rid === rid ? { ...r, ...patch } : r)),
    });
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
      .map((n) => `【${n.data.title}】${(n.data.body ?? "").slice(0, 160)}`)
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

  /** 文本 @名称 兜底匹配：最长优先（防“小雨”误命中“小雨萍”），
   *  已命中的区间不再被更短名覆盖；含服饰在内的四类资产 */
  // Look 图卡判定：image 卡且有来自资产卡的连线 = 派生参考图（一张卡一张图
  // 重构后，造型变体都是这种卡）；可被行内 @ 引用，出图时当一致性参考
  const isLook = (n: WingNode | undefined) =>
    Boolean(
      n &&
        n.data.nodeType === "image" &&
        n.data.title &&
        edges.some(
          (e) =>
            e.target === n.id &&
            ["character", "scene", "prop", "costume"].includes(
              String(nodes.find((m) => m.id === e.source)?.data.nodeType),
            ),
        ),
    );

  const mentionedRefIds = (text: string) => {
    // 资产卡 + 角色派生的 Look 图卡（有连线来源的 image 卡）都可被 @；
    // 长名优先匹配防「@角色名」误吞「@角色名·造型」
    const cands = nodes
      .filter(
        (n) =>
          (["character", "scene", "prop", "costume"].includes(
            String(n.data.nodeType),
          ) ||
            isLook(n)) &&
          n.data.title,
      )
      .sort(
        (a, b) =>
          (b.data.title as string).length - (a.data.title as string).length,
      );
    const found: string[] = [];
    const spans: [number, number][] = [];
    for (const n of cands) {
      const token = `@${n.data.title}`;
      let from = 0;
      for (;;) {
        const i = text.indexOf(token, from);
        if (i === -1) break;
        const end = i + token.length;
        if (!spans.some(([s0, e0]) => i < e0 && end > s0)) {
          spans.push([i, end]);
          found.push(n.id);
        }
        from = i + 1;
      }
    }
    return found;
  };

  /** 行引用解析：结构化 refIds 优先，文本 @名称 兜底，合并去重 */
  const rowRefNodes = (r: ShotRow) => {
    const ids = new Set<string>(r.refIds ?? []);
    mentionedRefIds(`${r.action ?? ""}${r.dialogue ?? ""}`).forEach((id) =>
      ids.add(id),
    );
    return [...ids]
      .map((nid) => nodes.find((n) => n.id === nid))
      .filter((n): n is WingNode => Boolean(n));
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
      onMsg: setDecomposeMsg,
      onError: setGenError,
    });
    setDecomposing(false);
  };

  // autoGenerate 消费体：先清旗标（防重入）再触发生成
  genRef.current = () => {
    update({ autoGenerate: undefined });
    void generate();
  };

  /** 批量物化镜头图（novanova 分镜视频的图片版）：选中行 → 画布右侧双列
   *  网格建图片卡（已有关联卡则原卡重跑）+ 自动连线 + 直连 imagegen flow
   *  批量生成（并发 3，不经聊天 LLM），结果回填各节点。行缩略图读关联节点 */
  const genShotImages = async (targets: { row: ShotRow; seq: number }[]) => {
    if (imgGenerating || targets.length === 0) return;
    // 画风闸（juben 硬闸同款）：只认全局画风——风格唯一入口在底部坞「画风」，
    // 否则同批镜头图风格必然漂移
    if (!projectStyle.trim()) {
      setGenError("未选画风：请先在底部坞「画风」选项目画风再出图");
      return;
    }
    // 软闸（asset-first 守护）：无参考行将纯文生图、一致性打折；合并大额
    // 确认为一次弹窗。空镜/氛围镜头属合法场景，故警告不硬拦
    const unrefCount = targets.filter(
      (t) => refImagesFor(t.row).length === 0,
    ).length;
    if (unrefCount > 0 || targets.length > 8) {
      const parts: string[] = [];
      if (unrefCount > 0)
        parts.push(
          `有 ${unrefCount} 镜没有可参考的资产设定图（未拆解/资产未出图/未@引用），将纯文生图、角色一致性打折`,
        );
      if (targets.length > 8)
        parts.push(
          `将批量出图 ${targets.length} 张（每张需数十秒并消耗出图额度）`,
        );
      const ask =
        parts.join("；") +
        "。" +
        (unrefCount > 0
          ? "建议先「拆解资产」并给资产出设定图。仍要继续？"
          : "确认开始？");
      if (!window.confirm(ask)) return;
    }
    const st = useCanvasStore.getState();
    const src = st.nodes.find((n) => n.id === id);
    if (!src) return;
    setImgGenerating(true);
    // 网格锚点：整块区域 findFreePosition 避让已有卡，块内双列铺开
    const abs = absolutePosition(st.nodes, src);
    const sz = nodeSize(src);
    const fp = NODE_FOOTPRINT.image;
    const colW = fp.w + 54;
    const rowH = fp.h + 54;
    const cols = Math.min(2, targets.length);
    const origin = findFreePosition(st.nodes, { x: abs.x + sz.w + 80, y: abs.y }, {
      w: cols * colW - 54,
      h: Math.ceil(targets.length / cols) * rowH - 54,
    });
    const styleStack = [
      (d.visualStyle ?? "").trim() ? `分镜表风格：${(d.visualStyle ?? "").trim()}` : "",
      projectStyle.trim() ? `全局视觉风格：${projectStyle.trim()}` : "",
    ].filter(Boolean);
    const created: string[] = [];
    const jobs: { rid: string; nodeId: string }[] = [];
    const ridToNode = new Map<string, string>();
    for (let i = 0; i < targets.length; i++) {
      const { row } = targets[i];
      const existing = row.imageNodeId
        ? st.nodes.find((n) => n.id === row.imageNodeId)
        : null;
      if (existing) {
        // 原卡重跑：保留位置与连线，只重置状态
        useCanvasStore
          .getState()
          .updateNodeData(existing.id, { status: "loading", errorMessage: undefined, imageUrl: undefined });
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
        },
      });
      st.connect({ source: id, target: nid });
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
      const jobId = await startShotImageJob(
        jobs.map((j) => {
          const t = targets.find((x) => x.row.rid === j.rid)!;
          return {
            rid: j.rid,
            name: `镜头${t.seq + 1}`,
            description: composeRowPrompt(t.row),
            visualNotes: [refNotesFor(t.row), ...styleStack]
              .filter(Boolean)
              .join("；"),
            referenceImages: refImagesFor(t.row),
          };
        }),
      );
      // jobId 落卡：出图中刷新/关标签后挂载续轮询收尾（完事即清）
      useCanvasStore.getState().updateNodeData(id, { imageJobId: jobId });
      // 轮询任务：每张完成即点亮对应节点（ready/error），全部完成才收尾
      const outcome = await pollShotImageJob(jobId, (item) =>
        applyShotImageItem(id, item),
      );
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

  return (
    <CardShell id={id} data={d} selected={selected}>
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
            const thumbUrl =
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
              className="group/row rounded-md border border-hairline bg-surface-2/60 px-1 py-1"
            >
              <div className="flex items-stretch gap-1">
                <input
                  type="checkbox"
                  className="nodrag mt-0.5 h-3 w-3 shrink-0 cursor-pointer accent-[var(--color-accent)]"
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
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded bg-accent-dim text-[10px] font-semibold tabular-nums text-text">
                  {i + 1}
                </span>
                {thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumbUrl}
                    alt=""
                    className="h-10 w-14 shrink-0 rounded object-cover"
                  />
                ) : (
                  <button
                    type="button"
                    title={
                      thumbLoading
                        ? "正在出图…"
                        : thumbError
                          ? `出图失败：${(linked?.data.errorMessage as string) ?? "可重试"}`
                          : refImagesFor(r).length === 0
                            ? "为这个镜头出图。注意：此镜未引用已出图的资产设定图，将纯文生图、一致性弱（可先拆解资产并出图，或行内 @资产名）"
                            : "为这个镜头出图（出图卡自动摆到本卡右侧并连线）"
                    }
                    className={`nodrag grid h-10 w-14 shrink-0 place-items-center rounded border border-dashed transition-colors hover:border-accent hover:text-text-2 ${
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
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : thumbError ? (
                      <RefreshCw className="h-3.5 w-3.5" />
                    ) : (
                      <ImageIcon className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
                <div className="relative flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-1">
                    <ShotSelect label="景别" value={r.shotSize ?? ""} options={SHOT_SIZES} onSave={(v) => setRow(r.rid, { shotSize: v })} />
                    <ShotChip label="运镜" value={r.cameraMove ?? ""} onSave={(v) => setRow(r.rid, { cameraMove: v })} />
                    <ShotChip label="时长" value={r.duration ?? ""} onSave={(v) => setRow(r.rid, { duration: v })} />
                    <ShotChip label="光影" value={r.lighting ?? ""} onSave={(v) => setRow(r.rid, { lighting: v })} />
                    <ShotChip label="音效" value={r.sound ?? ""} onSave={(v) => setRow(r.rid, { sound: v })} />
                  </div>
                  <div className="flex items-start gap-1">
                    <span className="mt-0.5 w-7 shrink-0 text-[9px] leading-5 text-text-4">画面</span>
                    <Editable
                    value={r.action ?? ""}
                    onSave={(action) => {
                      setRow(r.rid, { action });
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
                    className="min-w-0 max-h-14 flex-1 overflow-auto text-[11px] leading-relaxed text-text-2"
                  />
                  </div>
                  <div className="flex items-start gap-1">
                    <span className="mt-0.5 w-7 shrink-0 text-[9px] leading-5 text-text-4">旁白</span>
                    <Editable
                    value={r.dialogue ?? ""}
                    onSave={(dialogue) => setRow(r.rid, { dialogue })}
                    multiline
                    always
                    placeholder="台词 / 旁白"
                    className="min-w-0 max-h-9 flex-1 overflow-auto border-l-2 border-hairline pl-1.5 text-[11px] italic leading-relaxed text-text-3"
                  />
                  </div>
                  {overridden ? (
                    <div className="flex items-start gap-1 rounded border border-hairline-soft bg-surface-2/40 p-1">
                      <span className="mt-0.5 w-7 shrink-0 text-[9px] leading-5 text-text-4">出图</span>
                      <Editable
                        value={r.finalPrompt!}
                        onSave={(finalPrompt) =>
                          setRow(r.rid, {
                            finalPrompt: finalPrompt.trim() ? finalPrompt : undefined,
                          })
                        }
                        multiline
                        always
                        placeholder="出图提示词"
                        className="max-h-28 min-h-0 flex-1 overflow-auto text-[10px] leading-relaxed text-text-3"
                      />
                      <button
                        type="button"
                        title="清除自定义，恢复按本行字段自动合成"
                        className="nodrag mt-0.5 shrink-0 text-text-4 transition-colors hover:text-accent"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRow(r.rid, { finalPrompt: undefined });
                        }}
                      >
                        <RotateCcw className="h-3 w-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      title="自定义发给图像模型的提示词（默认按本行字段自动合成，一般不用手写）"
                      className="nodrag flex w-fit items-center gap-1 rounded border border-dashed border-hairline px-1.5 py-0.5 text-[10px] text-text-4 transition-colors hover:border-accent hover:text-text"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRow(r.rid, { finalPrompt: autoPrompt });
                      }}
                    >
                      <Sparkles className="h-3 w-3" />
                      自定义出图提示词
                    </button>
                  )}
                </div>
                <div className="flex shrink-0 items-start gap-1 opacity-0 transition-opacity group-hover/row:opacity-100">
                  <button
                    type="button"
                    title={r.finalPrompt?.trim() ? "重新出图（用最终提示词）" : r.imageUrl ? "重新出图" : "出图"}
                    className="nodrag text-text-4 hover:text-accent"
                    onClick={(e) => {
                      e.stopPropagation();
                      void genShotImages([{ row: r, seq: i }]);
                    }}
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                  <button type="button" title="复制此行（排到下一行，不带出图）" className="nodrag text-text-4 hover:text-text" onClick={(e) => { e.stopPropagation(); copyRow(r.rid); }}>
                    <Copy className="h-3 w-3" />
                  </button>
                  <button type="button" title="上移" className="nodrag text-text-4 hover:text-text disabled:opacity-30" disabled={i === 0} onClick={(e) => { e.stopPropagation(); moveRow(r.rid, -1); }}>
                    <ChevronUp className="h-3 w-3" />
                  </button>
                  <button type="button" title="下移" className="nodrag text-text-4 hover:text-text disabled:opacity-30" disabled={i === rows.length - 1} onClick={(e) => { e.stopPropagation(); moveRow(r.rid, 1); }}>
                    <ChevronDown className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    title="删除此行"
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
      {generating ? (
        <div className="ws-detail nodrag nowheel mt-1.5 rounded-md border border-hairline-soft bg-surface-2/50 px-1.5 py-1 text-[10px] text-text-3">
          分镜生成中…（从剧本卡「拆分镜表」或下方对话框触发）
        </div>
      ) : null}
      {decomposeMsg ? (
        <p className="ws-detail mt-1 text-[10px] text-text-3">{decomposeMsg}</p>
      ) : null}
      {genError ? (
        <p className="ws-detail mt-1 text-[10px] text-danger">{genError}</p>
      ) : null}
      {/* 底栏 = 统计 + 行操作 + 管线动作（左→右即管线顺序：拆解资产 → 出图；
          出图降级样式+无参考行/大额确认防误触） */}
      <div className="mt-1.5 flex items-center justify-between border-t border-hairline pt-1.5 text-[10px] text-text-4">
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
            title="用拆解技能从剧本提取角色/场景/道具/服饰 → 自动分组建卡并出资产图（画风闸内自动链）。出分镜图前先给资产出设定图，一致性最好"
            className="nodrag shrink-0 rounded border border-hairline bg-surface-1 px-1.5 py-0.5 text-text-2 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            onClick={(e) => {
              e.stopPropagation();
              void decompose();
            }}
          >
            {decomposing ? "拆解中…" : "拆解资产"}
          </button>
          <button
            type="button"
            disabled={imgGenerating || selectedGenRows.length === 0}
            title="勾选行批量出图：每镜一张图片卡，自动摆到本卡右侧并连线（直连出图，不经聊天）。消耗出图额度；无参考行会先确认"
            className="nodrag shrink-0 rounded border border-hairline bg-surface-1 px-1.5 py-0.5 text-text-2 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
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
              title={`为还没出图/出图失败的 ${missingRows.length} 镜补图（自动跳过已完成的镜）`}
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
            title="把与本卡连线的镜头视频按画布从左到右拼接成片：自动建/复用成片卡、依序连线并合成（顺序可在成片卡里微调）"
            className="nodrag shrink-0 rounded border border-hairline bg-surface-1 px-1.5 py-0.5 text-text-2 transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
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
                      isLook(n)) &&
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
                        src={n.data.imageUrl}
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

export const nodeTypes = {
  note: memo(NoteCard),
  script: memo(ScriptCard),
  character: memo(AssetCard),
  scene: memo(AssetCard),
  prop: memo(AssetCard),
  image: memo(ImageCard),
  video: memo(VideoCard),
  audio: memo(AudioCard),
  compose: memo(ComposeCard),
  storyboard: memo(StoryboardCard),
  shotlist: memo(ShotListCard),
  group: memo(GroupCard),
};
