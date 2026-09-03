"use client";

/**
 * 模板化图生图动作弹窗（doc/image-node-ops-spec.md P2）：多视角 / 三视图 /
 * 打光 / 人物质感 共用一个组件（open-storyboard-canvas / open-ai-canvas 的
 * 同类面板本质都是「预设 prompt + 参考图编辑」，我们复用 GENERATE_EVENT
 * 管线即得 画风闸/智能编排/候选/补出 全套）。
 * 铁律：禁止对源卡 dispatch（那是原位生成，会覆盖源图）——先建空图片卡 +
 * 源卡→新卡连线，再对新卡发事件；源图经「上游连线卡」通道进参考序列。
 */

import { useEffect, useMemo, useState } from "react";
import { Camera, Loader2, Sparkles, Sun, Wand2, X } from "lucide-react";
import OverlayModal from "./OverlayModal";
import { useCanvasStore, absolutePosition, NODE_FOOTPRINT, type WingNodeData } from "@/lib/canvas/store";
import { CONTEXT_BODY_LIMIT } from "@/lib/canvas/refSequence";
import { GENERATE_EVENT, type GenerateDetail } from "@/components/canvas/PromptBar";
import type { ImageToolDetail } from "@/lib/canvas/events";

export type TemplateTool = Extract<
  ImageToolDetail["tool"],
  "multiview" | "turnaround" | "lighting" | "texture"
>;

type Preset = { label: string; sentence: string };

/** 滑块组型（人物质感）：每维 3 档，档位带中文 prompt 片段
 *  （open-ai-canvas canvas-portrait-texture.ts 范式） */
type TexGroup = { key: string; label: string; options: Preset[] };

const TEXTURE_GROUPS: TexGroup[] = [
  {
    key: "fusion",
    label: "人景融合",
    options: [
      { label: "轻度对齐", sentence: "轻度对齐人物与场景，仅修正明显边缘和空间关系" },
      { label: "自然融合", sentence: "自然融合人物与场景，统一边缘、色调和空间关系" },
      { label: "深度融合", sentence: "深度融合人物与场景，细致统一边缘、环境色和空间层次" },
    ],
  },
  {
    key: "light",
    label: "光影融合",
    options: [
      { label: "柔和补光", sentence: "使用柔和补光，减弱生硬阴影并保留自然明暗" },
      { label: "自然匹配", sentence: "让人物光向、色温与场景光线自然匹配" },
      { label: "氛围强化", sentence: "强化环境光与氛围光，保持光影方向合理" },
    ],
  },
  {
    key: "skin",
    label: "皮肤",
    options: [
      { label: "清透修饰", sentence: "清透修饰皮肤，适度均匀肤色且不过度磨皮" },
      { label: "自然肤质", sentence: "保留自然肤质、毛孔和真实肤色过渡" },
      { label: "真实肌理", sentence: "强化真实皮肤肌理和细微质感，避免塑料感" },
    ],
  },
  {
    key: "texture",
    label: "纹理",
    options: [
      { label: "柔和纹理", sentence: "使用柔和细腻的整体纹理，减少粗糙噪点" },
      { label: "自然纹理", sentence: "保持服装、头发、皮肤和场景材质的自然纹理" },
      { label: "颗粒质感", sentence: "增加克制的颗粒质感和材质层次" },
    ],
  },
  {
    key: "sharp",
    label: "锐度",
    options: [
      { label: "柔焦", sentence: "使用轻柔焦效果，保持主体轮廓可辨" },
      { label: "标准清晰", sentence: "保持标准清晰度，细节自然且不过度锐化" },
      { label: "高清锐化", sentence: "提升关键细节清晰度，避免锐化光晕和噪点" },
    ],
  },
];

const TOOLS: Record<
  TemplateTool,
  { title: string; hint: string; presets?: Preset[] }
