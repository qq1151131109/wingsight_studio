"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  useStoreApi,
  type EdgeMouseHandler,
  type IsValidConnection,
  type NodeMouseHandler,
  type OnBeforeDelete,
  type OnConnectEnd,
  type OnMoveEnd,
  type OnNodeDrag,
  type OnReconnect,
  type Viewport,
} from "@xyflow/react";
import {
  Camera,
  ChevronRight,
  Info,
  Library,
  ListTree,
  Lock,
  LockOpen,
  Palette,
  Redo2,
  Search,
  Undo2,
  WandSparkles,
  X,
  ZoomIn as ZoomInIcon,
  ZoomOut,
  Maximize,
} from "lucide-react";
import {
  selectionBoxes,
  NODE_META,
  useCanvasStore,
  type WingEdge,
  type WingNode,
  type WingNodeType,
} from "@/lib/canvas/store";
import { TYPE_ICONS } from "@/lib/canvas/type-icons";
import {
  dispatchFocusEdit,
  FOCUS_NODES_EVENT,
  NODE_INFO_EVENT,
  type FocusNodesDetail,
  type NodeInfoDetail,
} from "@/lib/canvas/events";
import { loadCanvas, saveCanvas, uploadAsset } from "@/lib/projects";
import { sanitizeCanvas } from "@/lib/canvas/sanitize";
import { STYLE_CATEGORIES, STYLE_PRESETS } from "@/lib/canvas/style-presets";
import { nodeTypes, NodeInfoModal } from "./nodes";
import CanvasShortcuts from "./CanvasShortcuts";
import AssetTray, { AssetAutoRecorder } from "./AssetTray";
import NodeInputPanel from "./NodeInputPanel";
import { GENERATE_EVENT, type GenerateDetail } from "./PromptBar";
import PromptLibraryPanel from "./PromptLibraryPanel";
import ShortcutsModal from "./ShortcutsModal";
import ServiceBanner from "./ServiceBanner";
import OutlinePanel from "./OutlinePanel";
import DirectorPanel from "./DirectorPanel";

/** 离线指示：断网时顶部常驻小条（保存走 saveState "offline" 文案，这里补全局感知） */
function OfflineIndicator() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  if (!offline) return null;
  return (
    <div className="absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-1.5 text-xs text-warn shadow">
      离线中 · 变更暂存本地，联网后自动同步
    </div>
  );
}

/** 视口相等判断（按值比较，防程序化 setViewport 与 store 回写互触发） */
const vpEq = (a: Viewport, b: Viewport) =>
  a.x === b.x && a.y === b.y && a.zoom === b.zoom;

/**
 * 右键/双击菜单（六态）：pane=空白右键（sub="add" 时原位切换成节点类型列表，
 * 对标 reference 产品的二级展开）；add=双击空白的"添加节点"选择器。
 */
type CtxMenu =
  | {
      kind: "pane";
      x: number;
      y: number;
      fx: number;
      fy: number;
      sub: null | "add";
    }
  | { kind: "add"; x: number; y: number; fx: number; fy: number }
  | { kind: "node"; x: number; y: number; id: string }
  | { kind: "convert"; x: number; y: number; id: string }
  | { kind: "selection"; x: number; y: number; ids: string[] }
  | { kind: "edge"; x: number; y: number; id: string };

/** 连接校验：禁自环与重复边（对标 osc 的 connection rules，取最常用两条） */
const CONVERT_TYPES: WingNodeType[] = [
  "note",
  "script",
  "character",
  "image",
  "video",
  "audio",
];

