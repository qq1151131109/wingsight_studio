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
import { Globe2, Loader2, Sparkles, Wand2, X } from "lucide-react";
import OverlayModal from "./OverlayModal";
import { useCanvasStore, absolutePosition, NODE_FOOTPRINT, type WingNodeData } from "@/lib/canvas/store";
import { GENERATE_EVENT, type GenerateDetail } from "@/components/canvas/PromptBar";
import { findModelOption, loadImageModels, type ImageModelOption } from "@/lib/imagegen";
import type { ImageToolDetail } from "@/lib/canvas/events";

export type TemplateTool = Extract<
  ImageToolDetail["tool"],
  | "turnaround"
  | "texture"
  | "panorama"
  | "multiGrid"
  | "continuous"
  | "plotBeats"
  | "nextFrame"
  | "prevFrame"
  | "grade"
  | "outpaint"
  | "emotion"
>;

type Preset = { label: string; sentence: string };

/** 情绪矩阵 25 预设（open-ai-canvas canvas-emotion.ts 忠实移植）：
 *  行=唤醒度 +2→-2（上高下低），列=亲密度 +2→-2（右近左远） */
const EMOTION_LABELS = [
  ["欣喜若狂", "兴高采烈", "惊喜", "震惊", "惊恐"],
  ["开怀", "期待", "专注", "警觉", "紧张"],
  ["温柔", "浅然莞尔", "中性克制", "隐忍", "疏离"],
  ["安心", "释然", "疲惫", "失落", "悲伤"],
  ["满足", "平静", "冷淡", "隐忍心伤", "绝望"],
] as const;
const EMOTION_PROMPTS = [
  ["自然、明亮的露齿笑，嘴角对称上扬，脸颊自然抬起，眼角有轻微笑纹", "明显喜悦，笑意饱满", "意外惊喜，眼睛睁大并自然张嘴", "明显震惊，眉毛抬起，嘴部微张", "强烈惊恐，双眼睁大，面部紧绷"],
  ["自然开怀，眼角带笑", "期待而兴奋，表情明亮", "高度专注，目光坚定", "保持警觉，眉眼略微收紧", "紧张不安，嘴唇轻抿"],
  ["温柔亲近，轻微微笑", "克制而自然的浅笑", "完全中性、克制、放松", "压住情绪，表情略显僵硬", "疏离冷静，减少面部情绪"],
  ["安心放松，柔和闭合嘴角", "如释重负，眉眼放松", "明显疲惫，眼睑下垂", "情绪低落，嘴角轻微下垂", "悲伤，内眉抬起，嘴角下垂"],
  ["安静满足，轻微闭口笑", "平静松弛，呼吸感自然", "冷淡克制，目光平直", "强忍心伤，嘴唇压紧，眼神黯淡", "深度绝望，眉眼下沉，面部失去张力"],
] as const;
const EMOTION_PRESETS: Preset[] = EMOTION_LABELS.flatMap((row, r) =>
  row.map((label, c) => ({
    label,
    sentence: EMOTION_PROMPTS[r][c],
  })),
);

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
  turnaround: {
    title: "三视图",
    hint: "角色设定表：正面/侧面/背面 全身立绘（建议已有定妆图再做）",
    presets: [
      { label: "写实", sentence: "写实风格" },
      { label: "动漫", sentence: "动漫风格" },
      { label: "插画", sentence: "插画风格" },
    ],
  },
  // 多功能模板（open-storyboard promptTemplates.ts 中文版忠实移植，
  // 修掉其「左前三分之三」误译）：multiGrid/continuous/plotBeats/nextFrame/
  // prevFrame/grade 预设无关（说明行+补充描述即可）；outpaint 用预设切方向
  multiGrid: {
    title: "九宫格机位",
    hint: "一次生成 3x3 多机位联系表：九格同主体不同机位（正面/左右 45°/左右正侧/背面/俯/仰/荷兰角）——机位弹窗精调单角度，这张一次看全部",
  },
  continuous: {
    title: "连续分镜",
    hint: "5x5 二十五格连续场景推进：从参考图开始，机位/取景/表情/动作逐格自然变化，世界连续性不变——拆解故事的第一刀",
  },
  plotBeats: {
    title: "剧情推演",
    hint: "2x2 四拍叙事网格：铺垫 → 行动升级 → 关键戏剧点 → 后果（角色/服装/地点/光线连续，只有表情机位动作在变）",
  },
  nextFrame: {
    title: "预测下一帧",
    hint: "渲染参考图几秒之后的合理瞬间（动作自然推进，世界连续性不变）",
  },
  prevFrame: {
    title: "回溯前帧",
    hint: "渲染导致参考图发生的上一个合理瞬间（动作自然回退，场景逻辑不变）",
  },
  grade: {
    title: "光影校正",
    hint: "保持人物/场景/构图/姿态完全不变，只做专业电影调色：平衡曝光、受控光影、自然肤色、三向校色、轻微胶片颗粒（与「打光」互补：打光换光，校正 grading）",
  },
  outpaint: {
    title: "扩图",
    hint: "延展画面边界补全环境：等比向四周 / 横向向左右 / 纵向向上下，原图内容严格不变，光线透视无缝延续——补充描述可指定扩出的内容（如：补充远处的山和天空）",
    presets: [
      {
        label: "等比扩展",
        sentence:
          "这是扩图任务：在所有方向向外延展参考图，同时严格保持原图内容不变。将环境、光线、透视、镜头特性、阴影、纹理和调色无缝延续到新边界。不要移动、重画、裁切或改变原始主体。",
      },
      {
        label: "横向扩展",
        sentence:
          "这是横向扩图任务：向左和向右延展参考图，同时严格保持原图内容不变。无缝延续环境、光线、透视、镜头特性、阴影、纹理和调色。不要移动、重画、裁切或改变原始主体。",
      },
      {
        label: "纵向扩展",
        sentence:
          "这是纵向扩图任务：向上和向下延展参考图，同时严格保持原图内容不变。无缝延续天空/天花板、地面/地板、光线、透视、镜头特性、阴影、纹理和调色。不要移动、重画、裁切或改变原始主体。",
      },
    ],
  },
  texture: {
    title: "人物质感",
    hint: "精修人像质感：融合/光影/皮肤/纹理/锐度 五维各自选档",
  },
  emotion: {
    title: "情绪",
    hint: "5×5 亲密度×唤醒度情绪矩阵：点选目标情绪，保持人物与画面完全不变，只调面部表情",
  },
  panorama: {
    title: "全景环视",
    hint: "生成 2:1 球形全景环境图，完成自动进入 720° 拖拽环视（卡面「720° 环视」按钮随时重开）",
  },
};

