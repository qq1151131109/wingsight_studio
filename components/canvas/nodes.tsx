"use client";

import { memo, useEffect, useRef, useState } from "react";
import {
  Handle,
  NodeResizer,
  NodeToolbar,
  Position,
  type NodeProps,
} from "@xyflow/react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Download,
  Expand,
  Film,
  Maximize2,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
  ZoomIn,
} from "lucide-react";
import {
  NODE_FOOTPRINT,
  NODE_META,
  absolutePosition,
  useCanvasStore,
  type WingNodeData,
  type WingNodeType,
} from "@/lib/canvas/store";
import { FOCUS_NODES_EVENT } from "@/lib/canvas/events";
import { uploadAsset } from "@/lib/projects";
import PromptBar from "./PromptBar";

/** 重试生成事件：image 卡 error 态发出，CanvasAgentBridge 监听并转成聊天指令 */
export const RETRY_GENERATION_EVENT = "wingsight:retry-generation";

/** 工具条上"复制/删除"的语义：节点在多选内则作用于整个选区，否则只作用本卡 */
function selectionIdsOr(id: string): string[] {
  const sel = useCanvasStore
    .getState()
    .nodes.filter((n) => n.selected)
    .map((n) => n.id);
  return sel.includes(id) && sel.length > 1 ? sel : [id];
}

/** 从一张卡右侧建下游卡并自动连线（AIGCCanvasFlow 的 hover "+" 模式） */
function createConnectedNode(sourceId: string, type: WingNodeType) {
  const st = useCanvasStore.getState();
  const src = st.nodes.find((n) => n.id === sourceId);
  if (!src) return;
  const abs = absolutePosition(st.nodes, src);
  const fp = NODE_FOOTPRINT[src.data.nodeType] ?? NODE_FOOTPRINT.note;
  const id = st.addNode({
    position: { x: abs.x + fp.w + 60, y: abs.y },
    data: { nodeType: type, title: NODE_META[type].hint, body: "" },
  });
  st.connect({ source: sourceId, target: id });
  useCanvasStore.getState().selectNodes([id]);
  window.dispatchEvent(
    new CustomEvent(FOCUS_NODES_EVENT, { detail: { ids: [id] } }),
  );
}

const PLUS_MENU_TYPES: WingNodeType[] = [
  "note",
  "character",
  "storyboard",
  "image",
  "video",
];