function CtxItem({
  label,
  dot,
  icon,
  shortcut,
  chevron,
  danger,
  disabled,
  onClick,
}: {
  label: string;
  dot?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  chevron?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-2 ${
        danger ? "text-danger" : "text-text-2 hover:text-text"
      } disabled:cursor-not-allowed disabled:text-text-4 disabled:hover:bg-transparent`}
      onClick={onClick}
    >
      {dot ? (
        <span className="ws-card-dot" style={{ background: dot }} />
      ) : icon ? (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      ) : null}
      {label}
      <span className="ml-auto" />
      {shortcut ? (
        <span className="ml-3 text-[10px] tabular-nums text-text-4">
          {shortcut}
        </span>
      ) : null}
      {chevron ? (
        <ChevronRight className="ml-3 h-3 w-3 shrink-0 text-text-4" />
      ) : null}
    </button>
  );
}

const CtxSep = () => <div className="mx-1 my-1 h-px bg-hairline" />;

/** "添加节点"类型列表：双击选择器与右键二级展开共用。
 *  底部带「添加资源」分组（上传/素材库），结构对标 libtv 的建卡菜单 */
function NodeAddMenu({
  onPick,
  onUpload,
  onTray,
}: {
  onPick: (t: WingNodeType) => void;
  onUpload?: () => void;
  onTray?: () => void;
}) {
  return (
    <div className="flex min-w-[140px] flex-col">
      <p className="px-2 py-1 text-[10px] text-text-4">添加节点</p>
      {NODE_TYPE_ITEMS.map(({ type, key }) => {
        const Icon = TYPE_ICONS[type];
        return (
          <CtxItem
            key={key}
            label={NODE_META[type].label}
            icon={Icon ? <Icon className="h-4 w-4" /> : null}
            onClick={() => onPick(type)}
          />
        );
      })}
      {onUpload || onTray ? (
        <>
          <CtxSep />
          <p className="px-2 py-1 text-[10px] text-text-4">添加资源</p>
          {onUpload ? <CtxItem label="上传" onClick={onUpload} /> : null}
          {onTray ? <CtxItem label="素材库…" onClick={onTray} /> : null}
        </>
      ) : null}
    </div>
  );
}

/** 节点类型清单：工具条 / 双击选择器 / 右键"添加节点"三处共用（图标见 type-icons）。
 *  顺序对标 libtv：文本→图片→视频→智能剪辑→音频→脚本，影视特化卡排后 */
const NODE_TYPE_ITEMS: { type: WingNodeType; key: string }[] = (
  [
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
    "shotlist",
  ] as WingNodeType[]
).map((type) => ({ type, key: `i-${type}` }));

/** 拖拽导入：图片→上传建 image 卡；.txt/.md→文本卡（md 当剧本、txt 当文本） */
async function importDroppedFiles(
  files: File[],
  at: { x: number; y: number },
) {
  const store = useCanvasStore.getState();
  let i = 0;
  for (const f of files) {
    const position = {
      x: at.x + (i % 4) * 288,
      y: at.y + Math.floor(i / 4) * 300,
    };
    const name = f.name.replace(/\.[^.]+$/, "").slice(0, 40);
    if (f.type.startsWith("image/")) {
      try {
        const url = await uploadAsset(f);
        if (!url) continue;
        store.addNode({
          position,
          data: {
            nodeType: "image",
            title: name || "导入图片",
            body: "",
            imageUrl: url,
            status: "ready",
          },
        });
        i += 1;
      } catch {
        /* 上传失败跳过该文件 */
      }
    } else if (f.type.startsWith("video/")) {
      try {
        const url = await uploadAsset(f, f.type);
        if (!url) continue;
        store.addNode({
          position,
          data: {
            nodeType: "video",
            title: name || "导入视频",
            body: "",
            videoUrl: url,
            status: "ready",
          },
        });
        i += 1;
      } catch {
        /* 上传失败跳过该文件 */
      }
    } else if (f.type.startsWith("audio/")) {
      try {
        const url = await uploadAsset(f, f.type, f.name);
        if (!url) continue;
        store.addNode({
          position,
          data: {
            nodeType: "audio",
            title: name || "导入音频",
            body: "",
            audioUrl: url,
          },
        });
        i += 1;
      } catch {
        /* 上传失败跳过该文件 */
      }
    } else if (/\.(txt|md|markdown)$/i.test(f.name)) {
      try {
        const text = (await f.text()).slice(0, 8000);
        const isMd = /\.md$|\.markdown$/i.test(f.name);
        store.addNode({
          position,
          data: {
            nodeType: isMd ? "script" : "note",
            title: name || "导入文本",
            body: text,
          },
        });
        i += 1;
      } catch {
        /* 读取失败跳过该文件 */
      }
    }
  }
}

/** 工具条按钮拖到画布指定位置建卡（HTML5 拖拽，见 CanvasView onDrop） */
export const PALETTE_DRAG_TYPE = "application/x-wingsight-node";

function AddNodeToolbar() {
  const addNode = useCanvasStore((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();
  // 建卡落在画布可视区中心（而非随机坐标）
  const addAtCenter = (type: WingNodeType) => {
    const rect = document.querySelector(".react-flow")?.getBoundingClientRect();
    const center = screenToFlowPosition({
      x: (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2,
      y: (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2,
    });
    addNode({
      position: { x: Math.round(center.x - 128), y: Math.round(center.y - 90) },
      data: { nodeType: type, title: NODE_META[type].hint, body: "" },
    });
  };
  return (
    <div className="flex items-center gap-1 rounded-lg border border-hairline bg-surface-1 p-1 shadow-sm">
      {NODE_TYPE_ITEMS.map(({ type, key }) => {
        const Icon = TYPE_ICONS[type];
        return (
          <button
            key={key}
            type="button"
            draggable
            title={`添加${NODE_META[type].label}（${NODE_META[type].hint}）— 可拖到画布指定位置`}
            className="flex h-8 w-8 cursor-grab items-center justify-center rounded-md text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
            onClick={() => addAtCenter(type)}
            onDragStart={(e) => {
              e.dataTransfer.setData(PALETTE_DRAG_TYPE, type);
              e.dataTransfer.effectAllowed = "copy";
            }}
          >
            {Icon ? <Icon className="h-4 w-4" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** 节点搜索：标题/正文匹配，点击定位（选中 + 运镜） */
function NodeSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const nodes = useCanvasStore((s) => s.nodes);
  const results = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return [];
    return nodes
      .filter(
        (n) =>
          (n.data.title ?? "").toLowerCase().includes(k) ||
          (n.data.body ?? "").slice(0, 120).toLowerCase().includes(k),
      )
      .slice(0, 8);
  }, [q, nodes]);

  const pick = (id: string) => {
    useCanvasStore.getState().selectNodes([id]);
    window.dispatchEvent(
      new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: [id] } }),
    );
    setQ("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className="flex h-10 w-52 items-center gap-1.5 rounded-lg border border-hairline bg-surface-1 px-2 shadow-sm">
        <Search className="h-3.5 w-3.5 shrink-0 text-text-4" />
        <input
          value={q}
          placeholder="搜索画布卡片…"
          className="w-full bg-transparent text-xs text-text outline-none placeholder:text-text-4"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results.length > 0) pick(results[0].id);
            if (e.key === "Escape") {
              setQ("");
              setOpen(false);
              e.currentTarget.blur();
            }
          }}
        />
      </div>
      {open && q.trim() && results.length > 0 ? (
        <div className="absolute left-0 top-full z-30 mt-1 w-56 rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
          {results.map((n) => (
            <button
              key={n.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
              onClick={() => pick(n.id)}
            >
              <span
                className="ws-card-dot shrink-0"
                style={{
                  background:
                    NODE_META[(n.data as { nodeType: WingNodeType }).nodeType]?.dot,
                }}
              />
              <span className="truncate">{n.data.title || "（无标题）"}</span>
              <span className="ml-auto shrink-0 text-[10px] text-text-4">
                {NODE_META[(n.data as { nodeType: WingNodeType }).nodeType]?.label}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 画风预设浏览（juben 风格模板库 86 条）：分类过滤 + 搜索，点选即套用。
 *  选中态 = 项目画风与该预设 prompt 完全一致；手改文本后高亮自动消失 */
function StylePresetList({
  projectStyle,
  onPick,
}: {
  projectStyle: string;
  onPick: (prompt: string) => void;
}) {
  const [cat, setCat] = useState<string>("全部");
  const [q, setQ] = useState("");
  const cats = ["全部", ...STYLE_CATEGORIES];
  const list = useMemo(() => {
    const kw = q.trim();
    return STYLE_PRESETS.filter(
      (p) =>
        (cat === "全部" || p.category === cat) &&
        (!kw || p.name.includes(kw) || p.tagline.includes(kw) || p.prompt.includes(kw)),
    );
  }, [cat, q]);
  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1">
        {cats.map((c) => (
          <button
            key={c}
            type="button"
            className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
              cat === c
                ? "bg-accent-dim font-medium text-text"
                : "text-text-3 hover:bg-surface-2 hover:text-text-2"
            }`}
            onClick={() => setCat(c)}
          >
            {c}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索画风…"
          className="nodrag nowheel ml-auto w-24 rounded border border-hairline bg-surface-2/60 px-1.5 py-0.5 text-[10px] text-text outline-none focus:border-accent placeholder:text-text-4"
        />
      </div>
      <div className="nowheel mt-2 grid min-h-0 flex-1 grid-cols-6 gap-2 overflow-y-auto rounded-md border border-hairline-soft bg-surface-2/40 p-2">
        {list.length === 0 ? (
          <p className="col-span-6 py-6 text-center text-[11px] text-text-4">没有匹配的画风</p>
        ) : null}
        {list.map((p) => {
          const active = projectStyle === p.prompt;
          return (
            <button
              key={p.id}
              type="button"
              title={`${p.name}｜${p.tagline || p.category}`}
              className={`group relative h-44 w-full overflow-hidden rounded-lg border transition-all ${
                active
                  ? "border-accent ring-2 ring-accent"
                  : "border-hairline hover:border-accent-soft"
              }`}
              onClick={() => onPick(p.prompt)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.cover}
                alt={p.name}
                loading="lazy"
                className="absolute inset-0 h-full w-full object-cover object-top"
              />
              {active ? (
                <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-accent text-[10px] font-bold text-surface-1">
                  ✓
                </span>
              ) : null}
              <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-left text-[11px] font-medium text-white">
                {p.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 底部坞：撤销/重做 + 缩放 + 素材库 + 画风 + 保存状态（对标 novanova / AIGC 的顶底栏能力） */
function BottomDock({
  onOpenAssets,
  onOpenPrompts,
  onOpenOutline,
}: {
  onOpenAssets: () => void;
  onOpenPrompts: () => void;
  onOpenOutline: () => void;
}) {
  const canUndo = useCanvasStore((s) => s.canUndoNow);
  const canRedo = useCanvasStore((s) => s.canRedoNow);
  const saveState = useCanvasStore((s) => s.saveState);
  const zoom = useCanvasStore((s) => s.viewport.zoom);
  const projectStyle = useCanvasStore((s) => s.projectStyle);
  const [stylePanel, setStylePanel] = useState(false);
  const [conflictPanel, setConflictPanel] = useState(false);
  const [resolving, setResolving] = useState(false);
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();

  /** 保存冲突两种解法：载入服务器版本（丢弃本地未保存改动）/ 强制覆盖 */
  const resolveConflict = async (mode: "reload" | "force") => {
    const st = useCanvasStore.getState();
    if (resolving || !st.projectId) return;
    setResolving(true);
    try {
      if (mode === "reload") {
        const canvas = await loadCanvas(st.projectId);
        if (canvas) {
          const clean = sanitizeCanvas(canvas.nodes as never, canvas.edges as never);
          st.replaceCanvas(
            clean.nodes as never,
            clean.edges as never,
            (canvas.viewport ?? { x: 0, y: 0, zoom: 1 }) as never,
          );
          useCanvasStore.setState({
            rev: canvas.revision ?? 0,
            projectStyle: String(canvas.meta?.visualStyle ?? ""),
            saveState: "saved",
          });
        }
      } else {
        const res = await saveCanvas(st.projectId, {
          nodes: st.nodes.map((n) => {
            const rest = { ...(n as Record<string, unknown>) };
            delete rest.selected;
            delete rest.dragging;
            return rest;
          }),
          edges: st.edges,
          viewport: st.viewport,
          meta: { visualStyle: st.projectStyle },
          force: true,
        });
        if (res.ok) {
          useCanvasStore.setState({ rev: res.revision ?? st.rev, saveState: "saved" });
          setConflictPanel(false);
        }
      }
    } finally {
      setResolving(false);
    }
  };
  const saveLabel =
    saveState === "saving"
      ? "保存中…"
      : saveState === "saved"
        ? "已保存"
        : saveState === "offline"
          ? "离线 · 未保存"
          : null;
  return (
    <>
      <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-hairline bg-surface-1 p-1 shadow-sm">
      <button
        type="button"
        title="素材库（生成历史自动入库，点击放回画布）"
        className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
        onClick={onOpenAssets}
      >
        <Library className="h-4 w-4" />
        素材库
      </button>
      <button
        type="button"
        title="提示词库（点击追加到生成输入区）"
        className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
        onClick={onOpenPrompts}
      >
        <WandSparkles className="h-4 w-4" />
        提示词
      </button>
      <button
        type="button"
        title="画布大纲（按类型浏览节点，点击定位）"
        className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
        onClick={onOpenOutline}
      >
        <ListTree className="h-4 w-4" />
        大纲
      </button>
      <span className="mx-0.5 h-5 w-px bg-hairline" />
      {/* 项目画风锚点（novanova visualStyle / viedeo-workflow styleAnchor）：
          一处设定，注入所有出图与分镜生成；预设库移植自 juben 风格模板 */}
      <div className="relative">
        <button
          type="button"
          title="项目画风（全局视觉风格：注入所有出图与分镜生成）"
          className={`flex h-8 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-surface-2 ${
            projectStyle ? "text-accent" : "text-text-2 hover:text-text"
          } ${stylePanel ? "bg-surface-2 text-text" : ""}`}
          onClick={() => setStylePanel((v) => !v)}
        >
          <Palette className="h-4 w-4" />
          画风
          {projectStyle ? (
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          ) : null}
        </button>
      </div>
      <span className="mx-0.5 h-5 w-px bg-hairline" />
      <DockBtn disabled={!canUndo} title="撤销（⌘Z）" onClick={() => useCanvasStore.getState().undo()}>
        <Undo2 className="h-4 w-4" />
      </DockBtn>
      <DockBtn disabled={!canRedo} title="重做（⇧⌘Z）" onClick={() => useCanvasStore.getState().redo()}>
        <Redo2 className="h-4 w-4" />
      </DockBtn>
      <span className="mx-0.5 h-5 w-px bg-hairline" />
      <DockBtn title="缩小（⌘-）" onClick={() => void zoomOut({ duration: 150 })}>
        <ZoomOut className="h-4 w-4" />
      </DockBtn>
      <button
        type="button"
        title="点击复位 100%（⌘0）"
        className="min-w-11 rounded-md px-1 py-1 text-center text-xs tabular-nums text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
        onClick={() => void zoomTo(1, { duration: 250 })}
      >
        {Math.round(zoom * 100)}%
      </button>
      <DockBtn title="放大（⌘=）" onClick={() => void zoomIn({ duration: 150 })}>
        <ZoomInIcon className="h-4 w-4" />
      </DockBtn>
      <DockBtn title="适应视图" onClick={() => void fitView({ duration: 300, padding: 0.15 })}>
        <Maximize className="h-4 w-4" />
      </DockBtn>
      {saveState === "conflict" ? (
        <>
          <span className="mx-0.5 h-5 w-px bg-hairline" />
          <button
            type="button"
            title="其他会话更新了画布，点击处理"
            className="rounded bg-danger px-1.5 py-0.5 text-[10px] font-medium text-white"
            onClick={() => setConflictPanel(true)}
          >
            保存冲突
          </button>
        </>
      ) : saveLabel ? (
        <>
          <span className="mx-0.5 h-5 w-px bg-hairline" />
          <span
            className={`px-1.5 text-[10px] ${
              saveState === "offline" ? "text-danger" : "text-good"
            }`}
          >
            {saveLabel}
          </span>
        </>
      ) : null}
      </div>
      {conflictPanel ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6"
          onClick={() => setConflictPanel(false)}
        >
          <div
            className="w-[26rem] rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold text-danger">保存冲突</p>
            <p className="mt-1.5 text-xs leading-5 text-text-2">
              另一个会话保存了更新版本的画布。本地改动尚未写入服务器，请选择处理方式：
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <button
                type="button"
                disabled={resolving}
                className="rounded-md border border-accent bg-accent-dim px-3 py-1.5 text-xs font-medium text-text transition-colors hover:bg-accent-soft disabled:opacity-40"
                onClick={() => void resolveConflict("reload")}
              >
                载入服务器版本（丢弃本地未保存改动）
              </button>
              <button
                type="button"
                disabled={resolving}
                className="rounded-md border border-hairline px-3 py-1.5 text-xs text-text-2 transition-colors hover:border-danger hover:text-danger disabled:opacity-40"
                onClick={() => void resolveConflict("force")}
              >
                强制覆盖服务器（以本地为准）
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {stylePanel ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6"
          onClick={() => setStylePanel(false)}
        >
          <div
            className="flex max-h-[88vh] w-[min(76rem,94vw)] flex-col rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-text">项目画风</p>
                <p className="mt-0.5 text-[11px] text-text-4">
                  全局视觉风格：自动注入所有资产出图、分镜生成与分镜出图。
                  点选预设即套用，也可在底部自定义描述。
                </p>
              </div>
              <button
                type="button"
                title="关闭"
                className="rounded-md p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
                onClick={() => setStylePanel(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <StylePresetList
              projectStyle={projectStyle}
              onPick={(prompt) => useCanvasStore.getState().setProjectStyle(prompt)}
            />
            <p className="mt-2 text-[11px] font-medium text-text-4">
              自定义（可直接改，或点上方预设套用）
            </p>
            <textarea
              value={projectStyle}
              onChange={(e) => useCanvasStore.getState().setProjectStyle(e.target.value)}
              placeholder="例：吉卜力水彩质感，柔和自然光，低饱和暖色"
              rows={2}
              className="nodrag nowheel mt-1 w-full resize-none rounded-md border border-hairline bg-surface-2/60 p-2 text-xs leading-relaxed text-text outline-none focus:border-accent placeholder:text-text-4"
            />
            <div className="mt-1 flex items-center justify-between">
              <span className="text-[11px] text-text-4">
                {projectStyle
                  ? `${projectStyle.length} 字 · 自动保存`
                  : "未设定（出图无风格约束）"}
              </span>
              <button
                type="button"
                className="rounded-md border border-hairline px-2 py-0.5 text-[11px] text-text-2 transition-colors hover:border-accent hover:text-text"
                onClick={() => setStylePanel(false)}
              >
                完成
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function DockBtn({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-md text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:text-text-4 disabled:hover:bg-transparent"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * 框选安全网：RF 的 onPointerCancel 只释放指针捕获、不清 userSelectionRect
 * （12.11.5 仍如此，上游未修）——浏览器把按压手势转成 pointercancel 或
 * pointerup 被漏掉时，选框会永久卡住（矩形跟手走、点击清不掉）。
 * 复位必须延迟到事件落定之后：RF 自己的 onPointerUp 是同步清理，且其中
 * "简单点击 → 清空选中"的分支依赖 rect 仍存在——抢先清掉会把点空白取消
 * 选中弄坏。setTimeout(0) 后 rect 仍在 = RF 没接住 = 真卡死，才复位。
 */
function SelectionGuard() {
  const store = useStoreApi();
  useEffect(() => {
    const resetIfStuck = () => {
      if (store.getState().userSelectionRect) {
        store.setState({ userSelectionActive: false, userSelectionRect: null });
      }
    };
    const deferredReset = () => {
      setTimeout(resetIfStuck, 0);
    };
    const onUp = (e: PointerEvent | MouseEvent) => {
      if (e.type === "pointercancel" || e.button === 0) deferredReset();
    };
    // mouseup 兜底：三指拖移等合成手势可能只发 mouse 系事件
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    // 失焦没有后续事件，立即复位
    window.addEventListener("blur", resetIfStuck);
    return () => {
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("blur", resetIfStuck);
    };
  }, [store]);
  return null;
}

/** 拖动对齐辅助线：流坐标 → 容器坐标渲染（数据来自 store.onNodesChange 的吸附计算） */
function GuideOverlay() {
  const guides = useCanvasStore((s) => s.alignGuides);
  const vp = useCanvasStore((s) => s.viewport);
  if (guides.x.length === 0 && guides.y.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
      {guides.x.map((x) => (
        <div
          key={`x${x}`}
          className="absolute top-0 bottom-0 w-px bg-accent-2"
          style={{ left: vp.x + x * vp.zoom }}
        />
      ))}
      {guides.y.map((y) => (
        <div
          key={`y${y}`}
          className="absolute left-0 right-0 h-px bg-accent-2"
          style={{ top: vp.y + y * vp.zoom }}
        />
      ))}
    </div>
  );
}

/** 多选浮动工具条：跟随选区包围盒顶部居中（对标 novanova / 影策的 selection toolbar） */
const ALIGN_MENU: {
  label: string;
  min: number;
  run: (ids: string[]) => void;
}[] = [
  { label: "左对齐", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "left") },
  { label: "水平居中", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "hcenter") },
  { label: "右对齐", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "right") },
  { label: "顶对齐", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "top") },
  { label: "垂直居中", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "vcenter") },
  { label: "底对齐", min: 2, run: (ids) => useCanvasStore.getState().alignNodes(ids, "bottom") },
  { label: "水平等距", min: 3, run: (ids) => useCanvasStore.getState().distributeNodes(ids, "h") },
  { label: "垂直等距", min: 3, run: (ids) => useCanvasStore.getState().distributeNodes(ids, "v") },
];

function SelBtn({
  danger,
  onClick,
  children,
}: {
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`nodrag rounded-md px-2 py-1 text-xs transition-colors ${
        danger ? "text-danger hover:bg-danger/10" : "text-text-2 hover:bg-surface-2 hover:text-text"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SelectionToolbar() {
  const nodes = useCanvasStore((s) => s.nodes);
  // 订阅视口：平移缩放后重算锚点（画布坐标 → 容器坐标 = vp + flow*zoom）
  const vp = useCanvasStore((s) => s.viewport);
  const [alignOpen, setAlignOpen] = useState(false);
  // 多选等比缩放（轻量版：宽度与水平间距等比；高度只在卡上已显式设置时跟随）
  const scaleRef = useRef<{
    startX: number;
    baseW: number;
    boxes: ReturnType<typeof selectionBoxes>;
    anchor: { x: number; y: number };
  } | null>(null);
  const sel = nodes.filter((n) => n.selected);
  if (sel.length < 2) return null;
  const ids = sel.map((n) => n.id);
  const boxes = selectionBoxes(nodes, ids);
  const minX = Math.min(...boxes.map((b) => b.x));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const anchor = {
    x: vp.x + ((minX + maxX) / 2) * vp.zoom,
    y: vp.y + minY * vp.zoom,
  };
  const seCorner = { x: vp.x + maxX * vp.zoom, y: vp.y + maxY * vp.zoom };

  const onScaleStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    useCanvasStore.getState().commitHistory();
    scaleRef.current = {
      startX: e.clientX,
      baseW: (maxX - minX) * vp.zoom,
      boxes: selectionBoxes(useCanvasStore.getState().nodes, ids),
      anchor: { x: minX, y: minY },
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onScaleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const base = scaleRef.current;
    if (!base) return;
    const ratio = Math.min(3, Math.max(0.35, (base.baseW + e.clientX - base.startX) / base.baseW));
    useCanvasStore.setState((s) => ({
      nodes: s.nodes.map((n) => {
        const b = base.boxes.find((x) => x.id === n.id);
        if (!b) return n;
        const w = Math.max(160, Math.round(b.w * ratio));
        const h = Math.max(120, Math.round(b.h * ratio));
        const absX = Math.round(base.anchor.x + (b.x - base.anchor.x) * ratio);
        const absY = Math.round(base.anchor.y + (b.y - base.anchor.y) * ratio);
        // 顶层 w/h 与 style 双写：xyflow 渲染/回写走顶层，style 留作默认尺寸语义
        return {
          ...n,
          position: { x: absX - b.dx, y: absY - b.dy },
          width: w,
          height: h,
          style: { ...n.style, width: w, height: h },
        };
      }),
    }));
  };

  return (
    <>
      <div
        className="absolute z-10 flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg"
        style={{ left: anchor.x, top: anchor.y - 10 }}
      >
        <span className="px-1.5 text-[10px] text-text-4">已选 {sel.length}</span>
        <SelBtn onClick={() => useCanvasStore.getState().copySelection()}>复制</SelBtn>
        <div className="relative">
          <SelBtn onClick={() => setAlignOpen((o) => !o)}>对齐 ▾</SelBtn>
          {alignOpen ? (
            <>
              <div className="fixed inset-0 z-0" onClick={() => setAlignOpen(false)} />
              <div className="absolute left-0 top-full z-10 mt-1 flex w-24 flex-col rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
                {ALIGN_MENU.map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    disabled={sel.length < a.min}
                    className="rounded-md px-2 py-1 text-left text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:text-text-4 disabled:hover:bg-transparent"
                    onClick={() => {
                      setAlignOpen(false);
                      a.run(ids);
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <SelBtn onClick={() => useCanvasStore.getState().groupNodes(ids)}>成组</SelBtn>
        <SelBtn danger onClick={() => useCanvasStore.getState().deleteNodes(ids)}>
          删除
        </SelBtn>
      </div>
      {/* 选区右下角：等比缩放手柄 */}
      <div
        title="拖动等比缩放选中卡片"
        className="absolute z-10 h-3 w-3 cursor-nwse-resize rounded-sm border-[1.5px] border-accent bg-surface-1 shadow-sm"
        style={{ left: seCorner.x - 6, top: seCorner.y - 6 }}
        onPointerDown={onScaleStart}
        onPointerMove={onScaleMove}
        onPointerUp={() => {
          scaleRef.current = null;
        }}
      />
    </>
  );
}

function EmptyState() {
  return (
    <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
      <div className="max-w-sm text-center">
        <h2 className="font-editorial text-xl font-medium text-text-2">
          空白画布
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-text-3">
          双击空白弹出「添加节点」菜单；把图片 / 视频 / 文本文件直接拖进来；
          <br />
          工具条（可拖拽落点）建卡，图片卡输入条 @ 引用角色直接生成，
          <br />
          或者让右侧助手帮你搭起故事板。
        </p>
      </div>
    </div>
  );
}

export default function CanvasView() {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const onNodesChange = useCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange);
  const onConnect = useCanvasStore((s) => s.onConnect);
  const addNode = useCanvasStore((s) => s.addNode);
  const viewport = useCanvasStore((s) => s.viewport);
  const clipboardCount = useCanvasStore((s) => s.clipboardCount);
  const canUndo = useCanvasStore((s) => s.canUndoNow);
  const canRedo = useCanvasStore((s) => s.canRedoNow);

  // 视口双向同步：agent 的 set_viewport / 项目装载 → 画布动画跟随；
  // 用户平移缩放 → 回写 store（供持久化与 agent 感知）。
  // ref 按值比较防回环：程序化 setViewport 结束也会触发 onMoveEnd。
  const { screenToFlowPosition, setViewport: setRfViewport, fitView } =
    useReactFlow();
  // dev 测试钩子：headless E2E 恢复视口用（onlyRenderVisibleElements 会把
  // 视口外节点卸载，聚焦平移后测试需要能把目标卡摆回视野）
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __wsSetViewport?: unknown }).__wsSetViewport =
        setRfViewport;
    }
  }, [setRfViewport]);
  const lastSyncedVp = useRef<Viewport>(viewport);
  useEffect(() => {
    if (vpEq(viewport, lastSyncedVp.current)) return;
    lastSyncedVp.current = viewport;
    void setRfViewport(viewport, { duration: 300 });
  }, [viewport, setRfViewport]);
  const onMoveEnd = useCallback<OnMoveEnd>((_event, vp) => {
    if (vpEq(vp, lastSyncedVp.current)) return;
    lastSyncedVp.current = vp;
    useCanvasStore.getState().setViewport(vp);
  }, []);

  // fitView prop 在 12.11 不是"只看挂载一次"：StoreUpdater 监听它，prop 值
  // 一旦翻转就 fitViewQueued=true 重新执行 fit——空画布建第一张卡时 false→true
  // 会把单卡怼满视口、放大顶到 maxZoom（400%）。所以挂载时取值后冻结，
  // 运行期节点数变化不再触碰这个 prop
  const [fitOnMount] = useState(nodes.length > 0);

  // 滚轮设备启发式（对标 open-ai-canvas）：外接鼠标滚轮是离散步进（≈100/120
  // 的整数倍），触控板双指是连续小步进。鼠标轮=缩放、双指=平移，动态切换
  // panOnScroll/zoomOnScroll；捏合与 ⌘+滚在两种模式下都是缩放，不参与判定。
  const [wheelMode, setWheelMode] = useState<"trackpad" | "mouse">("trackpad");
  const onWheelCapture = useCallback(
    (e: React.WheelEvent) => {
      // nowheel 动态化：xyflow 对 .nowheel 元素整体跳过滚轮，但我们把它贴在
      // 大量未必可滚动的容器上（文本区/行列表/选择器），导致节点上无法缩放。
      // 这里在 capture 阶段先行判定——目标链上有任一 nowheel 元素「真的可
      // 滚动」才滚内容；否则现场摘类（setTimeout 还原），赶在 xyflow 的
      // closest('.nowheel') 判定之前放行缩放
      let el = e.target as HTMLElement | null;
      const nws: HTMLElement[] = [];
      while (el && !el.classList.contains("react-flow")) {
        if (el.classList.contains("nowheel")) nws.push(el);
        el = el.parentElement;
      }
      if (nws.length > 0) {
        const anyScrollable = nws.some(
          (nw) =>
            nw.scrollHeight > nw.clientHeight ||
            nw.scrollWidth > nw.clientWidth,
        );
        if (anyScrollable) return;
        for (const nw of nws) {
          nw.classList.remove("nowheel");
          setTimeout(() => nw.classList.add("nowheel"), 0);
        }
      }
      if (e.ctrlKey || e.metaKey) return;
      const dy = Math.abs(e.deltaY);
      const m = dy % 100;
      const looksMouse =
        e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
        (dy >= 80 && (m <= 20 || m >= 80));
      const next: "mouse" | "trackpad" = looksMouse ? "mouse" : "trackpad";
      if (next === wheelMode) return;
      setWheelMode(next);
      // 切换后的首个事件仍挂在旧配置的 d3 处理器上，丢弃以免误平移/误缩放
      e.stopPropagation();
    },
    [wheelMode],
  );

  // Alt+拖拽复制（Figma 手势）：拖动开始时原位克隆选区，后续拖动帧在 store
  // 里改道到副本——原件留在原地，副本跟随指针走
  const onNodeDragStart = useCallback<OnNodeDrag<WingNode>>((event, node) => {
    if (event.altKey) {
      useCanvasStore.getState().beginAltDragClone(node.id);
    }
  }, []);
  const onNodeDragStop = useCallback(() => {
    useCanvasStore.getState().endAltDrag();
  }, []);

  // 键盘删除（deleteKeyCode）走 RF 的 deleteElements：在 remove 变更发出前
  // 提交快照，让 Backspace 删卡/删边也可撤销（右键菜单删除走 store.deleteNodes
  // 自带快照；节点+边同删时这里只进一次撤销步）
  const onBeforeDelete = useCallback<
    OnBeforeDelete<WingNode, WingEdge>
  >(async ({ nodes: delNodes, edges: delEdges }) => {
    if (delNodes.length > 0 || delEdges.length > 0) {
      useCanvasStore.getState().commitHistory();
    }
    return true;
  }, []);

  // 生成中的连线流动动画：目标节点 loading 时给边标 animated（样式在 globals.css）；
  // 同时按两端节点类型推导关系语义标签（出演/出图/拆解…）
  const loadingKey = useCanvasStore((s) =>
    s.nodes
      .filter((n) => n.data.status === "loading")
      .map((n) => n.id)
      .join(","),
  );
  // 相邻高亮（open-ai-canvas related 态）：hover/选中单卡时点亮它的连线与邻居
  const [hoverId, setHoverId] = useState<string | null>(null);
  const selectedKey = nodes
    .filter((n) => n.selected)
    .map((n) => n.id)
    .join(",");
  const related = useMemo(() => {
    const selected = selectedKey ? selectedKey.split(",") : [];
    return hoverId ?? (selected.length === 1 ? selected[0] : null);
  }, [hoverId, selectedKey]);
  const onNodeHover = useCallback(
    (_: React.MouseEvent, node: WingNode) => setHoverId(node.id),
    [],
  );
  const onNodeHoverEnd = useCallback(() => setHoverId(null), []);

  const displayEdges = useMemo(() => {
    const loading = new Set(loadingKey ? loadingKey.split(",") : []);
    // 折叠分组的边重接（对标 open-ai-canvas frame 折叠）：隐藏子卡的连线
    // 显示层改挂到组节点，展开自动还原（纯显示转换，不动数据）
    const hiddenToGroup = new Map<string, string>();
    for (const n of nodes) {
      if (!n.hidden || !n.parentId) continue;
      const parent = nodes.find((x) => x.id === n.parentId);
      if (parent?.data.collapsed) hiddenToGroup.set(n.id, n.parentId);
    }
    const wire = (id: string) => hiddenToGroup.get(id) ?? id;
    return edges.map((e) => {
      const src = wire(e.source);
      const tgt = wire(e.target);
      return {
        ...e,
        source: src,
        target: tgt,
        ...(loading.has(e.target) ? { animated: true } : {}),
        ...(related
          ? src === related || tgt === related
            ? { className: "ws-edge-related" }
            : {}
          : {}),
      };
    });
  }, [edges, loadingKey, nodes, related]);

  const displayNodes = useMemo(() => {
    if (!related) {
      const anyLocked = nodes.some((n) => n.data.locked);
      if (!anyLocked) return nodes;
      return nodes.map((n) => (n.data.locked ? { ...n, draggable: false } : n));
    }
    const relatedIds = new Set<string>([related]);
    for (const e of edges) {
      if (e.source === related) relatedIds.add(e.target);
      if (e.target === related) relatedIds.add(e.source);
    }
    return nodes.map((n) =>
      relatedIds.has(n.id)
        ? { ...n, className: "ws-node-related", ...(n.data.locked ? { draggable: false } : {}) }
        : { ...n, className: undefined, ...(n.data.locked ? { draggable: false } : {}) },
    );
  }, [nodes, edges, related]);

  // 连接校验：自环与重复边直接拒绝
  const isValidConnection = useCallback<IsValidConnection>((conn) => {
    if (conn.source === conn.target) return false;
    return !useCanvasStore
      .getState()
      .edges.some((e) => e.source === conn.source && e.target === conn.target);
  }, []);

  // 重接线：拖动已有连线端点换到新节点
  const onReconnect = useCallback<OnReconnect>((oldEdge, newConnection) => {
    useCanvasStore.getState().reconnectEdge(oldEdge.id, newConnection);
  }, []);

  // @引用光环：单选生成卡时高亮它引用的卡片（refIds 由 PromptBar 生成时写入）
  useEffect(() => {
    const sel = nodes.filter((n) => n.selected);
    const refs =
      sel.length === 1 && Array.isArray(sel[0].data.refIds)
        ? (sel[0].data.refIds as string[])
        : [];
    if (refs.join(",") === useCanvasStore.getState().haloIds.join(",")) return;
    useCanvasStore.getState().setHaloIds(refs);
  }, [nodes]);

  // agent 建卡 / "+" 建下游卡 → 视口聚焦到新节点（平移+缩放到可见）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onFocusNodes = (e: Event) => {
      const ids = (e as CustomEvent<FocusNodesDetail>).detail?.ids ?? [];
      if (ids.length === 0) return;
      // 等新节点渲染进 React Flow 后再运镜
      timer = setTimeout(() => {
        void fitView({
          nodes: ids.map((id) => ({ id })),
          duration: 450,
          padding: 0.25,
          maxZoom: 1,
        });
      }, 60);
    };
    window.addEventListener(FOCUS_NODES_EVENT, onFocusNodes);
    return () => {
      window.removeEventListener(FOCUS_NODES_EVENT, onFocusNodes);
      if (timer) clearTimeout(timer);
    };
  }, [fitView]);

  // 连线拖到空白处 → 弹建卡菜单（选中类型后建卡并自动连线）
  const [pendingLink, setPendingLink] = useState<{
    x: number;
    y: number;
    sourceId: string;
  } | null>(null);
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      // 有效连线交给 onConnect；落在节点上的无效连接（自环/重复）静默取消，
      // 只有落到空白处才弹"建卡并连线"菜单
      if (connectionState.isValid || connectionState.toNode) return;
      const sourceId = connectionState.fromNode?.id;
      if (!sourceId) return;
      const pos =
        "clientX" in event
          ? { x: event.clientX, y: event.clientY }
          : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      setPendingLink({ ...pos, sourceId });
    },
    [],
  );
  const createAt = useCallback(
    (type: WingNodeType) => {
      if (!pendingLink) return;
      const flow = screenToFlowPosition({
        x: pendingLink.x,
        y: pendingLink.y,
      });
      const id = addNode({
        position: { x: flow.x - 110, y: flow.y - 40 },
        data: { nodeType: type, title: NODE_META[type].hint, body: "" },
      });
      useCanvasStore.getState().connect({
        source: pendingLink.sourceId,
        target: id,
      });
      setPendingLink(null);
    },
    [pendingLink, addNode, screenToFlowPosition],
  );

  const linkMenuTypes: WingNodeType[] = [
    "note",
    "image",
    "video",
    "character",
  ];

  // ---------- 右键菜单（空白 / 节点 / 多选 / 连线） ----------
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const closeCtx = useCallback(() => setCtxMenu(null), []);

  // 素材库 / 提示词库 / 大纲面板（底部坞 / 右键空白 打开，三者互斥）
  const [trayOpen, setTrayOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  // 右键菜单触发的导演台 / 节点信息弹窗
  const [directorNode, setDirectorNode] = useState<WingNode | null>(null);
  const [infoNode, setInfoNode] = useState<WingNode | null>(null);
  // 卡片悬浮工具条「节点信息」→ 打开信息弹窗（工具条在 nodes.tsx，经事件总线）
  useEffect(() => {
    const onNodeInfo = (e: Event) => {
      const nid = (e as CustomEvent<NodeInfoDetail>).detail?.nodeId;
      const n = useCanvasStore.getState().nodes.find((x) => x.id === nid);
      if (n) setInfoNode(n);
    };
    window.addEventListener(NODE_INFO_EVENT, onNodeInfo);
    return () => window.removeEventListener(NODE_INFO_EVENT, onNodeInfo);
  }, []);

  useEffect(() => {
    if (!ctxMenu && !pendingLink) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      closeCtx();
      setPendingLink(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctxMenu, closeCtx, pendingLink]);

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent<Element> | MouseEvent) => {
      event.preventDefault();
      const flow = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      setCtxMenu({
        kind: "pane",
        x: event.clientX,
        y: event.clientY,
        fx: flow.x,
        fy: flow.y,
        sub: null,
      });
    },
    [screenToFlowPosition],
  );

  // 双击空白 → "添加节点"选择器（不预判用户要建哪种卡，对标 reference 的
  // 双击菜单）。这个 prop 落在 wrapper div 上，卡片留白/小地图/底部坞/输入条
  // 选词等双击都会冒泡上来，正向判定：目标必须在 pane 内且不在可交互元素上。
  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".react-flow__pane")) return;
      if (
        target.closest(
          ".react-flow__node, .react-flow__minimap, .react-flow__edge, .react-flow__controls, button, input, textarea, select, [contenteditable]",
        )
      ) {
        return;
      }
      const flow = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      setCtxMenu({
        kind: "add",
        x: event.clientX,
        y: event.clientY,
        fx: flow.x,
        fy: flow.y,
      });
    },
    [screenToFlowPosition],
  );

  const onNodeContextMenu = useCallback<NodeMouseHandler<WingNode>>(
    (event, node) => {
      event.preventDefault();
      const selected = nodes.filter((n) => n.selected);
      if (node.selected && selected.length > 1) {
        setCtxMenu({
          kind: "selection",
          x: event.clientX,
          y: event.clientY,
          ids: selected.map((n) => n.id),
        });
        return;
      }
      setCtxMenu({ kind: "node", x: event.clientX, y: event.clientY, id: node.id });
    },
    [nodes],
  );

  const onSelectionContextMenu = useCallback(
    (event: React.MouseEvent<Element>, selNodes: WingNode[]) => {
      event.preventDefault();
      setCtxMenu({
        kind: "selection",
        x: event.clientX,
        y: event.clientY,
        ids: selNodes.map((n) => n.id),
      });
    },
    [],
  );

  const onEdgeContextMenu = useCallback<EdgeMouseHandler>(
    (event, edge) => {
      event.preventDefault();
      setCtxMenu({ kind: "edge", x: event.clientX, y: event.clientY, id: edge.id });
    },
    [],
  );

  /** 双击选择器 / 右键"添加节点"共用：在菜单落点建卡 */
  const addAtCtx = useCallback(
    (type: WingNodeType) => {
      if (!ctxMenu || (ctxMenu.kind !== "pane" && ctxMenu.kind !== "add"))
        return;
      const id = addNode({
        position: { x: ctxMenu.fx - 110, y: ctxMenu.fy - 40 },
        data: { nodeType: type, title: NODE_META[type].hint, body: "" },
      });
      setCtxMenu(null);
      // 常驻编辑卡：建卡即把光标送入正文（文档型卡片零门槛开写）
      dispatchFocusEdit(id);
    },
    [ctxMenu, addNode],
  );

  // 右键"上传"：隐藏 input 触发系统选文件；落点先存 ref（系统对话框异步
  // 返回时菜单早已关闭，state 拿不到）
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadAtRef = useRef({ x: 0, y: 0 });
  const openUploadPicker = useCallback(() => {
    // 双击"添加节点"菜单（kind=add）与右键菜单（kind=pane）都带落点坐标
    const menu = ctxMenu;
    if (!menu || (menu.kind !== "pane" && menu.kind !== "add")) return;
    uploadAtRef.current = { x: menu.fx, y: menu.fy };
    setCtxMenu(null);
    fileInputRef.current?.click();
  }, [ctxMenu]);
  const onUploadPicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = [...(e.target.files ?? [])];
      e.target.value = "";
      if (files.length === 0) return;
      void importDroppedFiles(files, uploadAtRef.current);
    },
    [],
  );

  /** 复制指定节点：右键的节点可能不在选区内，先选中再复制 */
  const copyNodes = useCallback((ids: string[]) => {
    useCanvasStore.setState((s) => ({
      nodes: s.nodes.map((n) => ({ ...n, selected: ids.includes(n.id) })),
    }));
    useCanvasStore.getState().copySelection();
  }, []);

  const deleteEdge = useCallback((id: string) => {
    useCanvasStore.getState().commitHistory();
    useCanvasStore.setState((s) => ({
      edges: s.edges.filter((e) => e.id !== id),
    }));
  }, []);

  // ---------- 拖拽文件导入 / 工具条拖入建卡 ----------
  const onDragOver = useCallback((event: React.DragEvent) => {
    if (
      event.dataTransfer.types.includes("Files") ||
      event.dataTransfer.types.includes(PALETTE_DRAG_TYPE)
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  // 桌面文件悬停时的全画布接收态（对标 open-ai-canvas dropzone；enter/leave 计数防子元素抖动）
  const [dropHover, setDropHover] = useState(false);
  const dragDepth = useRef(0);
  const onWrapperDragEnter = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    dragDepth.current += 1;
    setDropHover(true);
  }, []);
  const onWrapperDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropHover(false);
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      dragDepth.current = 0;
      setDropHover(false);
      const paletteType = event.dataTransfer.getData(PALETTE_DRAG_TYPE);
      if (paletteType) {
        event.preventDefault();
        const flow = screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });
        addNode({
          position: { x: flow.x - 110, y: flow.y - 40 },
          data: {
            nodeType: paletteType as WingNodeType,
            title: NODE_META[paletteType as WingNodeType]?.hint ?? "新卡片",
            body: "",
          },
        });
        return;
      }
      if (!event.dataTransfer.files?.length) return;
      event.preventDefault();
      const flow = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      void importDroppedFiles([...event.dataTransfer.files], flow);
    },
    [screenToFlowPosition, addNode],
  );

  return (
    <div
      className="relative h-full w-full"
      onWheelCapture={onWheelCapture}
      onDragEnter={onWrapperDragEnter}
      onDragLeave={onWrapperDragLeave}
    >
      {dropHover ? (
        <div className="ws-dropzone">
          <div className="rounded-lg bg-surface-1 px-4 py-2 text-xs font-medium text-text shadow-lg">
            松手导入素材（图片 / 视频 / 音频 / 文本）
          </div>
        </div>
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,.txt,.md,.markdown"
        className="hidden"
        onChange={onUploadPicked}
      />
      {nodes.length === 0 ? <EmptyState /> : null}
      <SelectionToolbar />
      <NodeInputPanel />
      <GuideOverlay />
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onReconnect={onReconnect}
        edgesReconnectable
        onMoveEnd={onMoveEnd}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onBeforeDelete={onBeforeDelete}
        onPaneContextMenu={onPaneContextMenu}
        onNodeMouseEnter={onNodeHover}
        onNodeMouseLeave={onNodeHoverEnd}
        onNodeContextMenu={onNodeContextMenu}
        onSelectionContextMenu={onSelectionContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDoubleClick={onDoubleClick}
        // fitOnMount 挂载时取值后冻结（声明处有说明）：挂载时画布已有内容
        // （重挂载/热更新）则适配视图，否则走 defaultViewport；装载项目后的
        // 视口由 store.viewport 同步效应接管
        defaultViewport={{ x: 40, y: 40, zoom: 0.9 }}
        fitView={fitOnMount}
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.1}
        maxZoom={4}
        deleteKeyCode={["Backspace", "Delete"]}
        multiSelectionKeyCode={["Shift", "Meta"]}
        // 拖边端点重接线的命中半径（默认 10 太小不好抓）
        reconnectRadius={24}
        // 选中的边抬升到卡片之上：交叉密集时好点好拖
        elevateEdgesOnSelect
        // 左拖=框选的前提：panOnDrag 必须非 true（xyflow 12.11 守卫），中键=平移；
        // 右键拖不启用——macOS 的 contextmenu 在 mousedown 即触发，右拖平移会和
        // 右键菜单打架。平移途径：双指滚动 / Space+拖 / 中键拖。
        panOnDrag={[1]}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        // 1px 阈值区分点击与拖动，避免单击手抖污染撤销历史
        nodeDragThreshold={1}
        zoomOnScroll={wheelMode === "mouse"}
        panOnScroll={wheelMode === "trackpad"}
        zoomOnDoubleClick={false}
        snapToGrid
        snapGrid={[16, 16]}
        onlyRenderVisibleElements
        className="bg-transparent"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.4}
          color="var(--color-hairline)"
        />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          // 纸感主题：默认白底在米黄画布上是突兀的白块
          bgColor="var(--color-surface-2)"
          maskColor="color-mix(in oklab, var(--color-surface-1) 72%, transparent)"
          style={{
            borderRadius: 10,
            border: "1px solid var(--color-hairline)",
            boxShadow: "0 1px 3px oklch(0 0 0 / 0.06)",
          }}
          nodeColor={(n) => NODE_META[(n.data as { nodeType: WingNodeType }).nodeType]?.dot ?? "var(--color-warm)"}
          nodeStrokeColor="var(--color-hairline)"
        />
        <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5">
          <AddNodeToolbar />
          <NodeSearch />
        </div>
        <BottomDock
          onOpenAssets={() => {
            setTrayOpen(true);
            setPromptsOpen(false);
            setOutlineOpen(false);
          }}
          onOpenPrompts={() => {
            setPromptsOpen(true);
            setTrayOpen(false);
            setOutlineOpen(false);
          }}
          onOpenOutline={() => {
            setOutlineOpen(true);
            setTrayOpen(false);
            setPromptsOpen(false);
          }}
        />
        <SelectionGuard />
        <CanvasShortcuts />
        <ShortcutsModal />
        <ServiceBanner />
        <OfflineIndicator />
        <AssetAutoRecorder />
      </ReactFlow>
      {trayOpen ? <AssetTray onClose={() => setTrayOpen(false)} /> : null}
      {promptsOpen ? <PromptLibraryPanel onClose={() => setPromptsOpen(false)} /> : null}
      {outlineOpen ? <OutlinePanel onClose={() => setOutlineOpen(false)} /> : null}
      {directorNode ? (
        <DirectorPanel node={directorNode} onClose={() => setDirectorNode(null)} />
      ) : null}
      {infoNode ? (
        <NodeInfoModal node={infoNode} onClose={() => setInfoNode(null)} />
      ) : null}
      {pendingLink ? (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setPendingLink(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setPendingLink(null);
            }}
          />
          <div
            className="fixed z-30 flex flex-col rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg"
            style={{
              left: Math.min(pendingLink.x + 8, window.innerWidth - 140),
              top: Math.min(pendingLink.y + 8, window.innerHeight - 220),
            }}
          >
            <p className="px-2 py-1 text-[10px] text-text-4">建卡并连线</p>
            {linkMenuTypes.map((t) => (
              <button
                key={t}
                type="button"
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-2 hover:bg-surface-2 hover:text-text"
                onClick={() => createAt(t)}
              >
                <span
                  className="ws-card-dot"
                  style={{ background: NODE_META[t].dot }}
                />
                {NODE_META[t].label}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {ctxMenu ? (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={closeCtx}
            onContextMenu={(e) => {
              e.preventDefault();
              closeCtx();
            }}
          />
          <div
            className="fixed z-30 flex flex-col rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg"
            style={{
              left: Math.min(ctxMenu.x + 8, window.innerWidth - 180),
              top: Math.min(ctxMenu.y + 8, window.innerHeight - 300),
            }}
          >
            {ctxMenu.kind === "add" ? (
              <NodeAddMenu
                onPick={addAtCtx}
                onUpload={() => {
                  closeCtx();
                  openUploadPicker();
                }}
                onTray={() => {
                  setTrayOpen(true);
                  closeCtx();
                }}
              />
            ) : ctxMenu.kind === "pane" && ctxMenu.sub === "add" ? (
              <NodeAddMenu
                onPick={addAtCtx}
                onUpload={() => {
                  closeCtx();
                  openUploadPicker();
                }}
                onTray={() => {
                  setTrayOpen(true);
                  closeCtx();
                }}
              />
            ) : ctxMenu.kind === "pane" ? (
              <>
                <CtxItem
                  label="添加节点"
                  chevron
                  onClick={() => setCtxMenu({ ...ctxMenu, sub: "add" })}
                />
                <CtxItem label="上传" onClick={openUploadPicker} />
                <CtxItem
                  label="素材库…"
                  onClick={() => {
                    setTrayOpen(true);
                    closeCtx();
                  }}
                />
                <CtxSep />
                <CtxItem
                  label="撤销"
                  shortcut="⌘Z"
                  disabled={!canUndo}
                  onClick={() => {
                    useCanvasStore.getState().undo();
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="重做"
                  shortcut="⇧⌘Z"
                  disabled={!canRedo}
                  onClick={() => {
                    useCanvasStore.getState().redo();
                    closeCtx();
                  }}
                />
                <CtxSep />
                <CtxItem
                  label="粘贴"
                  shortcut="⌘V"
                  disabled={clipboardCount === 0}
                  onClick={() => {
                    useCanvasStore.getState().pasteClipboard();
                    closeCtx();
                  }}
                />
              </>
            ) : ctxMenu.kind === "node" ? (
              (() => {
                const node = nodes.find((n) => n.id === ctxMenu.id);
                const type = node?.data.nodeType;
                return (
                  <>
                    {type === "storyboard" || type === "video" ? (
                      <CtxItem
                        label="导演台"
                        icon={<Camera className="h-4 w-4" />}
                        onClick={() => {
                          if (node) setDirectorNode(node);
                          closeCtx();
                        }}
                      />
                    ) : null}
                    {type === "note" || type === "script" ? (
                      <CtxItem
                        label="AI 润色正文"
                        icon={<WandSparkles className="h-4 w-4" />}
                        disabled={!(node?.data.body ?? "").trim()}
                        onClick={() => {
                          window.dispatchEvent(
                            new CustomEvent<GenerateDetail>(GENERATE_EVENT, {
                              detail: {
                                nodeId: ctxMenu.id,
                                kind: "text",
                                prompt:
                                  "润色当前正文：保持原意与事实不变，优化文笔、节奏与画面感，直接输出润色后的全文。",
                                refIds: [],
                              },
                            }),
                          );
                          closeCtx();
                        }}
                      />
                    ) : null}
                    {type === "note" || type === "script" ? (
                      <CtxItem
                        label="复制正文"
                        disabled={!(node?.data.body ?? "").trim()}
                        onClick={() => {
                          void navigator.clipboard?.writeText(
                            node?.data.body ?? "",
                          );
                          closeCtx();
                        }}
                      />
                    ) : null}
                    <CtxItem
                      label="复制"
                      onClick={() => {
                        copyNodes([ctxMenu.id]);
                        closeCtx();
                      }}
                    />
                    <CtxItem
                      label={node?.data.locked ? "解锁" : "锁定"}
                      icon={
                        node?.data.locked ? (
                          <LockOpen className="h-4 w-4" />
                        ) : (
                          <Lock className="h-4 w-4" />
                        )
                      }
                      onClick={() => {
                        if (node)
                          useCanvasStore
                            .getState()
                            .updateNodeData(ctxMenu.id, {
                              locked: !node.data.locked,
                            });
                        closeCtx();
                      }}
                    />
                    <CtxItem
                      label="节点信息"
                      icon={<Info className="h-4 w-4" />}
                      onClick={() => {
                        if (node) setInfoNode(node);
                        closeCtx();
                      }}
                    />
                    <CtxItem
                      label="置顶"
                      onClick={() => {
                        useCanvasStore.getState().bringToFront([ctxMenu.id]);
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="置底"
                  onClick={() => {
                    useCanvasStore.getState().sendToBack([ctxMenu.id]);
                    closeCtx();
                  }}
                />
                {nodes.find((n) => n.id === ctxMenu.id)?.data.nodeType !==
                "group" ? (
                  <CtxItem
                    label="转换为…"
                    onClick={() =>
                      setCtxMenu({
                        kind: "convert",
                        x: ctxMenu.x,
                        y: ctxMenu.y,
                        id: ctxMenu.id,
                      })
                    }
                  />
                ) : null}
                {nodes.find((n) => n.id === ctxMenu.id)?.data.nodeType ===
                "group" ? (
                  <CtxItem
                    label="解散分组"
                    onClick={() => {
                      useCanvasStore.getState().ungroupNode(ctxMenu.id);
                      closeCtx();
                    }}
                  />
                ) : null}
                <CtxItem
                  label="删除"
                  danger
                  onClick={() => {
                    useCanvasStore.getState().deleteNodes([ctxMenu.id]);
                    closeCtx();
                  }}
                />
                  </>
                );
              })()
            ) : ctxMenu.kind === "convert" ? (
              <>
                <p className="px-2 py-1 text-[10px] text-text-4">转换为（保留内容与连线）</p>
                {CONVERT_TYPES.filter(
                  (t) =>
                    t !==
                    nodes.find((n) => n.id === ctxMenu.id)?.data.nodeType,
                ).map((t) => (
                  <CtxItem
                    key={t}
                    label={NODE_META[t].label}
                    dot={NODE_META[t].dot}
                    onClick={() => {
                      useCanvasStore.getState().convertNodeType(ctxMenu.id, t);
                      closeCtx();
                    }}
                  />
                ))}
              </>
            ) : ctxMenu.kind === "selection" ? (
              <>
                <CtxItem
                  label={`复制 ${ctxMenu.ids.length} 张`}
                  onClick={() => {
                    copyNodes(ctxMenu.ids);
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="打成一组"
                  onClick={() => {
                    useCanvasStore.getState().groupNodes(ctxMenu.ids);
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="置顶"
                  onClick={() => {
                    useCanvasStore.getState().bringToFront(ctxMenu.ids);
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="置底"
                  onClick={() => {
                    useCanvasStore.getState().sendToBack(ctxMenu.ids);
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="删除"
                  danger
                  onClick={() => {
                    useCanvasStore.getState().deleteNodes(ctxMenu.ids);
                    closeCtx();
                  }}
                />
              </>
            ) : (
              <CtxItem
                label="删除连线"
                danger
                onClick={() => {
                  deleteEdge(ctxMenu.id);
                  closeCtx();
                }}
              />
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
