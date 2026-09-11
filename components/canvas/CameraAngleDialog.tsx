"use client";

/**
 * 机位视角弹窗（open-storyboard MultiAnglePanel 移植版，2026-09-04 按体验
 * 最优拍板）：球控拖拽定机位 + 7 预设 + 水平/垂直滑杆（吸附）+ 7 档景别
 * （联动球心图缩放）+ 四种提示词模式（通用/单人/动作/多人）。
 * 提示词工程移植其 battle-tested 结构：角度区间防作弊条款（75-105° 真侧脸
 * 不许看向镜头 / 165-195° 真背面不许偷看）、禁止把相机设备画进画面、
 * 多人防克隆/防合并/防镜像条款——全文按我们 seedream 中文管线重写。
 * 出卡走既有铁律：新卡+连线+对新卡 GENERATE_EVENT（复用画风闸/参考编号/候选）。
 */

import { useEffect, useMemo, useState } from "react";
import { Camera, Loader2, X } from "lucide-react";
import OverlayModal from "./OverlayModal";
import { CameraSphereControl } from "./CameraSphereControl";
import { useCanvasStore, absolutePosition, NODE_FOOTPRINT, type WingNodeData } from "@/lib/canvas/store";
import { GENERATE_EVENT, type GenerateDetail } from "@/components/canvas/PromptBar";
import { assetThumbUrl } from "@/lib/asset-thumb";

type ShotGear = "ecU" | "cu" | "mcu" | "ms" | "mfs" | "fs" | "ls";

const SHOT_GEARS: { id: ShotGear; label: string; prompt: string; scale: number }[] = [
  { id: "ecU", label: "特写", prompt: "大特写，ECU，细节亲密取景", scale: 1.5 },
  { id: "cu", label: "近景", prompt: "近景，CU，头部肖像，情绪紧凑取景", scale: 1.32 },
  { id: "mcu", label: "中近景", prompt: "中近景，MCU，胸部以上取景，对话感", scale: 1.14 },
  { id: "ms", label: "中景", prompt: "中景，MS，腰部以上标准叙事取景", scale: 1 },
  { id: "mfs", label: "中全景", prompt: "中全景，膝盖以上四分之三身位取景", scale: 0.88 },
  { id: "fs", label: "全景", prompt: "全景，FS，全身入画，带环境关系", scale: 0.74 },
  { id: "ls", label: "远景", prompt: "远景，LS，交代性大景，环境为主", scale: 0.62 },
];

type PromptMode = "universal" | "single" | "action" | "multi";

const PROMPT_MODES: { id: PromptMode; label: string; hint: string }[] = [
  { id: "universal", label: "通用", hint: "大多数图先试这个，整体最稳" },
  { id: "single", label: "单人", hint: "单人图更稳住身份、脸和朝向" },
  { id: "action", label: "动作", hint: "动作图更稳住姿势、手势和肢体" },
  { id: "multi", label: "多人", hint: "双人/多人图更稳住人数和关系" },
];

const ANGLE_PRESETS: {
  id: string;
  label: string;
  position: { horizontal: number; vertical: number };
  shot: ShotGear;
  prompt: string;
}[] = [
  { id: "custom", label: "自定义", position: { horizontal: 0, vertical: 0 }, shot: "ms", prompt: "" },
  {
    id: "fishEye",
    label: "鱼眼视角",
    position: { horizontal: 0, vertical: 30 },
    shot: "ecU",
    prompt: "鱼眼镜头，超广角 180 度桶形畸变，夸张透视，边缘弯曲畸变，贴脸特写",
  },
  {
    id: "tilted",
    label: "倾斜视角",
    position: { horizontal: 45, vertical: -30 },
    shot: "ms",
    prompt: "荷兰角倾斜构图，画面歪斜，地平线倾斜，对角线构图，略带仰角",
  },
  {
    id: "frontOverhead",
    label: "正面俯拍",
    position: { horizontal: 0, vertical: 60 },
    shot: "ms",
    prompt: "正面高角度俯拍，相机在主体上方，向下俯视视角",
  },
  {
    id: "lowAngle",
    label: "正面仰拍",
    position: { horizontal: 0, vertical: -30 },
    shot: "ms",
    prompt: "正面低角度仰拍，相机在主体下方，向上仰视，英雄式透视",
  },
  {
    id: "panorama",
    label: "全景俯拍",
    position: { horizontal: 45, vertical: 30 },
    shot: "fs",
    prompt: "宽广高角度镜头，全景取景，更多环境可见，轻微俯视，电影感开阔构图",
  },
  {
    id: "backView",
    label: "背面视角",
    position: { horizontal: 180, vertical: 0 },
    shot: "ms",
    prompt: "背面视角，主体背对相机，只见后脑与肩背，相机位于主体正后方",
  },
];

