"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { NODE_META, type WingNodeData } from "@/lib/canvas/store";

function CardShell({
  children,
  selected,
}: {
  children: React.ReactNode;
  selected: boolean;
}) {
  return (
    <div className={`ws-card w-64 p-3 ${selected ? "selected" : ""}`}>
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

/** 便签 / 剧本 / 角色卡共用文本卡布局，剧本卡标题走衬线编辑风 */
function TextCard({
  data,
  selected,
  editorial,
}: {
  data: WingNodeData;
  selected: boolean;
  editorial?: boolean;
}) {
  // 防御：历史/异常数据缺字段时跳过渲染，不让单个节点拖垮整棵树
  if (!data || typeof data.nodeType !== "string") return null;
  return (
    <CardShell selected={selected}>
      <Badge nodeType={data.nodeType} />
      <h3
        className={`mt-1.5 line-clamp-2 text-sm font-semibold text-text ${
          editorial ? "font-editorial" : ""
        }`}
      >
        {data.title || "（无标题）"}
      </h3>
      {data.body ? (
        <p className="mt-1.5 line-clamp-6 whitespace-pre-wrap text-xs leading-relaxed text-text-2">
          {data.body}
        </p>
      ) : (
        <p className="mt-1.5 text-xs italic text-text-4">（空）</p>
      )}
    </CardShell>
  );
}

function NoteCard({ data, selected }: NodeProps) {
  return <TextCard data={data as WingNodeData} selected={selected} />;
}

function ScriptCard({ data, selected }: NodeProps) {
  return (
    <TextCard
      data={data as WingNodeData}
      selected={selected}
      editorial
    />
  );
}

function CharacterCard({ data, selected }: NodeProps) {
  return <TextCard data={data as WingNodeData} selected={selected} />;
}

function ImageCard({ data, selected }: NodeProps) {
  const d = data as WingNodeData;
  if (!d || typeof d.nodeType !== "string") return null;
  return (
    <CardShell selected={selected}>
      <Badge nodeType="image" />
      <div className="mt-1.5 flex h-32 w-full items-center justify-center overflow-hidden rounded-md border border-hairline-soft bg-surface-2">
        {d.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={d.imageUrl}
            alt={d.title}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-xs text-text-4">🎨 {d.title || "图片占位"}</span>
        )}
      </div>
      {d.body ? (
        <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-text-2">
          {d.body}
        </p>
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