function ToolButton({
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
      className={`nodrag nowheel flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
        danger ? "text-danger hover:bg-danger/10" : "text-text-2 hover:bg-surface-2 hover:text-text"
      }`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function CardShell({
  id,
  children,
  selected,
  aspect,
}: {
  id: string;
  children: React.ReactNode;
  selected: boolean;
  /** 就绪的图片/视频锁定宽高比缩放 */
  aspect?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  // agent 建卡后的瞬时高亮（选择器返回布尔，未命中的卡不重渲）
  const flashing = useCanvasStore((s) => s.flashIds.includes(id));
  // LOD：低缩放时只留徽标+标题（布尔选择器，只有跨阈值才触发重渲）
  const tiny = useCanvasStore((s) => s.viewport.zoom < 0.5);
  // @引用光环：被选中生成卡引用时点亮
  const halo = useCanvasStore((s) => s.haloIds.includes(id));
  return (
    <div
      className={`ws-card group relative flex h-full w-full flex-col p-3 ${selected ? "selected" : ""} ${flashing ? "ws-flash" : ""} ${tiny ? "is-tiny" : ""} ${halo ? "ws-ref-halo" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPlusOpen(false);
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
      <Handle type="target" position={Position.Top} />
      <NodeToolbar isVisible={selected || hovered} position={Position.Top} offset={6}>
        <div className="flex items-center gap-0.5 rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
          <ToolButton
            title="复制"
            onClick={() => {
              const ids = selectionIdsOr(id);
              useCanvasStore.setState((s) => ({
                nodes: s.nodes.map((n) => ({ ...n, selected: ids.includes(n.id) })),
              }));
              useCanvasStore.getState().copySelection();
            }}
          >
            <Copy className="h-3.5 w-3.5" />
          </ToolButton>
          <ToolButton
            title="删除"
            danger
            onClick={() => useCanvasStore.getState().deleteNodes(selectionIdsOr(id))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </ToolButton>
        </div>
      </NodeToolbar>
      {children}
      <Handle type="source" position={Position.Bottom} />
      {/* hover 出现的"+"：一键建下游卡并连线 */}
      <button
        type="button"
        title="建下游卡并连线"
        className="nodrag absolute -right-3 top-1/2 z-10 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full border border-hairline bg-surface-1 text-text-3 opacity-0 shadow-sm transition-opacity hover:border-accent hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          setPlusOpen((o) => !o);
        }}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {plusOpen ? (
        <div className="absolute left-full top-0 z-10 ml-2 flex w-24 flex-col rounded-lg border border-hairline bg-surface-1 p-1 shadow-lg">
          <p className="px-2 py-0.5 text-[10px] text-text-4">建下游卡</p>
          {PLUS_MENU_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className="nodrag nowheel flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
              onClick={(e) => {
                e.stopPropagation();
                setPlusOpen(false);
                createConnectedNode(id, t);
              }}
            >
              <span className="ws-card-dot" style={{ background: NODE_META[t].dot }} />
              {NODE_META[t].label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Badge({ nodeType }: { nodeType: WingNodeData["nodeType"] }) {
  const meta = NODE_META[nodeType];
  return (
    <span className="ws-card-badge">
      <span className="ws-card-dot" style={{ background: meta.dot }} />
      {meta.label}
    </span>
  );
}

/** 长文放大编辑模态（对标影策"放大编辑"）：Ctrl+Enter 保存、Esc 取消 */
function LargeTextEditor({
  title,
  value,
  onSave,
  onClose,
}: {
  title: string;
  value: string;
  onSave: (next: string) => void;
  onClose: () => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex h-[72vh] w-full max-w-2xl flex-col rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-4">
          <h3 className="font-editorial text-sm font-semibold text-text">
            {title}
          </h3>
          <span className="shrink-0 text-[10px] text-text-4">
            Ctrl+Enter 保存 · Esc 取消
          </span>
        </div>
        <textarea
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              onSave(v);
              onClose();
            }
          }}
          className="nowheel flex-1 w-full resize-none rounded-lg border border-hairline bg-surface-2 p-3 text-sm leading-relaxed text-text outline-none focus:border-accent"
        />
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-hairline px-3 py-1.5 text-xs text-text-2 transition-colors hover:bg-surface-2"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded-md border border-accent bg-accent-dim px-3 py-1.5 text-xs text-text transition-colors hover:bg-accent-soft"
            onClick={() => {
              onSave(v);
              onClose();
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 就地编辑文本块：双击进入编辑（nodrag/nowheel 避免触发画布手势），
 * 单行模式 Enter、多行模式 Ctrl+Enter 或失焦保存，Esc 取消。统一用 textarea。
 * expandable：hover 出"放大编辑"按钮，长文进大模态改。
 */
function Editable({
  value,
  onSave,
  className,
  multiline,
  placeholder,
  expandable,
  label,
}: {
  value: string;
  onSave: (next: string) => void;
  className?: string;
  multiline?: boolean;
  placeholder?: string;
  expandable?: boolean;
  label?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <div className="group relative">
        <div
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          className={`cursor-text rounded-sm hover:bg-accent-dim ${className ?? ""}`}
          title="双击编辑"
        >
          {value || <span className="italic text-text-4">{placeholder}</span>}
        </div>
        {expandable ? (
          <button
            type="button"
            title="放大编辑"
            className="nodrag absolute right-0 top-0 rounded p-0.5 text-text-4 opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(true);
            }}
          >
            <Expand className="h-3 w-3" />
          </button>
        ) : null}
        {expanded ? (
          <LargeTextEditor
            title={label ?? "编辑内容"}
            value={value}
            onSave={(next) => {
              const t = next.trim();
              if (t !== value) onSave(t);
            }}
            onClose={() => setExpanded(false)}
          />
        ) : null}
      </div>
    );
  }

  const commit = () => {
    setEditing(false);
    const next = (ref.current?.value ?? "").trim();
    if (next !== value) onSave(next);
  };

  return (
    <textarea
      ref={ref}
      defaultValue={value}
      autoFocus
      rows={multiline ? Math.min(10, Math.max(3, value.split("\n").length)) : 1}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") setEditing(false);
        if (e.key === "Enter" && (multiline ? e.ctrlKey || e.metaKey : true)) {
          commit();
        }
      }}
      className={`nodrag nowheel w-full resize-none rounded-sm border border-accent bg-surface-2 px-1 py-0.5 leading-inherit outline-none ${
        multiline ? "" : "whitespace-nowrap overflow-hidden"
      }`}
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
  const m = url.match(/\.(png|jpe?g|webp|gif|mp4|webm|mov)(?:\?|$)/i);
  const ext = m ? m[1].toLowerCase().replace("jpeg", "jpg") : fallbackExt;
  const safe = (title || "").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 40);
  return `${safe || "wingsight"}.${ext}`;
}

/** 便签 / 角色卡：紧凑文本卡 + 就地编辑 */
function TextCard({
  data,
  id,
  selected,
  editorial,
  scrollBody,
}: {
  data: WingNodeData;
  id: string;
  selected: boolean;
  editorial?: boolean;
  scrollBody?: boolean;
}) {
  // 防御：历史/异常数据缺字段时跳过渲染，不让单个节点拖垮整棵树
  if (!data || typeof data.nodeType !== "string") return null;
  const update = makeUpdater(id);
  return (
    <CardShell id={id} selected={selected}>
      <Badge nodeType={data.nodeType} />
      <Editable
        value={data.title}
        onSave={(title) => update({ title })}
        className={`mt-1.5 line-clamp-2 text-sm font-semibold text-text ${
          editorial ? "font-editorial" : ""
        }`}
        placeholder="（无标题）"
      />
      <Editable
        value={data.body}
        onSave={(body) => update({ body })}
        multiline
        expandable
        label="正文"
        placeholder="（空）"
        className={`ws-detail mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-text-2 ${
          scrollBody ? "max-h-48 overflow-auto nowheel" : "line-clamp-6"
        }`}
      />
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
      scrollBody
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
    <CardShell id={id} selected={selected} aspect={Boolean(d.imageUrl)}>
      <Badge nodeType="character" />
      <div className="ws-detail mt-1.5 flex h-40 min-h-40 w-full items-center justify-center overflow-hidden rounded-md border border-hairline-soft bg-surface-2">
        {d.imageUrl ? (
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
            />
            <span className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
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
            </span>
          </button>
        ) : uploading ? (
          <span className="text-xs text-text-3">上传中…</span>
        ) : (
          <button
            type="button"
            className="nodrag flex flex-col items-center gap-1.5 px-4 text-center text-text-4 hover:text-text-3"
            onClick={(e) => {
              e.stopPropagation();
              fileRef.current?.click();
            }}
          >
            <span className="text-xl">🎭</span>
            <span className="text-xs">
              上传定妆照
              <br />
              （角色一致性锚点）
            </span>
          </button>
        )}
      </div>
      <Editable
        value={d.title}
        onSave={(title) => update({ title })}
        className="mt-1.5 line-clamp-1 text-sm font-semibold text-text"
        placeholder="角色名"
      />
      <Editable
        value={d.body}
        onSave={(body) => update({ body })}
        multiline
        expandable
        label="角色设定"
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

/** 图片放大预览：点击遮罩或 Esc 关闭 */
/** 图片放大预览：支持画布内全部图片翻页（←/→ 或按钮），点击遮罩或 Esc 关闭 */
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "ArrowRight" && index < images.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onIndex, index, images.length]);
  const cur = images[index];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8"
      onClick={onClose}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={cur?.src}
        alt={cur?.title}
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
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

/** 图片卡：占位（输入条生成）/ loading 进度 / error 重试 / ready（放大 + 重生成 + 复制提示词） */
function ImageCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const update = makeUpdater(id);
  // 放大查看：进入时快照画布全部图片（可翻页）
  const [zoom, setZoom] = useState<number | null>(null);
  const [gallery, setGallery] = useState<{ src: string; title: string }[]>([]);
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

  return (
    <CardShell id={id} selected={selected} aspect={d.status === "ready"}>
      <Badge nodeType="image" />
      <div className="mt-1.5 flex h-36 min-h-36 w-full flex-1 items-center justify-center overflow-hidden rounded-md border border-hairline-soft bg-surface-2">
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
            />
            <span className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
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
            </span>
          </button>
        ) : (
          <span className="text-xs text-text-4">🎨 {d.title || "图片占位"}</span>
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
      {!d.status && !d.imageUrl ? <PromptBar nodeId={id} kind="image" /> : null}
      {zoom !== null && gallery.length > 0 ? (
        <Lightbox
          images={gallery}
          index={zoom}
          onIndex={setZoom}
          onClose={() => setZoom(null)}
        />
      ) : null}
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

/** 抽帧：等距取 count 帧缩略图 dataURL（同源视频不污染画布） */
async function extractVideoFrames(
  src: string,
  count: number,
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
  const w = 96;
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
    out.push({ t, data: canvas.toDataURL("image/jpeg", 0.72) });
  }
  return out;
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
  // 就绪后抽 6 帧缩略图（异步；失败静默——跨域或解码不支持就不出条）
  useEffect(() => {
    const url = (data as WingNodeData | undefined)?.videoUrl;
    if (!url || framesFor.current === url) return;
    framesFor.current = url;
    void (async () => {
      try {
        setFrames(await extractVideoFrames(url, 6));
      } catch {
        setFrames([]);
      }
    })();
  }, [data]);
  // 防御：异常数据不渲染（hooks 已在上，顺序稳定）
  if (!d || typeof d.nodeType !== "string") return null;

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

  return (
    <CardShell id={id} selected={selected} aspect={d.status === "ready"}>
      <Badge nodeType="video" />
      <div className="mt-1.5 flex h-44 min-h-44 w-full flex-1 items-center justify-center overflow-hidden rounded-md border border-hairline-soft bg-surface-2">
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
            <span className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
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
            </span>
          </div>
        ) : uploading ? (
          <span className="text-xs text-text-3">上传中…</span>
        ) : (
          <button
            type="button"
            className="nodrag flex flex-col items-center gap-1.5 px-4 text-center text-text-4 hover:text-text-3"
            onClick={(e) => {
              e.stopPropagation();
              fileRef.current?.click();
            }}
          >
            <Film className="h-5 w-5" />
            <span className="text-xs">
              点击上传视频
              <br />
              或用下方输入条让 AI 生成
            </span>
          </button>
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
      {/* 抽帧条：hover 某帧出"+图"，点击抽原生分辨率帧建连线图片卡 */}
      {d.videoUrl && frames.length > 0 ? (
        <div className="ws-detail nowheel mt-1 flex gap-1 overflow-x-auto">
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
      {!d.status && !d.videoUrl ? <PromptBar nodeId={id} kind="video" /> : null}
      {zoom && d.videoUrl ? (
        <VideoLightbox src={d.videoUrl} onClose={() => setZoom(false)} />
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

/** 分镜卡字段 chip：双击就地编辑（镜号 / 景别 / 运镜 / 时长共用） */
function ShotChip({
  label,
  value,
  onSave,
}: {
  label: string;
  value: string;
  onSave: (v: string) => void;
}) {
  return (
    <span className="inline-flex min-w-11 items-center gap-1 rounded border border-hairline bg-surface-2 px-1 text-[10px] leading-4 text-text-3">
      <span className="text-text-4">{label}</span>
      <Editable
        value={value}
        onSave={onSave}
        placeholder="—"
        className="min-w-6 text-text-2"
      />
    </span>
  );
}

/** 分镜卡：宽卡 + 镜号/景别/运镜/时长字段行 + 台词 + 衬线编辑风 */
function StoryboardCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const update = makeUpdater(id);
  if (!d || typeof d.nodeType !== "string") return null;
  return (
    <CardShell id={id} selected={selected}>
      <div className="flex items-center justify-between gap-2">
        <Badge nodeType="storyboard" />
      </div>
      <div className="ws-detail mt-1.5 flex flex-wrap gap-1">
        <ShotChip label="镜号" value={d.shotNumber ?? ""} onSave={(shotNumber) => update({ shotNumber })} />
        <ShotChip label="景别" value={d.shotSize ?? ""} onSave={(shotSize) => update({ shotSize })} />
        <ShotChip label="运镜" value={d.cameraMove ?? ""} onSave={(cameraMove) => update({ cameraMove })} />
        <ShotChip label="时长" value={d.duration ?? ""} onSave={(duration) => update({ duration })} />
      </div>
      <Editable
        value={d.title}
        onSave={(title) => update({ title })}
        className="font-editorial mt-1.5 line-clamp-2 text-sm font-semibold text-text"
        placeholder="镜头标题"
      />
      <Editable
        value={d.body}
        onSave={(body) => update({ body })}
        multiline
        expandable
        label="画面描述"
        placeholder="画面描述（谁、在哪、做什么）"
        className="ws-detail nowheel mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-text-2"
      />
      <Editable
        value={d.dialogue ?? ""}
        onSave={(dialogue) => update({ dialogue })}
        multiline
        expandable
        label="台词 / 旁白"
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
        <span
          className="ws-card-dot shrink-0"
          style={{ background: NODE_META.group.dot }}
        />
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

export const nodeTypes = {
  note: memo(NoteCard),
  script: memo(ScriptCard),
  character: memo(CharacterCard),
  image: memo(ImageCard),
  video: memo(VideoCard),
  storyboard: memo(StoryboardCard),
  group: memo(GroupCard),
};
