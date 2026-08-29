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
  Grid3X3,
  History,
  Image as ImageIcon,
  Maximize2,
  Music,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ScanSearch,
  Upload,
  X,
  ZoomIn,
} from "lucide-react";
import {
  NODE_FOOTPRINT,
  NODE_META,
  absolutePosition,
  useCanvasStore,
  type ShotRow,
  type WingNode,
  type WingNodeData,
  type WingNodeType,
} from "@/lib/canvas/store";
import { TYPE_ICONS } from "@/lib/canvas/type-icons";
import {
  FOCUS_NODES_EVENT,
  FRAME_ANALYSIS_EVENT,
  ROW_GENERATE_EVENT,
} from "@/lib/canvas/events";
import { GENERATE_EVENT, type GenerateDetail } from "./PromptBar";
import { composeVideos, uploadAsset } from "@/lib/projects";
import VersionHistoryModal from "./NodeMediaHistory";
import MaskEditDialog from "./MaskEditDialog";
import MarkdownView from "./MarkdownView";
import { TokenText } from "./TokenText";

/** 重试生成事件：image 卡 error 态发出，CanvasAgentBridge 监听并转成聊天指令 */
export const RETRY_GENERATION_EVENT = "wingsight:retry-generation";

/** 从一张卡右侧建下游卡并自动连线（AIGCCanvasFlow 的 hover "+" 模式）。
 *  已有下游时按级联错位摆放，避免叠卡；返回新节点 id 供调用方追加动作 */
function createConnectedNode(sourceId: string, type: WingNodeType) {
  const st = useCanvasStore.getState();
  const src = st.nodes.find((n) => n.id === sourceId);
  if (!src) return null;
  const abs = absolutePosition(st.nodes, src);
  const fp = NODE_FOOTPRINT[src.data.nodeType] ?? NODE_FOOTPRINT.note;
  const fanout = st.edges.filter((e) => e.source === sourceId).length;
  const id = st.addNode({
    position: { x: abs.x + fp.w + 60, y: abs.y + fanout * 72 },
    data: { nodeType: type, title: NODE_META[type].hint, body: "" },
  });
  st.connect({ source: sourceId, target: id });
  useCanvasStore.getState().selectNodes([id]);
  window.dispatchEvent(
    new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: [id] } }),
  );
  return id;
}