> = {
  multiview: {
    title: "多视角",
    hint: "同一主体的其他机位（保持长相、服装、场景一致，仅改变视角）",
    presets: [
      { label: "正面", sentence: "正面平视机位" },
      { label: "左侧", sentence: "左侧 90 度机位" },
      { label: "右侧", sentence: "右侧 90 度机位" },
      { label: "背面", sentence: "背面 180 度机位" },
      { label: "俯拍", sentence: "高角度俯拍机位" },
      { label: "仰拍", sentence: "低角度仰拍机位" },
    ],
  },
  turnaround: {
    title: "三视图",
    hint: "角色设定表：正面/侧面/背面 全身立绘（建议已有定妆图再做）",
    presets: [
      { label: "写实", sentence: "写实风格" },
      { label: "动漫", sentence: "动漫风格" },
      { label: "插画", sentence: "插画风格" },
    ],
  },
  lighting: {
    title: "打光",
    hint: "保持画面内容与构图不变，替换光效",
    presets: [
      { label: "伦勃朗", sentence: "伦勃朗光（45 度侧主光，明暗对比强）" },
      { label: "黄金时刻", sentence: "黄金时刻暖阳（低角度金色斜射光）" },
      { label: "赛博朋克", sentence: "赛博朋克光（品红与青蓝双色霓虹）" },
      { label: "落日逆光", sentence: "落日逆光（暖色轮廓光，边缘发亮）" },
      { label: "冷蓝月光", sentence: "冷蓝月光（高色温顶光，冷调阴影）" },
      { label: "低调暗调", sentence: "低调暗调光（大面积暗部，单点光源）" },
      { label: "高调平光", sentence: "高调平光（均匀柔光，明亮通透）" },
      { label: "雨夜霓虹", sentence: "雨夜霓虹（湿面反射，霓虹点彩光斑）" },
    ],
  },
  texture: {
    title: "人物质感",
    hint: "精修人像质感：融合/光影/皮肤/纹理/锐度 五维各自选档",
  },
};

function buildPrompt(
  tool: TemplateTool,
  preset: Preset,
  extra: string,
  srcText: string,
): string {
  const parts: string[] = [];
  if (tool === "multiview") {
    parts.push(
      `同一主体的${preset.sentence}视角，保持人物长相、服装、道具、场景与参考图完全一致，仅改变机位角度`,
    );
  } else if (tool === "turnaround") {
    parts.push(
      `同一角色三视图设定图：画面横向等分为三个区域，依次为 正面 / 左侧面 / 背面 全身立绘，纯色背景，服装道具细节与参考图一致，标准角色设定图排版，${preset.sentence}`,
    );
  } else if (tool === "lighting") {
    parts.push(`保持画面内容与构图不变，光效改为${preset.sentence}`);
  }
  if (srcText) parts.push(`参考画面内容：${srcText}`);
  if (extra.trim()) parts.push(extra.trim());
  return parts.join("\n");
}

function buildTexturePrompt(
  picks: Record<string, number>,
  extra: string,
  srcText: string,
): string {
  const lines = TEXTURE_GROUPS.map((g) => {
    const o = g.options[picks[g.key] ?? 1] ?? g.options[1];
    return `- ${g.label}（${o.label}）：${o.sentence}`;
  });
  const parts = [
    "同一画面的人物质感精修：保持人物身份、五官、发型、服装、姿势、构图与场景完全不变，仅优化以下视觉属性",
    ...lines,
  ];
  if (srcText) parts.push(`参考画面内容：${srcText}`);
  if (extra.trim()) parts.push(extra.trim());
  return parts.join("\n");
}