/** 全景职责化模板 v3（doc/image-panorama-spec.md §2.3 + §4 探针矩阵）：
 *  参考图角色句防拉伸 + 几何约束 + 竞品 open-storyboard 否定句全集 + 探针
 *  v2 验证有效的鱼眼/圆框/暗角禁令。注意：在售模型画不出严格等距柱状几何
 *  （五组探针结论），本模板职责是防鱼眼圆框/单视角横幅/参考图硬拉伸，
 *  接缝连续性由 PanoramaViewer 的 crop+羽化矫形兜底（竞品同款分工）。 */
const PANO_PROMPT =
  "把参考图作为场景参考，生成一张完整的 360 度球形全景环境图：参考图只提供" +
  "主体、材质、色彩、构图线索与风格，四周缺失的环境（左右后方、天空与地面）" +
  "由你补全，不要简单拉伸或变形参考图。最终图片必须是等距柱状投影的完整球形" +
  "全景，比例2比1（宽度是高度的2倍），只输出一张连续画面：水平方向覆盖完整" +
  "360度，垂直方向覆盖从天空到地面的完整180度，观看者位于场景中心可以环视" +
  "四周，地平线位于画面垂直中心附近，左右边缘内容自然衔接，像展开的世界地图" +
  "一样横向铺满整个画幅。画面中所有垂直线条（柱子、墙壁边缘、树木）保持垂直" +
  "不倾斜不汇聚，地面向左右水平延展不向中心汇聚。禁止：鱼眼镜头效果、圆形或" +
  "球面边框、桶形畸变、暗角；普通单视角照片、横幅照片、电影宽银幕截图；把全景" +
  "画成一个球、一个圆窗或一个门洞；分屏拼贴、多宫格、画中画；摄影师、相机、" +
  "三脚架等拍摄设备；文字、水印、边框、明显接缝。";