/** 从一张卡左侧建上游卡并自动连线（新卡 → 本卡） */
function createUpstreamNode(targetId: string, type: WingNodeType) {
  const st = useCanvasStore.getState();
  const tgt = st.nodes.find((n) => n.id === targetId);
  if (!tgt) return;
  const abs = absolutePosition(st.nodes, tgt);
  const fp = NODE_FOOTPRINT[tgt.data.nodeType] ?? NODE_FOOTPRINT.note;
  const id = st.addNode({
    position: { x: abs.x - fp.w - 60, y: abs.y },
    data: { nodeType: type, title: NODE_META[type].hint, body: "" },
  });
  st.connect({ source: id, target: targetId });
  useCanvasStore.getState().selectNodes([id]);
  window.dispatchEvent(
    new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: [id] } }),
  );
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
    return {
      // 锚点外移：按钮整体悬在节点外侧（留 6px 间隙），磁性偏移叠加其上
      ...(side === "left"
        ? {
            left: 0,
            transform: `translate(calc(-100% - 6px + ${sx}px), calc(-50% + ${sy}px)) scale(${1 + 0.4 * p})`,
          }
        : {
            right: 0,
            left: "auto",
            transform: `translate(calc(100% + 6px + ${sx}px), calc(-50% + ${sy}px)) scale(${1 + 0.4 * p})`,
          }),
      top: "calc(50% + 12px)",
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
      {/* 连线手柄在左右（libtv 范式）：手柄即加号，点击弹菜单、拖拽发起连线。
          top 偏移 +12px：卡体在标题行之下，让加号对准卡体垂直中心 */}
      {/* 连线手柄在左右（libtv 范式）：显式定位正跨边缘；磁性追踪越近越大 */}
      <Handle
        type="target"
        position={Position.Left}
        style={handleStyle("left")}
        onPointerDown={onHandlePointerDown}
        onPointerUp={onHandlePointerUp("left")}
        title="建上游卡 / 拖拽连线"
      >
        <Plus className="h-3 w-3" />
      </Handle>
      <Handle
        type="source"
        position={Position.Right}
        style={handleStyle("right")}
        onPointerDown={onHandlePointerDown}
        onPointerUp={onHandlePointerUp("right")}
        title="建下游卡 / 拖拽连线"
      >
        <Plus className="h-3 w-3" />
      </Handle>
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
 * 就地编辑文本块（nodrag/nowheel 避免触发画布手势），统一用 textarea：
 * 默认双击进入编辑，单行模式 Enter、多行模式 Ctrl+Enter 或失焦保存。
 * autoEdit（选中即编辑，Storyboard-Copilot 范式）：选中态直接呈现 textarea、
 * 光标接在文末，取消选中/失焦自动保存——文本/剧本卡正文用。
 * Esc 保存并退出（autoEdit 下退出 = 取消选中）。改动经 draftRef 兜底提交，
 * 删卡/切换等不走 blur 的卸载路径不丢字。
 * 展示态自动高亮 @图N 引用 token；markdown=true 时展示态改走 MarkdownView。
 * fill：撑满父 flex 容器剩余高度（卡片拉大后正文跟随填充，配合调用方
 * 传 flex-1 min-h-0 overflow-auto 的 className 使用）。
 */
function Editable({
  value,
  onSave,
  className,
  multiline,
  placeholder,
  markdown,
  fill,
  autoEdit,
}: {
  value: string;
  onSave: (next: string) => void;
  className?: string;
  multiline?: boolean;
  placeholder?: string;
  markdown?: boolean;
  fill?: boolean;
  autoEdit?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const active = editing || autoEdit;

  // 草稿兜底：取消选中/卸载不走 blur，统一从这里补提交
  const draftRef = useRef<string | null>(null);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  const commitDraft = () => {
    const t = draftRef.current;
    draftRef.current = null;
    if (t !== null && t !== valueRef.current) onSave(t);
  };
  const commitRef = useRef(commitDraft);
  useEffect(() => {
    commitRef.current = commitDraft;
  });
  useEffect(() => {
    if (!autoEdit) commitRef.current();
  }, [autoEdit]);
  useEffect(() => () => commitRef.current(), []);

  useEffect(() => {
    if (active && ref.current) {
      ref.current.focus();
      // 光标接在文末（novanova 范式），从上次写到的位置继续
      const len = ref.current.value.length;
      ref.current.setSelectionRange(len, len);
    }
  }, [active]);

  if (!active) {
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
          title={autoEdit ? "点击选中直接编辑" : "双击编辑"}
        >
          {value ? (
            markdown ? (
              <MarkdownView text={value} />
            ) : (
              <TokenText text={value} />
            )
          ) : (
            <span className="italic text-text-4">{placeholder}</span>
          )}
        </div>
      </div>
    );
  }

  const commit = () => {
    setEditing(false);
    draftRef.current = null;
    const next = (ref.current?.value ?? "").trim();
    if (next !== value) onSave(next);
  };

  return (
    <textarea
      ref={ref}
      defaultValue={value}
      rows={multiline ? Math.min(10, Math.max(3, value.split("\n").length)) : 1}
      onBlur={commit}
      onChange={(e) => {
        draftRef.current = e.currentTarget.value;
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // 保存后退出；选中即编辑模式退出 = 取消选中（渲染预览）
          if (autoEdit) useCanvasStore.getState().clearSelection();
          else commit();
        }
        if (e.key === "Enter" && (multiline ? e.ctrlKey || e.metaKey : true)) {
          commit();
        }
      }}
      className={`nodrag nowheel w-full resize-none outline-none ${
        fill
          ? // 正文（纸面式）：无边框透明底，与预览态排版完全一致，
            // 编辑态只靠卡片选中描边 + 光标提示
            "min-h-0 flex-1 border-0 bg-transparent px-0 py-0"
          : "rounded-sm border border-accent bg-surface-2 px-1 py-0.5"
      } ${multiline ? "" : "whitespace-nowrap overflow-hidden"}`}
    />
  );
}