export default function ImageTemplateDialog({
  nodeId,
  tool,
  onClose,
}: {
  nodeId: string;
  tool: TemplateTool;
  onClose: () => void;
}) {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId));
  const d = node?.data as WingNodeData | undefined;
  const cfg = TOOLS[tool];
  const [pick, setPick] = useState(0);
  const [texPicks, setTexPicks] = useState<Record<string, number>>(() =>
    Object.fromEntries(TEXTURE_GROUPS.map((g) => [g.key, 1])),
  );
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  const srcText = useMemo(() => {
    const t = String(d?.genPrompt ?? "").trim() || String(d?.body ?? "").trim();
    return t.slice(0, CONTEXT_BODY_LIMIT);
  }, [d?.genPrompt, d?.body]);

  const confirm = () => {
    if (busy || !node || !d?.imageUrl) return;
    setBusy(true);
    const st = useCanvasStore.getState();
    const abs = absolutePosition(st.nodes, node);
    const nw = node.measured?.width ?? NODE_FOOTPRINT.image.w;
    const preset = cfg.presets?.[pick];
    const prompt =
      tool === "texture"
        ? buildTexturePrompt(texPicks, extra, srcText)
        : buildPrompt(tool, preset!, extra, srcText);
    const suffix = tool === "texture" ? "质感" : (preset?.label ?? "");
    const newId = st.addNode({
      position: { x: abs.x + nw + 80, y: abs.y },
      data: {
        nodeType: "image",
        title: `${d.title || "图片"} · ${suffix}`,
        body: prompt,
      },
    });
    st.connect({ source: nodeId, target: newId });
    st.flashNodes([newId]);
    // 对新卡发事件（铁律：对源卡发是原位生成会覆盖源图）；新卡无本卡原图，
    // 源图经 refIds + 连线双通道进参考序列，画幅自动吸附参考比例
    window.dispatchEvent(
      new CustomEvent<GenerateDetail>(GENERATE_EVENT, {
        detail: { nodeId: newId, kind: "image", prompt, refIds: [nodeId] },
      }),
    );
    onClose();
  };

  const Icon =
    tool === "lighting"
      ? Sun
      : tool === "turnaround"
        ? Sparkles
        : tool === "texture"
          ? Wand2
          : Camera;

  const chipCls = (on: boolean) =>
    `rounded-md border px-2.5 py-1 text-xs transition-colors ${
      on
        ? "border-accent bg-accent-dim text-text"
        : "border-hairline text-text-3 hover:border-accent-soft hover:text-text"
    }`;

  return (
    <OverlayModal
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex max-h-[86vh] w-[min(38rem,92vw)] flex-col gap-3 overflow-y-auto rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
              <Icon className="h-4 w-4" />
              {cfg.title} · {d?.title || "未命名"}
            </h3>
            <p className="mt-0.5 text-[11px] text-text-4">{cfg.hint}</p>
          </div>
          <button
            type="button"
            data-tip="关闭" aria-label="关闭"
            className="rounded p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {cfg.presets ? (
          <div className="flex flex-wrap gap-1.5">
            {cfg.presets.map((p, i) => (
              <button
                key={p.label}
                type="button"
                className={chipCls(i === pick)}
                onClick={() => setPick(i)}
              >
                {p.label}
              </button>
            ))}
          </div>
        ) : tool === "texture" ? (
          <div className="space-y-1.5">
            {TEXTURE_GROUPS.map((g) => (
              <div key={g.key} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[11px] text-text-3">
                  {g.label}
                </span>
                <div className="flex flex-1 flex-wrap gap-1.5">
                  {g.options.map((o, i) => (
                    <button
                      key={o.label}
                      type="button"
                      className={`${chipCls((texPicks[g.key] ?? 1) === i)} px-2 py-0.5 text-[11px]`}
                      onClick={() =>
                        setTexPicks((prev) => ({ ...prev, [g.key]: i }))
                      }
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="补充要求（可选）：如 构图不变、不要背景、加一顶帽子…"
          rows={2}
          maxLength={300}
          className="w-full resize-none rounded-md border border-hairline bg-surface-2/60 px-2 py-1.5 text-xs text-text outline-none focus:border-accent placeholder:text-text-4"
        />

        <div className="flex shrink-0 items-center justify-between gap-2">
          <p className="text-[10px] text-text-4">
            生成新卡片并连线到本卡（原图作为参考，不改动本卡）
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-hairline px-3 py-1.5 text-xs text-text-2 transition-colors hover:bg-surface-2"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="button"
              className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-1 transition-opacity hover:opacity-90 disabled:opacity-50"
              data-track={`image.${tool}`}
              disabled={busy}
              onClick={confirm}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              生成{cfg.title}卡
            </button>
          </div>
        </div>
      </div>
    </OverlayModal>
  );
}
