"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type EdgeMouseHandler,
  type IsValidConnection,
  type NodeMouseHandler,
  type OnConnectEnd,
  type OnMoveEnd,
  type OnReconnect,
  type Viewport,
} from "@xyflow/react";
import {
  Clapperboard,
  Drama,
  Film,
  Image as ImageIcon,
  Redo2,
  ScrollText,
  Search,
  StickyNote,
  Undo2,
  ZoomIn as ZoomInIcon,
  ZoomOut,
  Maximize,
} from "lucide-react";
import {
  selectAllNodes,
  selectionBoxes,
  NODE_META,
  useCanvasStore,
  type WingNode,
  type WingNodeType,
} from "@/lib/canvas/store";
import { FOCUS_NODES_EVENT, type FocusNodesDetail } from "@/lib/canvas/events";
import { uploadAsset } from "@/lib/projects";
import { nodeTypes } from "./nodes";
import CanvasShortcuts from "./CanvasShortcuts";

/** 视口相等判断（按值比较，防程序化 setViewport 与 store 回写互触发） */
const vpEq = (a: Viewport, b: Viewport) =>
  a.x === b.x && a.y === b.y && a.zoom === b.zoom;

/** 右键菜单（空白 / 节点 / 转换 / 多选 / 连线 五态） */
type CtxMenu =
  | { kind: "pane"; x: number; y: number; fx: number; fy: number }
  | { kind: "node"; x: number; y: number; id: string }
  | { kind: "convert"; x: number; y: number; id: string }
  | { kind: "selection"; x: number; y: number; ids: string[] }
  | { kind: "edge"; x: number; y: number; id: string };

/** 边箭头（中性暖灰，明暗主题都成立；SVG 填充属性不支持 CSS 变量） */
const DEFAULT_EDGE_OPTS = {
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 15,
    height: 15,
    color: "#9a948a",
  },
} as const;

/** 关系语义标签：按两端节点类型自动推导（对标 AIGC 的边数据标签，域化为影视关系） */
const AUTO_EDGE_LABELS: Record<string, string> = {
  "script->storyboard": "拆解",
  "script->character": "设定",
  "script->note": "备注",
  "character->storyboard": "出演",
  "character->image": "定妆",
  "character->video": "出演",
  "storyboard->image": "出图",
  "storyboard->video": "出视频",
  "storyboard->storyboard": "转场",
  "image->video": "动态化",
  "image->image": "迭代",
  "video->video": "拼接",
  "note->storyboard": "参考",
  "note->image": "参考",
};

/** 连接校验：禁自环与重复边（对标 osc 的 connection rules，取最常用两条） */
const CONVERT_TYPES: WingNodeType[] = [
  "note",
  "script",
  "character",
  "image",
  "video",
  "storyboard",
];

function CtxItem({
  label,
  dot,
  danger,
  disabled,
  onClick,
}: {
  label: string;
  dot?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
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
      ) : null}
      {label}
    </button>
  );
}

/** 拖拽导入：图片→上传建 image 卡；.txt/.md→文本卡（md 当剧本、txt 当便签） */
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
  const items: { type: WingNodeType; icon: React.ReactNode }[] = [
    { type: "note", icon: <StickyNote className="h-4 w-4" /> },
    { type: "script", icon: <ScrollText className="h-4 w-4" /> },
    { type: "character", icon: <Drama className="h-4 w-4" /> },
    { type: "storyboard", icon: <Clapperboard className="h-4 w-4" /> },
    { type: "image", icon: <ImageIcon className="h-4 w-4" /> },
    { type: "video", icon: <Film className="h-4 w-4" /> },
  ];
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
      {items.map(({ type, icon }) => (
        <button
          key={type}
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
          {icon}
        </button>
      ))}
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