/** 节点数据更新器（普通函数，非 hook） */
function makeUpdater(id: string) {
  return (patch: Partial<WingNodeData>) =>
    useCanvasStore.getState().updateNodeData(id, patch);
}

/** 下载文件名：标题净字 + 从 URL 推断后缀 */
function downloadName(title: string, url: string, fallbackExt: string) {
  const m = url.match(/\.(png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|m4a|ogg|flac|aac)(?:\?|$)/i);
  const ext = m ? m[1].toLowerCase().replace("jpeg", "jpg") : fallbackExt;
  const safe = (title || "").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 40);
  return `${safe || "wingsight"}.${ext}`;
}

/** 空卡直输框：新建即所得（点击卡片就是输入框），失焦/Ctrl+Enter 落库 */
function InlineDraft({
  onSave,
  placeholder,
  editorial,
}: {
  onSave: (text: string) => void;
  placeholder: string;
  editorial?: boolean;
}) {
  const [v, setV] = useState("");
  return (
    <textarea
      autoFocus
      value={v}
      rows={3}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const t = v.trim();
        if (t) onSave(t);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          const t = v.trim();
          if (t) onSave(t);
        }
      }}
      className={`ws-detail nodrag nowheel min-h-20 w-full flex-1 resize-none rounded-md border border-hairline bg-surface-2/50 p-2 text-xs leading-relaxed text-text outline-none focus:border-accent placeholder:text-text-4 ${
        editorial ? "font-editorial" : ""
      }`}
    />
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
}: {
  data: WingNodeData;
  id: string;
  selected: boolean;
  editorial?: boolean;
}) {
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
        {empty ? (
          <InlineDraft
            onSave={(body) => update({ body })}
            placeholder={
              editorial
                ? "直接输入剧本（支持 Markdown）…选中后可在下方让 AI 写"
                : "直接输入内容（支持 Markdown）…选中后可在下方让 AI 写"
            }
            editorial={editorial}
          />
        ) : (
          <Editable
            value={data.body}
            onSave={(body) => update({ body })}
            multiline
            markdown
            fill
            autoEdit={selected}
            placeholder="（空）"
            className={`ws-detail min-h-0 flex-1 overflow-auto text-xs leading-relaxed text-text-2 ${
              editorial ? "font-editorial" : ""
            } nowheel`}
          />
        )}
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
    </CardShell>
  );
}

function NoteCard({ data, id, selected }: NodeProps) {
  return <TextCard data={data as WingNodeData} id={id} selected={selected} />;
}

/** 剧本卡：正文可滚 + 衬线编辑风（承载剧本全文） */
function ScriptCard({ data, id, selected }: NodeProps) {
  return (
    <TextCard
      data={data as WingNodeData}
      id={id}
      selected={selected}
      editorial
    />
  );
}

/** 角色卡：定妆照槽位（上传/引用一致性锚点）+ 设定正文 */
function CharacterCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const update = makeUpdater(id);
  const [uploading, setUploading] = useState(false);
  const [zoom, setZoom] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // 防御：异常数据不渲染（hooks 已在上，顺序稳定）
  if (!d || typeof d.nodeType !== "string") return null;

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
          <button
            type="button"
            className="nodrag group relative h-full w-full"
            onClick={(e) => {
              e.stopPropagation();
              setZoom(true);
            }}
            title="点击放大"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={d.imageUrl}
              alt={d.title}
              className="ws-media-in h-full w-full object-cover"
              {...mediaDragProps(id)}
            />
            <CornerActions>
              <button
                type="button"
                title="更换定妆照"
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
          </button>
        ) : (
          <MediaEmpty
            icon={<Drama className="h-5 w-5" />}
            hint="上传定妆照"
            sub="角色一致性锚点"
            busy={uploading}
            onClick={() => fileRef.current?.click()}
          />
        )}
      </div>
      <Editable
        value={d.body}
        onSave={(body) => update({ body })}
        multiline
        placeholder="外形 / 性格 / 服装 / 说话方式"
        className="ws-detail mt-1.5 line-clamp-6 whitespace-pre-wrap text-xs leading-relaxed text-text-2"
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