function buildPrompt(
  tool: TemplateTool,
  preset: Preset,
  extra: string,
  srcText: string,
): string {
  const parts: string[] = [];
  if (tool === "turnaround") {
    parts.push(
      `同一角色三视图设定图：画面横向等分为三个区域，依次为 正面 / 左侧面 / 背面 全身立绘，纯色背景，服装道具细节与参考图一致，标准角色设定图排版，${preset.sentence}`,
    );
  } else if (tool === "panorama") {
    parts.push(PANO_PROMPT);
  } else if (tool === "multiGrid") {
    parts.push(
      "基于参考图创建一张干净的 3x3 多机位角度联系表。九个画格展示同一主体和同一场景的不同机位：正面、左前四分之三、右前四分之三、左侧全侧面、右侧全侧面、背面、俯拍、仰拍、荷兰倾斜角。所有画格保持身份、服装、发型、动作、背景世界、光线和色彩氛围一致，只改变机位和取景。使用细窄中性分隔线，不要字幕、编号、UI 标签、额外人物、重复主体或画面内摄影设备",
    );
  } else if (tool === "plotBeats") {
    parts.push(
      "基于参考图推演一张 2x2 分镜网格，形成合理的四拍叙事。画格顺序从左到右、从上到下：铺垫、行动升级、关键戏剧点、后果。四格保持相同角色、身份、服装、地点、光线逻辑和世界连续性，只改变表情、机位、取景和动作推进。使用电影剧照质感和细窄中性分隔线，不要字幕、对白气泡、文字标签、新主角或环境风格变化",
    );
  } else if (tool === "nextFrame") {
    parts.push(
      "预测并渲染参考图之后的下一个合理瞬间：保持相同角色、身份、服装、地点和光线，让动作自然推进几秒，保持世界连续性，机位和取景可以自然变化，电影剧照质感。不要发明新角色，不要改变环境，不要把场景压缩成普通肖像",
    );
  } else if (tool === "prevFrame") {
    parts.push(
      "预测并渲染导致参考图发生的上一个合理瞬间：保持相同角色、身份、服装、地点和光线，将动作自然回退几秒，保持世界连续性和场景逻辑，机位和取景可以自然变化，电影剧照质感。不要发明新角色，不要改变环境",
    );
  } else if (tool === "grade") {
    parts.push(
      "这是对参考图进行调色和光线校正：严格保持相同人物、相同场景、相同构图和相同姿态，只应用专业电影调色、平衡曝光、受控高光与阴影、自然肤色、三向色彩校正、轻微胶片颗粒、IMAX / HDR 质感。不要重画主体，不要改变身份，不要在颜色和对比之外改变风格",
    );
  } else if (tool === "continuous") {
    parts.push(
      "创建一张 5x5、共 25 格的连续分镜网格，从参考图开始展示一个连续场景推进。阅读顺序从左到右、从上到下。每格保持相同角色、身份、服装、地点、光线逻辑和世界连续性，机位、取景、表情和动作在格与格之间自然变化。使用一致的电影调色和细窄中性分隔线，不要字幕、格号、对白气泡、新主角或身份互换",
    );
  } else if (tool === "outpaint") {
    // 方向模板整体在 preset.sentence（等比/横向/纵向三选一）
    parts.push(preset.sentence);
  } else if (tool === "emotion") {
    parts.push(
      "保持人物身份、五官、发型、服装、姿势、构图与画面其余部分完全不变，只调整人物面部表情至——" +
        preset.sentence,
    );
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

  // 全景模型预校验（doc/image-panorama-spec.md §2.4）：2:1 画幅只有 seedream
  // 系支持——项目默认模型可用则跟随；否则明示「已预置 X」钉到目录里第一个
  // 可用模型（明示不静默换）；目录一个都没有则禁用确认
  const imagegen = useCanvasStore((s) => s.imagegen);
  const [catalog, setCatalog] = useState<ImageModelOption[] | null>(null);
  useEffect(() => {
    if (tool !== "panorama") return;
    let cancelled = false;
    loadImageModels()
      .then((ms) => {
        if (!cancelled) setCatalog(ms);
      })
      .catch(() => {
        if (!cancelled) setCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tool]);
  const panoGen = useMemo(() => {
    if (tool !== "panorama" || !catalog?.length) return null;
    const capable = catalog.filter((m) => (m.aspects ?? []).includes("2:1"));
    if (!capable.length) return null;
    const chosen = capable.find((m) => m.id === imagegen.model) ?? capable[0];
    // 分辨率取最高档（2026-09-04 清晰度反馈：2K 2880×1440 投球面后每视角
    // 只占一小块、观感糊；4K 4320×2160 探针实测严格 2:1——seedream 4-0/4-5
    // 都有，5-pro responses 通道 4.19M 像素上限封顶 2K，按目录自动落位）
    const resolution = ["4K", "2K"].find((r) =>
      chosen.resolutions.includes(r),
    ) ?? chosen.default_resolution;
    return {
      model: chosen.id,
      resolution,
      label: chosen.label,
      overridden: chosen.id !== imagegen.model,
    };
  }, [tool, catalog, imagegen.model]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  const srcText = useMemo(() => {
    const t = String(d?.genPrompt ?? "").trim() || String(d?.body ?? "").trim();
    return t;
  }, [d?.genPrompt, d?.body]);

  const confirm = () => {
    if (busy || !node || !d?.imageUrl) return;
    // 全景必须已有可用模型（目录无 2:1 条目时禁用，不发任务）
    if (tool === "panorama" && !panoGen) return;
    setBusy(true);
    const st = useCanvasStore.getState();
    const abs = absolutePosition(st.nodes, node);
    const nw = node.measured?.width ?? NODE_FOOTPRINT.image.w;
    const preset = cfg.presets?.[pick];
    const prompt =
      tool === "texture"
        ? buildTexturePrompt(texPicks, extra, srcText)
        : buildPrompt(tool, preset!, extra, srcText);
    const suffix =
      tool === "texture"
        ? "质感"
        : tool === "panorama"
          ? "全景"
          : tool === "outpaint"
            ? `扩图·${preset?.label ?? ""}`
            : tool === "emotion"
              ? `情绪·${preset?.label ?? ""}`
              : (preset?.label ?? cfg.title);
    const newId = st.addNode({
      position: { x: abs.x + nw + 80, y: abs.y },
      data: {
        nodeType: "image",
        title: `${d.title || "图片"} · ${suffix}`,
        body: prompt,
        // 全景两新键（doc/image-panorama-spec.md §2.4）：panorama 标记挂灯箱
        // 环视查看器；gen 显式钉 2:1 + 预校验模型——不继承项目默认（默认模型
        // 可能不支持 2:1，且 gen.aspect 显式值防 resolveAutoAspect 吸附参考比例）
        ...(tool === "panorama" && panoGen
          ? {
              panorama: true,
              gen: {
                model: panoGen.model,
                resolution: panoGen.resolution,
                aspect: "2:1",
              },
            }
          : {}),
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
    tool === "turnaround" ? Sparkles : tool === "texture" ? Wand2 : Globe2;

  const chipCls = (on: boolean) =>
    `rounded-md border px-2.5 py-1 text-xs transition-colors ${
      on
        ? "border-accent bg-accent-dim text-text"
        : "border-hairline text-text-3 hover:border-accent-soft hover:text-text"
    }`;

  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-6"
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
        ) : tool === "emotion" ? (
          <div className="flex flex-col items-center gap-1.5">
            <div className="flex w-full items-center justify-between px-1 text-[10px] text-text-4">
              <span>← 亲密 · 情绪浓</span>
              <span>亲密度 × 唤醒度</span>
              <span>疏离 · 冷漠 →</span>
            </div>
            <div className="grid w-full grid-cols-5 gap-1">
              {EMOTION_PRESETS.map((p, i) => (
                <button
                  key={p.label}
                  type="button"
                  className={`rounded-md border px-1 py-2 text-[11px] leading-tight transition-colors ${
                    i === pick
                      ? "border-accent bg-accent-dim text-text"
                      : "border-hairline text-text-2 hover:border-accent-soft hover:text-text"
                  }`}
                  onClick={() => setPick(i)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-text-4">
              上排情绪更激烈、下排更平缓；左列亲密、右列疏离。当前：
              <span className="ml-0.5 font-medium text-text">
                {EMOTION_PRESETS[pick]?.label}
              </span>
            </p>
          </div>
        ) : tool === "panorama" ? (
          <div className="rounded-md border border-hairline bg-surface-2/60 p-2.5 text-xs leading-relaxed text-text-2">
            <p>
              以《{d?.title || "未命名"}》为场景参考，补全四周环境、天空与
              地面，输出左右边缘无缝衔接的 2:1 球形全景图。
            </p>
            {srcText ? (
              <p className="mt-1 text-[11px] text-text-4">
                参考内容：{srcText.slice(0, 120)}
                {srcText.length > 120 ? "…" : ""}
              </p>
            ) : null}
            <p className="mt-1.5 text-[11px]">
              {catalog === null ? (
                <span className="text-text-4">正在核对支持 2:1 画幅的模型…</span>
              ) : panoGen ? (
                panoGen.overridden ? (
                  <span className="text-text-3">
                    已预置 {panoGen.label}（当前默认模型
                    {` ${
                      findModelOption(imagegen.model, catalog)?.label ??
                      imagegen.model
                    } `}
                    不支持 2:1 全景）
                  </span>
                ) : (
                  <span className="text-text-4">
                    按当前默认模型 {panoGen.label} 生成（2:1 · {panoGen.resolution}）
                  </span>
                )
              ) : (
                <span className="text-danger">
                  模型目录暂无支持 2:1 画幅的模型（需 seedream 系），无法生成全景
                </span>
              )}
            </p>
          </div>
        ) : !cfg.presets && tool !== "texture" ? (
          // 多功能模板件（九宫格机位/剧情推演/前后帧/光影校正）：预设无关，
          // 固定说明行 + 源摘要
          <div className="rounded-md border border-hairline bg-surface-2/60 p-2.5 text-xs leading-relaxed text-text-2">
            <p>{cfg.hint}</p>
            {srcText ? (
              <p className="mt-1 text-[11px] text-text-4">
                参考内容：{srcText.slice(0, 120)}
                {srcText.length > 120 ? "…" : ""}
              </p>
            ) : null}
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
          placeholder={
            tool === "outpaint"
              ? "扩图内容补充（可选）：如 补充远处的山和天空、延伸街道纵深…"
              : "补充要求（可选）：如 构图不变、不要背景、加一顶帽子…"
          }
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
              disabled={busy || (tool === "panorama" && !panoGen)}
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