const MODE_PROMPT: Record<PromptMode, string> = {
  single: "画面中只有这一个人物，保持同一张脸、同一面部结构、同一发型、同一服装轮廓与肖像相似度",
  action: "保持原图的动作瞬间、手势剪影、身体姿势、四肢位置与手部结构，不缺肢、不融合手指、手腕手臂连接正确",
  multi:
    "保持与参考图完全相同的人数；若原图是双人对峙，保持恰好一左一右两个主体；每个人保持独立稳定的身份，保持左右顺序、相对距离、朝向与视线关系，不加人、不复制人、不克隆脸或身体、不镜像出多余的一对、不交换两人身份、不把两个人合并成一个人",
  universal: "保持原图的主体、整体场景特征与构图逻辑",
};

const MODE_CONSTRAINT: Record<PromptMode, string> = {
  single: "优先保证面部身份正确与符合所机位角度的头部转向",
  action: "优先保证身体动作的忠实还原与解剖学正确的姿势变化，而非风格化重绘",
  multi: "优先保证人数精确、各自身份稳定、逐人清晰分离与对峙关系忠实，而非风格化构图变化",
  universal: "在身份、场景连续性与机位角度忠实度之间取平衡",
};

const MODE_SHOT_GUARD: Record<PromptMode, string> = {
  single: "不要把画面变成千篇一律的证件照或美颜人像",
  action: "不要把画面坍缩成静止的摆拍肖像",
  multi: "不要把场景坍缩成单人肖像，不要复制整组人物，不要用镜像、克隆、换身份或重叠融合的对象替换对峙双方",
  universal: "不要把场景替换成通用的重摆拍肖像",
};

function horizontalAllowance(h: number): string {
  const n = ((h % 360) + 360) % 360;
  if (n >= 165 && n <= 195)
    return "把主体转成真正的背面朝向构图，头部与躯干一起转过去，不得露出正面脸，不许偷看镜头";
  if (n >= 105 && n < 165) return "允许自然旋转到后侧四分之三构图，面部特征大部分被遮挡";
  if (n >= 75 && n <= 105)
    return "把主体转成真正的正侧面剪影，头与躯干对齐，只露出半张脸，不看向镜头";
  if (n > 195 && n < 255) return "允许自然旋转到另一侧的后侧四分之三构图，面部特征大部分被遮挡";
  if (n > 15 && n < 345) return "为所要求的机位环绕允许细微的姿势与转头变化，但主体与场景不变";
  return "保持接近原图的姿势，只改变相机机位";
}

function verticalAllowance(v: number): string {
  if (v >= 45)
    return "视点明显在主体上方，保持俯视角度，眼睛不应看向镜头，视线朝下或朝向别处，不要抬起下巴或仰起脸假装正面视角";
  if (v <= -25) return "视点明显在主体下方，允许自然的仰角透视，身体朝向保持一致";
  return "保持接近原图的透视";
}

function horizontalPrompt(h: number): string {
  const n = ((h % 360) + 360) % 360;
  if (n >= 345 || n <= 15) return "正面视角，正对主体的观看角度";
  if (n > 15 && n < 75) return "前侧四分之三视角，头部与躯干一起部分侧转";
  if (n >= 75 && n <= 105) return "纯正侧面视角，90 度侧脸，只露出半张脸";
  if (n > 105 && n < 165) return "后侧四分之三视角，视点位于主体侧后方，脸部大部分不可见";
  if (n >= 165 && n <= 195) return "正背面视角，视点位于主体正后方，完全看不到五官";
  if (n > 195 && n < 255) return "另一侧的后侧四分之三视角，脸部大部分不可见";
  if (n >= 255 && n <= 285) return "另一侧的纯正侧面视角，90 度侧脸";
  return "另一侧的前侧四分之三视角，头部与躯干一起侧转";
}

function verticalPrompt(v: number): string {
  if (v >= 60) return "强烈俯视透视，陡峭高角度，从上方看主体，视线朝下或朝向别处，不与观看者对视";
  if (v >= 30) return "高角度透视，视点在主体上方，视线放低或转向别处，避免直接对视";
  if (v <= -45) return "强烈仰视透视，从下方向上看主体";
  if (v <= -15) return "低角度透视，视点略低于主体";
  return "平视透视";
}