/** 底部坞：撤销/重做 + 缩放 + 保存状态（对标 novanova / AIGC 的顶底栏能力） */
function BottomDock() {
  const canUndo = useCanvasStore((s) => s.canUndoNow);
  const canRedo = useCanvasStore((s) => s.canRedoNow);
  const saveState = useCanvasStore((s) => s.saveState);
  const zoom = useCanvasStore((s) => s.viewport.zoom);
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const saveLabel =
    saveState === "saving"
      ? "保存中…"
      : saveState === "saved"
        ? "已保存"
        : saveState === "offline"
          ? "离线 · 未保存"
          : null;
  return (
    <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-hairline bg-surface-1 p-1 shadow-sm">
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
      {saveLabel ? (
        <>
          <span className="mx-0.5 h-5 w-px bg-hairline" />
          <span
            className={`px-1.5 text-[10px] ${
              saveState === "offline"
                ? "text-danger"
                : saveState === "saving"
                  ? "text-text-3"
                  : "text-good"
            }`}
          >
            {saveLabel}
          </span>
        </>
      ) : null}
    </div>
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
        const absX = Math.round(base.anchor.x + (b.x - base.anchor.x) * ratio);
        const absY = Math.round(base.anchor.y + (b.y - base.anchor.y) * ratio);
        const h = n.style?.height
          ? Math.max(120, Math.round((Number(n.style.height) || b.h) * ratio))
          : undefined;
        return {
          ...n,
          position: { x: absX - b.dx, y: absY - b.dy },
          style: { ...n.style, width: w, ...(h !== undefined ? { height: h } : {}) },
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
          双击画布加便签；把图片 / 视频 / 文本文件直接拖进来；
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

  // 视口双向同步：agent 的 set_viewport / 项目装载 → 画布动画跟随；
  // 用户平移缩放 → 回写 store（供持久化与 agent 感知）。
  // ref 按值比较防回环：程序化 setViewport 结束也会触发 onMoveEnd。
  const { screenToFlowPosition, setViewport: setRfViewport, fitView } =
    useReactFlow();
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

  // 生成中的连线流动动画：目标节点 loading 时给边标 animated（样式在 globals.css）；
  // 同时按两端节点类型推导关系语义标签（出演/出图/拆解…）
  const loadingKey = useCanvasStore((s) =>
    s.nodes
      .filter((n) => n.data.status === "loading")
      .map((n) => n.id)
      .join(","),
  );
  const displayEdges = useMemo(() => {
    const loading = new Set(loadingKey ? loadingKey.split(",") : []);
    const typeById = new Map(nodes.map((n) => [n.id, n.data.nodeType] as const));
    return edges.map((e) => ({
      ...e,
      ...(loading.has(e.target) ? { animated: true } : {}),
      label: AUTO_EDGE_LABELS[`${typeById.get(e.source)}->${typeById.get(e.target)}`],
    }));
  }, [edges, loadingKey, nodes]);

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

  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      // 用 screenToFlowPosition 换算落点（原先按 clientX 硬编码偏移，平移/缩放后会飘）
      const flow = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      addNode({
        position: { x: flow.x - 110, y: flow.y - 40 },
        data: { nodeType: "note", title: "新便签", body: "" },
      });
    },
    [addNode, screenToFlowPosition],
  );

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
    "character",
    "storyboard",
    "image",
    "video",
  ];

  // ---------- 右键菜单（空白 / 节点 / 多选 / 连线） ----------
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const closeCtx = useCallback(() => setCtxMenu(null), []);

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

  const addAtCtx = useCallback(
    (type: WingNodeType) => {
      if (ctxMenu?.kind !== "pane") return;
      addNode({
        position: { x: ctxMenu.fx - 110, y: ctxMenu.fy - 40 },
        data: { nodeType: type, title: NODE_META[type].hint, body: "" },
      });
      setCtxMenu(null);
    },
    [ctxMenu, addNode],
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

  const onDrop = useCallback(
    (event: React.DragEvent) => {
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
    <div className="relative h-full w-full">
      {nodes.length === 0 ? <EmptyState /> : null}
      <SelectionToolbar />
      <GuideOverlay />
      <ReactFlow
        nodes={nodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={DEFAULT_EDGE_OPTS}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onReconnect={onReconnect}
        edgesReconnectable
        onMoveEnd={onMoveEnd}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onSelectionContextMenu={onSelectionContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDoubleClick={onDoubleClick}
        defaultViewport={{ x: 40, y: 40, zoom: 0.9 }}
        fitView={nodes.length > 0}
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.1}
        maxZoom={3}
        deleteKeyCode={["Backspace", "Delete"]}
        multiSelectionKeyCode={["Shift", "Meta"]}
        selectionOnDrag
        panOnScroll
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
          nodeColor={(n) => NODE_META[(n.data as { nodeType: WingNodeType }).nodeType]?.dot ?? "var(--color-warm)"}
          nodeStrokeColor="var(--color-hairline)"
        />
        <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5">
          <AddNodeToolbar />
          <NodeSearch />
        </div>
        <BottomDock />
        <CanvasShortcuts />
      </ReactFlow>
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
            {ctxMenu.kind === "pane" ? (
              <>
                <p className="px-2 py-1 text-[10px] text-text-4">在此处添加</p>
                {(
                  ["note", "script", "character", "storyboard", "image", "video"] as WingNodeType[]
                ).map((t) => (
                  <CtxItem
                    key={t}
                    label={NODE_META[t].label}
                    dot={NODE_META[t].dot}
                    onClick={() => addAtCtx(t)}
                  />
                ))}
                <CtxItem
                  label="粘贴"
                  disabled={clipboardCount === 0}
                  onClick={() => {
                    useCanvasStore.getState().pasteClipboard();
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="全选"
                  onClick={() => {
                    selectAllNodes();
                    closeCtx();
                  }}
                />
                <CtxItem
                  label="适应视图"
                  onClick={() => {
                    void fitView({ duration: 300, padding: 0.15 });
                    closeCtx();
                  }}
                />
              </>
            ) : ctxMenu.kind === "node" ? (
              <>
                <CtxItem
                  label="复制"
                  onClick={() => {
                    copyNodes([ctxMenu.id]);
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