/** 图片放大预览：翻页 + 滚轮缩放（光标为锚）+ 拖拽平移 + 百分比读数
 *  （变换实现移植自 references/Storyboard-Copilot 的 useImageViewerTransform，
 *  直接内联以满足 react-hooks/refs 对 ref 访问位置的约束） */
function Lightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: { src: string; title: string }[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pct, setPct] = useState(100);
  const cssScaleRef = useRef(1);
  const imgScaleRef = useRef(1);
  const imgPosRef = useRef({ x: 0, y: 0 });
  const tgtScaleRef = useRef(1);
  const tgtPosRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);

  const applyTransform = useCallback(() => {
    const img = imageRef.current;
    if (!img) return;
    const s = imgScaleRef.current;
    const p = imgPosRef.current;
    img.style.transform = `scale(${s}) translate(${p.x / s}px, ${p.y / s}px)`;
  }, []);

  const resetView = useCallback(() => {
    imgScaleRef.current = 1;
    imgPosRef.current = { x: 0, y: 0 };
    tgtScaleRef.current = 1;
    tgtPosRef.current = { x: 0, y: 0 };
    applyTransform();
  }, [applyTransform]);

  const displayScale = useCallback(
    () => Math.round(cssScaleRef.current * imgScaleRef.current * 100),
    [],
  );

  /** 点击坐标是否落在图片内容上（object-contain 的留白不算） */
  const pointOnImage = useCallback((cx: number, cy: number): boolean => {
    const img = imageRef.current;
    if (!img?.naturalWidth || !img.naturalHeight) return false;
    const rect = img.getBoundingClientRect();
    const imgRatio = img.naturalWidth / img.naturalHeight;
    const boxRatio = rect.width / rect.height;
    let w: number;
    let h: number;
    let ox: number;
    let oy: number;
    if (imgRatio > boxRatio) {
      w = rect.width;
      h = rect.width / imgRatio;
      ox = 0;
      oy = (rect.height - h) / 2;
    } else {
      h = rect.height;
      w = rect.height * imgRatio;
      oy = 0;
      ox = (rect.width - w) / 2;
    }
    const x = cx - rect.left;
    const y = cy - rect.top;
    return x >= ox && x <= ox + w && y >= oy && y <= oy + h;
  }, []);

  // 滚轮缩放（rAF 平滑逼近目标值）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const isMac = /mac/i.test(navigator.userAgent);
    const onWheel = (e: WheelEvent) => {
      if (!pointOnImage(e.clientX, e.clientY)) return;
      e.preventDefault();
      if (!rafRef.current) {
        tgtScaleRef.current = imgScaleRef.current;
        tgtPosRef.current = imgPosRef.current;
      }
      const dm = e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002;
      let ns = tgtScaleRef.current * Math.pow(2, -e.deltaY * dm * (e.ctrlKey && isMac ? 10 : 1));
      ns = Math.max(0.1, Math.min(10, ns));
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      const k = ns / tgtScaleRef.current;
      tgtScaleRef.current = ns;
      tgtPosRef.current = {
        x: mx * (1 - k) + tgtPosRef.current.x * k,
        y: my * (1 - k) + tgtPosRef.current.y * k,
      };
      if (!rafRef.current) {
        const loop = () => {
          const ts = tgtScaleRef.current;
          const tp = tgtPosRef.current;
          imgScaleRef.current += (ts - imgScaleRef.current) * 0.3;
          imgPosRef.current = {
            x: imgPosRef.current.x + (tp.x - imgPosRef.current.x) * 0.3,
            y: imgPosRef.current.y + (tp.y - imgPosRef.current.y) * 0.3,
          };
          applyTransform();
          const settled =
            Math.abs(imgScaleRef.current - ts) < 0.001 &&
            Math.abs(imgPosRef.current.x - tp.x) < 0.1 &&
            Math.abs(imgPosRef.current.y - tp.y) < 0.1;
          if (settled) {
            imgScaleRef.current = ts;
            imgPosRef.current = tp;
            applyTransform();
            rafRef.current = null;
          } else {
            rafRef.current = requestAnimationFrame(loop);
          }
        };
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [pointOnImage, applyTransform]);

  // 百分比读数与键盘翻页/关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "ArrowRight" && index < images.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    const t = setInterval(() => setPct(displayScale()), 250);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearInterval(t);
    };
  }, [onClose, onIndex, index, images.length, displayScale]);
  // 切换图片时复位视图
  useEffect(() => {
    resetView();
    movedRef.current = false;
  }, [index, resetView]);

  const cur = images[index];
  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8"
      onMouseMove={(e) => {
        if (!dragging) return;
        movedRef.current = true;
        const p = { x: e.clientX - dragStartRef.current.x, y: e.clientY - dragStartRef.current.y };
        imgPosRef.current = p;
        tgtPosRef.current = p;
        applyTransform();
      }}
      onMouseUp={() => setDragging(false)}
      onClick={() => {
        if (!movedRef.current) onClose();
        movedRef.current = false;
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imageRef}
        src={cur?.src}
        alt={cur?.title}
        onLoad={() => {
          const img = imageRef.current;
          if (!img?.naturalWidth || !img.offsetWidth || !img.offsetHeight) return;
          const ratio = img.naturalWidth / img.naturalHeight;
          const boxRatio = img.offsetWidth / img.offsetHeight;
          cssScaleRef.current =
            (ratio > boxRatio ? img.offsetWidth : img.offsetHeight * ratio) /
            img.naturalWidth;
          resetView();
        }}
        onMouseDown={(e) => {
          if (e.button !== 0 || !pointOnImage(e.clientX, e.clientY)) return;
          e.preventDefault();
          setDragging(true);
          dragStartRef.current = {
            x: e.clientX - imgPosRef.current.x,
            y: e.clientY - imgPosRef.current.y,
          };
        }}
        className={`max-h-full max-w-full rounded-lg object-contain shadow-2xl will-change-transform ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />
      {images.length > 1 ? (
        <>
          <button
            type="button"
            title="上一张"
            disabled={index === 0}
            className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 disabled:opacity-30"
            onClick={(e) => {
              e.stopPropagation();
              onIndex(index - 1);
            }}
          >
            ‹
          </button>
          <button
            type="button"
            title="下一张"
            disabled={index === images.length - 1}
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 disabled:opacity-30"
            onClick={(e) => {
              e.stopPropagation();
              onIndex(index + 1);
            }}
          >
            ›
          </button>
          <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs text-white/80">
            {index + 1} / {images.length}
          </span>
        </>
      ) : null}
      <div className="absolute bottom-4 left-4 flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1 text-xs text-white/80">
        <span className="tabular-nums">{pct}%</span>
        <button
          type="button"
          className="text-white/70 underline-offset-2 hover:text-white hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            resetView();
          }}
        >
          重置
        </button>
        <span className="text-white/40">滚轮缩放 · 拖拽平移</span>
      </div>
      <button
        type="button"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        onClick={onClose}
      >
        <X className="h-5 w-5" />
      </button>
    </div>
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
      <div
        className={`mt-1.5 flex h-36 min-h-36 w-full flex-1 items-center justify-center overflow-hidden rounded-md border border-hairline-soft bg-surface-2 ${
          d.status === "loading" ? "ws-loading-scan" : ""
        }`}
      >
        {d.status === "loading" ? (
          <GenProgress nodeId={id} expected={22} />
        ) : d.status === "error" ? (
          <RetryPanel nodeId={id} errorMessage={d.errorMessage} />
        ) : d.imageUrl ? (
          <button
            type="button"
            className="nodrag group relative h-full w-full"
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
              className="ws-media-in h-full w-full object-cover"
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
          </button>
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
    <div
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
    </div>
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
  const projectId = useCanvasStore((s) => s.projectId);
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

  const runCompose = async () => {
    if (items.length === 0 || !projectId) {
      update({ status: "error", errorMessage: projectId ? "没有可合成的视频源" : "无项目上下文，无法合成" });
      return;
    }
    update({ status: "loading", errorMessage: undefined });
    const res = await composeVideos(projectId, items.map((s) => s.node.data.videoUrl as string));
    if (res?.url) update({ videoUrl: res.url, status: "ready" });
    else update({ status: "error", errorMessage: "合成失败（源文件不兼容或服务端异常），可重试" });
  };

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
      <span className={accent ? "text-accent" : "text-text-4"}>{label}</span>
      <Editable
        value={value}
        onSave={onSave}
        placeholder="—"
        className="min-w-6 text-text-2"
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
        value={d.body}
        onSave={(body) => update({ body })}
        multiline
        placeholder="画面描述（谁、在哪、做什么）"
        className="ws-detail nowheel mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-text-2"
      />
      <Editable
        value={d.dialogue ?? ""}
        onSave={(dialogue) => update({ dialogue })}
        multiline
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

/** 拆成分镜卡：每行一张 storyboard 卡按序连线，首张连回分镜表（右键菜单入口） */
export function splitShotlistToNodes(node: WingNode) {
  const rows = (node.data.rows ?? []).filter((r) => (r.action ?? "").trim());
  if (rows.length === 0) return;
  const st = useCanvasStore.getState();
  st.commitHistory();
  const abs = absolutePosition(st.nodes, node);
  const fp = NODE_FOOTPRINT.storyboard;
  let prevId = "";
  const created: string[] = [];
  rows.forEach((r, i) => {
    const sid = st.addNode({
      position: {
        x: abs.x + (i % 4) * (fp.w + 60),
        y: abs.y + Math.floor(i / 4) * (fp.h + 60),
      },
      data: {
        nodeType: "storyboard",
        title: `第 ${i + 1} 镜`,
        body: r.action ?? "",
        shotNumber: String(i + 1).padStart(2, "0"),
        shotSize: r.shotSize,
        cameraMove: r.cameraMove,
        duration: r.duration,
        dialogue: r.dialogue,
      },
    });
    created.push(sid);
    if (prevId) st.connect({ source: prevId, target: sid });
    else st.connect({ source: node.id, target: sid });
    prevId = sid;
  });
  st.selectNodes(created);
  window.dispatchEvent(
    new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: created } }),
  );
}

/** 分镜表卡：一张卡管整场戏（行=镜头，双击改格），支持拆成分镜卡链与镜头级出图 */
function ShotListCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const update = makeUpdater(id);
  if (!d || typeof d.nodeType !== "string") return null;
  const rows = d.rows ?? [];

  const setRow = (rid: string, patch: Partial<ShotRow>) => {
    update({
      rows: rows.map((r) => (r.rid === rid ? { ...r, ...patch } : r)),
    });
  };
  const addRow = () => {
    update({
      rows: [
        ...rows,
        { rid: `r${Date.now().toString(36)}${rows.length}`, action: "" },
      ],
    });
  };
  const removeRow = (rid: string) => {
    update({ rows: rows.filter((r) => r.rid !== rid) });
  };

  /** 镜头级出图（桥接层转聊天指令，agent 生成后 update_row 回填行缩略图） */
  const genRow = (rid: string) => {
    const row = rows.find((r) => r.rid === rid);
    if (!row) return;
    window.dispatchEvent(
      new CustomEvent(ROW_GENERATE_EVENT, {
        detail: {
          nodeId: id,
          rid,
          prompt: [row.action, row.shotSize, row.cameraMove, row.dialogue]
            .filter(Boolean)
            .join("；"),
          refIds: [],
        },
      }),
    );
  };

  const totalDur = rows.reduce((sum, r) => {
    const m = (r.duration ?? "").match(/(\d+(?:\.\d+)?)/);
    return sum + (m ? parseFloat(m[1]) : 0);
  }, 0);

  return (
    <CardShell id={id} data={d} selected={selected}>
      <div className="ws-detail nowheel min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-1">
          {rows.length === 0 ? (
            <p className="rounded-md border border-dashed border-hairline px-2 py-4 text-center text-[11px] text-text-4">
              点击下方「加一行」开始排镜头
            </p>
          ) : null}
          {rows.map((r, i) => (
            <div
              key={r.rid}
              className="group/row flex items-stretch gap-1 rounded-md border border-hairline bg-surface-2/60 px-1 py-1"
            >
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded bg-accent-dim text-[10px] font-semibold tabular-nums text-text">
                {i + 1}
              </span>
              {r.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={r.imageUrl}
                  alt=""
                  className="h-10 w-14 shrink-0 rounded object-cover"
                />
              ) : (
                <button
                  type="button"
                  title="为这个镜头出图"
                  className="nodrag grid h-10 w-14 shrink-0 place-items-center rounded border border-dashed border-hairline text-text-4 transition-colors hover:border-accent hover:text-text-2"
                  onClick={(e) => {
                    e.stopPropagation();
                    genRow(r.rid);
                  }}
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                </button>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex flex-wrap gap-1">
                  <ShotChip label="景别" value={r.shotSize ?? ""} onSave={(v) => setRow(r.rid, { shotSize: v })} />
                  <ShotChip label="运镜" value={r.cameraMove ?? ""} onSave={(v) => setRow(r.rid, { cameraMove: v })} />
                  <ShotChip label="时长" value={r.duration ?? ""} onSave={(v) => setRow(r.rid, { duration: v })} />
                </div>
                <Editable
                  value={r.action ?? ""}
                  onSave={(action) => setRow(r.rid, { action })}
                  placeholder="画面描述（谁、在哪、做什么）"
                  className="line-clamp-2 text-[11px] leading-relaxed text-text-2"
                />
                <Editable
                  value={r.dialogue ?? ""}
                  onSave={(dialogue) => setRow(r.rid, { dialogue })}
                  placeholder="台词 / 旁白"
                  className="line-clamp-1 border-l-2 border-hairline pl-1.5 text-[11px] italic leading-relaxed text-text-3"
                />
              </div>
              <div className="flex shrink-0 flex-col items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
                <button
                  type="button"
                  title={r.imageUrl ? "重新出图" : "出图"}
                  className="nodrag text-text-4 hover:text-accent"
                  onClick={(e) => {
                    e.stopPropagation();
                    genRow(r.rid);
                  }}
                >
                  <RefreshCw className="h-3 w-3" />
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
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between border-t border-hairline pt-1.5 text-[10px] text-text-4">
        <span>
          {rows.length} 镜 · 总时长约 {totalDur > 0 ? `${Math.round(totalDur * 10) / 10}s` : "—"}
        </span>
        <button
          type="button"
          className="nodrag flex items-center gap-0.5 rounded border border-hairline px-1.5 py-0.5 text-text-3 transition-colors hover:border-accent hover:text-text"
          onClick={(e) => {
            e.stopPropagation();
            addRow();
          }}
        >
          <Plus className="h-3 w-3" />
          加一行
        </button>
      </div>
    </CardShell>
  );
}

export const nodeTypes = {
  note: memo(NoteCard),
  script: memo(ScriptCard),
  character: memo(CharacterCard),
  image: memo(ImageCard),
  video: memo(VideoCard),
  audio: memo(AudioCard),
  compose: memo(ComposeCard),
  storyboard: memo(StoryboardCard),
  shotlist: memo(ShotListCard),
  group: memo(GroupCard),
};