const H_TICKS = [0, 45, 90, 135, 180, 225, 270, 315, 360];
const V_TICKS = [-90, -60, -30, 0, 30, 60, 90];
const SNAP = 6;

function snapToTicks(value: number, ticks: number[]): number {
  const nearest = ticks.reduce((prev, cur) => (Math.abs(cur - value) < Math.abs(prev - value) ? cur : prev));
  return Math.abs(nearest - value) <= SNAP ? nearest : value;
}

function buildAnglePrompt(opts: {
  horizontal: number;
  vertical: number;
  shot: ShotGear;
  mode: PromptMode;
  presetId: string;
  srcText: string;
  extra: string;
}): string {
  const { horizontal, vertical, shot, mode, presetId, srcText, extra } = opts;
  const preset = ANGLE_PRESETS.find((p) => p.id === presetId);
  const consistency = [
    "这是对参考图的机位编辑：同一场景、同一人物、同一动作，只是从不同的观看角度呈现",
    "下面的指令只描述观看者所在的视点位置，不是要往画面里添加的新物件",
    "不要在画面中出现任何相机、镜头、三脚架、取景器、屏幕或摄影设备",
    "保持原画面的人物、动作、场景与关系结构，只改变观看角度与取景",
    "输出必须停留在参考图的同一个世界、同一个时刻，不是另一个人、不是另一个地方",
    "保持人物身份、服装、发型与整体场景",
    MODE_PROMPT[mode],
    "保持原图的身体姿势、手势、四肢位置与动作",
    "保持完整的人体结构，尤其是手、手臂、肩膀与身体的连接，不缺肢、不融合手指、不出现畸形的手势剪影",
    "若画面中有多人：保持人数不变，每个人保持清晰独立，保持左右顺序、相对间距、朝向与视线关系，不合并角色、不替换主体、不复制或克隆任何人、不加镜像出的多余对象、不把双人对峙坍缩成单人",
    "在改变观看角度与取景的同时，保持背景、光影与色调基调大体一致",
    MODE_CONSTRAINT[mode],
    "把所要求的角度、景别与预设理解为「从哪里看」，而不是画面里的物体",
    MODE_SHOT_GUARD[mode],
    horizontalAllowance(horizontal),
    verticalAllowance(vertical),
  ];
  const gear = SHOT_GEARS.find((g) => g.id === shot);
  const parts = [
    consistency.join("；"),
    preset && preset.id !== "custom" ? `机位预设：${preset.prompt}` : "",
    `机位角度：${horizontalPrompt(horizontal)}，${verticalPrompt(vertical)}`,
    gear ? `景别：${gear.prompt}` : "",
    `[机位 H:${horizontal}° V:${vertical}° 模式:${mode}]`,
  ];
  if (srcText) parts.push(`参考画面内容：${srcText}`);
  if (extra.trim()) parts.push(extra.trim());
  return parts.filter(Boolean).join("\n");
}

