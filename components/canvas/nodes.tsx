"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CircleAlert, X, ZoomIn } from "lucide-react";
import { NODE_META, useCanvasStore, type WingNodeData } from "@/lib/canvas/store";

/** 重试生成事件：image 卡 error 态发出，CanvasAgentBridge 监听并转成聊天指令 */
export const RETRY_GENERATION_EVENT = "wingsight:retry-generation";

function CardShell({
  children,
  selected,
  width,
}: {
  children: React.ReactNode;
  selected: boolean;
  width?: string;
}) {
  return (
    <div
      className={`ws-card p-3 ${selected ? "selected" : ""} ${width ?? "w-64"}`}
    >
      <Handle type="target" position={Position.Top} />
      {children}
      <Handle type="source" position={Position.Bottom} />
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

/**
 * 就地编辑文本块：双击进入编辑（nodrag/nowheel 避免触发画布手势），
 * 单行模式 Enter、多行模式 Ctrl+Enter 或失焦保存，Esc 取消。统一用 textarea。
 */
function Editable({
  value,
  onSave,
  className,
  multiline,
  placeholder,
}: {
  value: string;
  onSave: (next: string) => void;
  className?: string;
  multiline?: boolean;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
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

/** 便签 / 角色卡：紧凑文本卡 + 就地编辑 */
function TextCard({
  data,
  id,
  selected,
  editorial,
  wide,
  scrollBody,
}: {
  data: WingNodeData;
  id: string;
  selected: boolean;
  editorial?: boolean;
  wide?: boolean;
  scrollBody?: boolean;
}) {
  // 防御：历史/异常数据缺字段时跳过渲染，不让单个节点拖垮整棵树
  if (!data || typeof data.nodeType !== "string") return null;
  const update = makeUpdater(id);
  return (
    <CardShell selected={selected} width={wide ? "w-[22rem]" : undefined}>
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
        placeholder="（空）"
        className={`mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-text-2 ${
          scrollBody ? "max-h-48 overflow-auto nowheel" : "line-clamp-6"
        }`}
      />
    </CardShell>
  );
}

function NoteCard({ data, id, selected }: NodeProps) {
  return <TextCard data={data as WingNodeData} id={id} selected={selected} />;
}

/** 剧本卡：加宽 + 正文可滚 + 衬线编辑风（承载剧本全文） */
function ScriptCard({ data, id, selected }: NodeProps) {
  return (
    <TextCard
      data={data as WingNodeData}
      id={id}
      selected={selected}
      editorial
      wide
      scrollBody
    />
  );
}

function CharacterCard({ data, id, selected }: NodeProps) {
  return <TextCard data={data as WingNodeData} id={id} selected={selected} />;
}

/** 图片放大预览：点击遮罩或 Esc 关闭 */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8"
      onClick={onClose}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
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

function ElapsedTimer() {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{sec}</>;
}

/** 图片卡四态：占位 / loading / error（可重试）/ ready（点击放大） */
function ImageCard({ data, id, selected }: NodeProps) {
  const d = data as WingNodeData;
  const update = makeUpdater(id);
  const [zoom, setZoom] = useState(false);
  // 防御：异常数据不渲染（hooks 已在上，顺序稳定）
  if (!d || typeof d.nodeType !== "string") return null;

  return (
    <CardShell selected={selected}>
      <Badge nodeType="image" />
      <div className="mt-1.5 flex h-36 w-full items-center justify-center overflow-hidden rounded-md border border-hairline-soft bg-surface-2">
        {d.status === "loading" ? (
          <div className="w-full px-4 text-center">
            <div className="h-1 w-full overflow-hidden rounded-full bg-hairline-soft">
              <div className="ws-shimmer h-full w-full" />
            </div>
            <p className="mt-2 text-xs text-text-3">
              生成中 · <ElapsedTimer />s
            </p>
          </div>
        ) : d.status === "error" ? (
          <button
            type="button"
            className="nodrag flex flex-col items-center gap-1.5 px-4 text-center text-danger hover:opacity-80"
            onClick={(e) => {
              e.stopPropagation();
              window.dispatchEvent(
                new CustomEvent(RETRY_GENERATION_EVENT, { detail: { nodeId: id } }),
              );
            }}
          >
            <CircleAlert className="h-5 w-5" />
            <span className="text-xs">生成失败 · 点击重试</span>
            {d.errorMessage ? (
              <span className="line-clamp-2 text-[10px] text-text-4">
                {d.errorMessage}
              </span>
            ) : null}
          </button>
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
              className="h-full w-full object-cover"
            />
            <span className="absolute right-1.5 top-1.5 rounded-md bg-black/40 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100">
              <ZoomIn className="h-3.5 w-3.5" />
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
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-text-2">
          {d.body}
        </p>
      ) : null}
      {zoom && d.imageUrl ? (
        <Lightbox src={d.imageUrl} alt={d.title} onClose={() => setZoom(false)} />
      ) : null}
    </CardShell>
  );
}

export const nodeTypes = {
  note: memo(NoteCard),
  script: memo(ScriptCard),
  character: memo(CharacterCard),
  image: memo(ImageCard),
};