export default function CameraAngleDialog({
  nodeId,
  onClose,
}: {
  nodeId: string;
  onClose: () => void;
}) {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId));
  const d = node?.data as WingNodeData | undefined;
  const [presetId, setPresetId] = useState("custom");
  const [horizontal, setHorizontal] = useState(0);
  const [vertical, setVertical] = useState(0);
  const [shot, setShot] = useState<ShotGear>("ms");
  const [mode, setMode] = useState<PromptMode>("universal");
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
    return t;
  }, [d?.genPrompt, d?.body]);

  const gearScale = SHOT_GEARS.find((g) => g.id === shot)?.scale ?? 1;
  const presetLabel = ANGLE_PRESETS.find((p) => p.id === presetId)?.label ?? "自定义";
  const titleSuffix =
    presetId !== "custom" ? presetLabel : `机位${horizontal}°·${vertical}°`;

  const applyPosition = (h: number, v: number) => {
    setPresetId("custom");
    setHorizontal(h);
    setVertical(v);
  };

  const confirm = () => {
    if (busy || !node || !d?.imageUrl) return;
    setBusy(true);
    const st = useCanvasStore.getState();
    const abs = absolutePosition(st.nodes, node);
    const nw = node.measured?.width ?? NODE_FOOTPRINT.image.w;
    const prompt = buildAnglePrompt({ horizontal, vertical, shot, mode, presetId, srcText, extra });
    const newId = st.addNode({
      position: { x: abs.x + nw + 80, y: abs.y },
      data: {
        nodeType: "image",
        title: `${d.title || "图片"} · ${titleSuffix}`,
        body: prompt,
      },
    });
    st.connect({ source: nodeId, target: newId });
    st.flashNodes([newId]);
    // 铁律：对新卡发事件（对源卡发是原位生成会覆盖源图）
    window.dispatchEvent(
      new CustomEvent<GenerateDetail>(GENERATE_EVENT, {
        detail: { nodeId: newId, kind: "image", prompt, refIds: [nodeId] },
      }),
    );
    onClose();
  };

  const modeHint = PROMPT_MODES.find((m) => m.id === mode)?.hint ?? "";

  const rangeCls =
    "w-full cursor-pointer appearance-none rounded-full bg-surface-3 accent-[var(--color-accent)] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent";

  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-6 ws-scrim-in"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="nowheel flex max-h-[88vh] w-[min(46rem,94vw)] flex-col gap-3 overflow-y-auto ws-dialog-in ws-elev-modal rounded-xl bg-surface-1 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
              <Camera className="h-4 w-4" />
              机位视角 · {d?.title || "未命名"}
            </h3>
            <p className="mt-0.5 text-[11px] text-text-4">
              拖拽球体或滑杆定机位，生成新卡片（原图作参考，不改动本卡）
            </p>
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

        {/* 预设行 */}
        <div className="flex flex-wrap gap-1.5">
          {ANGLE_PRESETS.map((p) => {
            const on = presetId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  on
                    ? "border-accent bg-accent-dim text-text"
                    : "border-hairline text-text-3 hover:border-accent-soft hover:text-text"
                }`}
                onClick={() => {
                  setPresetId(p.id);
                  setHorizontal(p.position.horizontal);
                  setVertical(p.position.vertical);
                  setShot(p.shot);
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {/* 主体双栏：左球控 / 右控制列 */}
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex shrink-0 justify-center">
            <CameraSphereControl
              horizontal={horizontal}
              vertical={vertical}
              onPositionChange={applyPosition}
              previewImageUrl={d?.imageUrl ? assetThumbUrl(d.imageUrl) : null}
              imageScale={gearScale}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-wide text-text-4">
                  提示词模式
                </p>
                <p className="text-[10px] text-text-4">{modeHint}</p>
              </div>
              <div className="flex flex-wrap gap-1">
                {PROMPT_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                      mode === m.id
                        ? "border-accent bg-accent-dim text-text"
                        : "border-hairline text-text-3 hover:text-text"
                    }`}
                    onClick={() => setMode(m.id)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-wide text-text-4">
                  水平环绕
                </p>
                <p className="text-[10px] tabular-nums text-text-3">{horizontal}°</p>
              </div>
              <input
                type="range"
                min={0}
                max={360}
                step={1}
                value={horizontal}
                className={rangeCls}
                onChange={(e) => {
                  setPresetId("custom");
                  setHorizontal(snapToTicks(Number(e.target.value), H_TICKS));
                }}
              />
              <div className="mt-0.5 flex justify-between px-0.5 text-[9px] tabular-nums text-text-4">
                {["0", "90", "180", "270", "360"].map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-wide text-text-4">
                  垂直俯仰
                </p>
                <p className="text-[10px] tabular-nums text-text-3">{vertical}°</p>
              </div>
              <input
                type="range"
                min={-90}
                max={90}
                step={1}
                value={vertical}
                className={rangeCls}
                onChange={(e) => {
                  setPresetId("custom");
                  setVertical(snapToTicks(Number(e.target.value), V_TICKS));
                }}
              />
              <div className="mt-0.5 flex justify-between px-0.5 text-[9px] tabular-nums text-text-4">
                <span>-90</span>
                <span>0</span>
                <span>90</span>
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-wide text-text-4">
                  景别（球心图联动缩放）
                </p>
                <p className="text-[10px] text-text-3">
                  {SHOT_GEARS.find((g) => g.id === shot)?.label}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                {SHOT_GEARS.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className={`rounded-md border px-1.5 py-0.5 text-[11px] transition-colors ${
                      shot === g.id
                        ? "border-accent bg-accent-dim text-text"
                        : "border-hairline text-text-3 hover:text-text"
                    }`}
                    onClick={() => setShot(g.id)}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            <textarea
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="补充要求（可选）：如 构图不变、不要背景、加一顶帽子…"
              rows={2}
              maxLength={300}
              className="w-full resize-none rounded-md border border-hairline bg-surface-2/60 px-2 py-1.5 text-xs text-text outline-none focus:border-accent placeholder:text-text-4"
            />
          </div>
        </div>

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
              data-track="image.multiview"
              disabled={busy}
              onClick={confirm}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              生成机位卡
            </button>
          </div>
        </div>
      </div>
    </OverlayModal>
  );
}
