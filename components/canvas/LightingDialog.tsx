"use client";

/**
 * 打光弹窗（open-storyboard LightingControlPanel 移植版）：光位球控（方位/
 * 俯仰）+ 主光源 6 方位钮 + 亮度滑杆 + 轮廓光开关 + 色温点 + 预设卡（吃
 * agent camera.py LIGHT_PRESETS 单一事实源，2026-09-04 起与导演台布光区同源；
 * 预设卡底色用竞品同款 CSS 渐变，不搬其 18MB 示例图）。
 * 方位→人话映射（不写「方位角 270°」这类模型会忽略的原始角度、也不给会
 * 诱发「把灯具画进画面」的措辞）是原实现的核心手法，全文按中文管线重写。
 * 出卡铁律同机位弹窗：新卡+连线+对新卡 GENERATE_EVENT。
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Sun, X } from "lucide-react";
import OverlayModal from "./OverlayModal";
import { LightingSphereControl } from "./LightingSphereControl";
import { useCanvasStore, absolutePosition, NODE_FOOTPRINT, type WingNodeData } from "@/lib/canvas/store";
import { GENERATE_EVENT, type GenerateDetail } from "@/components/canvas/PromptBar";
import { getCameraVocab, type LightPreset } from "@/lib/camera-vocab";
import { assetThumbUrl } from "@/lib/asset-thumb";

const LIGHT_POSITIONS = [
  { label: "左侧", azimuth: 270, elevation: 0 },
  { label: "顶部", azimuth: 0, elevation: 80 },
  { label: "右侧", azimuth: 90, elevation: 0 },
  { label: "前方", azimuth: 0, elevation: 0 },
  { label: "底部", azimuth: 0, elevation: -80 },
  { label: "后方", azimuth: 180, elevation: 0 },
];

/** 预设卡底渐变（竞品同款，替代其 18MB 示例图） */
const PRESET_GRADIENTS: Record<string, string> = {
  rembrandt: "linear-gradient(135deg, #23160f 0%, #4f2f1d 48%, #c9a06a 100%)",
  goldenHour: "linear-gradient(135deg, #2a1907 0%, #8d5d11 48%, #ffd36b 100%)",
  cyberpunk: "linear-gradient(135deg, #120818 0%, #3c0d4b 48%, #00d0ff 100%)",
  sunset: "linear-gradient(135deg, #21110d 0%, #8d3a18 48%, #efb46f 100%)",
  blueBacklight: "linear-gradient(135deg, #1d2840 0%, #243b6d 48%, #7aa8ff 100%)",
  mysterious: "linear-gradient(135deg, #08090d 0%, #171922 52%, #40495a 100%)",
  overexposed: "linear-gradient(135deg, #f1dcc8 0%, #c6ab8e 42%, #8a6f57 100%)",
  nolanGrey: "linear-gradient(135deg, #10161c 0%, #2f3a44 52%, #8aa3b5 100%)",
  window: "linear-gradient(135deg, #d8d4c8 0%, #b5aa93 50%, #8a8272 100%)",
  volume: "linear-gradient(135deg, #1a1c22 0%, #3d4450 48%, #aab6c5 100%)",
  topSilhouette: "linear-gradient(135deg, #0d0d0f 0%, #2a2a30 45%, #d8d8e0 100%)",
  rainNeon: "linear-gradient(135deg, #0a0f1a 0%, #12213d 48%, #e86fa0 100%)",
};

/** 色温点：中文 prompt 片段（跳过原生取色器——六档覆盖影视常用色温） */
const LIGHT_COLORS = [
  { id: "white", dot: "#ffffff", label: "标准白", prompt: "" },
  { id: "warm", dot: "#ffd9a0", label: "暖金", prompt: "主光色温偏暖金" },
  { id: "cool", dot: "#a8c8ff", label: "冷蓝", prompt: "主光色温偏冷蓝" },
  { id: "magenta", dot: "#e86fd8", label: "品红", prompt: "主光色温偏品红霓虹" },
  { id: "green", dot: "#9fe8b0", label: "青绿", prompt: "主光色温偏青绿" },
];

/** 方位/俯仰 → 人话（核心手法：模型忽略原始角度、且不能诱导它把灯画进画面） */
function directionPrompt(azimuth: number, elevation: number): string {
  const az = ((azimuth % 360) + 360) % 360;
  if (elevation >= 60) return "主光从正上方直射下来的强顶光";
  if (elevation <= -60) return "主光从主体正下方向上打的上打光";
  const azName =
    az >= 345 || az <= 15
      ? "主光从正面打来"
      : az > 15 && az < 75
        ? "主光从前侧 45 度打来"
        : az >= 75 && az <= 105
          ? "主光从右侧打来，纯侧光"
          : az > 105 && az < 165
            ? "主光从右后方打来，形成轮廓光与边缘光"
            : az >= 165 && az <= 195
              ? "主光从主体正后方打来，强逆光与剪影"
              : az > 195 && az < 255
                ? "主光从左后方打来，形成轮廓光与边缘光"
                : az >= 255 && az <= 285
                  ? "主光从左侧打来，纯侧光"
                  : "主光从前左 45 度打来";
  const elSuffix =
    elevation >= 30 ? "，并从上方略向下倾斜" : elevation <= -30 ? "，并从下方略向上仰打" : "";
  return `${azName}${elSuffix}`;
}

function brightnessPrompt(brightness: number): string {
  if (brightness >= 75) return "高调明亮，曝光上提，通透明亮的高调画面";
  if (brightness <= 25) return "低调昏暗，深阴影，曝光压暗，氛围浓重的低调画面";
  if (brightness === 50) return "";
  return brightness > 50 ? "曝光略亮" : "曝光略暗";
}

function buildLightingPrompt(opts: {
  azimuth: number;
  elevation: number;
  brightness: number;
  rimLight: boolean;
  colorPrompt: string;
  preset: LightPreset | null;
  srcText: string;
  extra: string;
}): string {
  const consistency = [
    "这是对参考图的纯打光编辑：同一场景、同一人物、同一动作、同一服装、同一背景，只有光线改变",
    "下面的指令只描述光怎么落在主体上，不是要往画面里添加的新物件",
    "不要在画面中出现任何灯具、射灯、反光板、柔光箱、火把、蜡烛或摄影灯光设备",
    "保持参考图的人物身份、面部、服装、发型、身体姿势与背景布局",
    "若画面中有多人：保持人数不变与他们的空间关系",
    "只改变光的方向、光的颜色、亮度、阴影、对比度与氛围",
  ];
  const parts = [
    consistency.join("；"),
    opts.preset ? `光效预设：${opts.preset.prompt}` : "",
    directionPrompt(opts.azimuth, opts.elevation),
    brightnessPrompt(opts.brightness),
    opts.rimLight ? "沿主体剪影加出清晰的轮廓光与边缘高光" : "",
    opts.colorPrompt,
    `[打光 方位:${opts.azimuth}° 俯仰:${opts.elevation}° 亮度:${opts.brightness}%${opts.rimLight ? " 轮廓光:开" : ""}]`,
  ];
  if (opts.srcText) parts.push(`参考画面内容：${opts.srcText}`);
  if (opts.extra.trim()) parts.push(opts.extra.trim());
  return parts.filter(Boolean).join("\n");
}

export default function LightingDialog({
  nodeId,
  onClose,
}: {
  nodeId: string;
  onClose: () => void;
}) {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId));
  const d = node?.data as WingNodeData | undefined;
  const [azimuth, setAzimuth] = useState(0);
  const [elevation, setElevation] = useState(0);
  const [brightness, setBrightness] = useState(50);
  const [rimLight, setRimLight] = useState(false);
  const [colorId, setColorId] = useState("white");
  const [presetId, setPresetId] = useState("");
  const [viewMode, setViewMode] = useState<"perspective" | "front">("perspective");
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [presets, setPresets] = useState<LightPreset[] | null>(null);

  useEffect(() => {
    let alive = true;
    void getCameraVocab().then((v) => {
      if (alive) setPresets(v.lightPresets);
    });
    return () => {
      alive = false;
    };
  }, []);

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

  const preset = presets?.find((p) => p.id === presetId) ?? null;
  const colorPrompt = LIGHT_COLORS.find((c) => c.id === colorId)?.prompt ?? "";

  const confirm = () => {
    if (busy || !node || !d?.imageUrl) return;
    setBusy(true);
    const st = useCanvasStore.getState();
    const abs = absolutePosition(st.nodes, node);
    const nw = node.measured?.width ?? NODE_FOOTPRINT.image.w;
    const prompt = buildLightingPrompt({
      azimuth,
      elevation,
      brightness,
      rimLight,
      colorPrompt,
      preset,
      srcText,
      extra,
    });
    const suffix = preset ? preset.name : "打光";
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
    window.dispatchEvent(
      new CustomEvent<GenerateDetail>(GENERATE_EVENT, {
        detail: { nodeId: newId, kind: "image", prompt, refIds: [nodeId] },
      }),
    );
    onClose();
  };

  const rangeCls =
    "w-full cursor-pointer appearance-none rounded-full bg-surface-3 accent-[var(--color-accent)]";

  return (
    <OverlayModal
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-6 ws-scrim-in"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="nowheel flex max-h-[88vh] w-[min(44rem,94vw)] flex-col gap-3 overflow-y-auto ws-dialog-in ws-elev-modal rounded-xl bg-surface-1 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
              <Sun className="h-4 w-4" />
              打光 · {d?.title || "未命名"}
            </h3>
            <p className="mt-0.5 text-[11px] text-text-4">
              拖光位球或点方位钮定主光，生成新卡片（画面内容与构图不变，只换光）
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

        <div className="flex flex-col gap-4 sm:flex-row">
          {/* 左：球控 + 视图切换 */}
          <div className="flex shrink-0 flex-col items-center gap-1.5">
            <div className="flex gap-1">
              {(["perspective", "front"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`rounded-md border px-2 py-0.5 text-[10px] transition-colors ${
                    viewMode === v
                      ? "border-accent bg-accent-dim text-text"
                      : "border-hairline text-text-3 hover:text-text"
                  }`}
                  onClick={() => setViewMode(v)}
                >
                  {v === "perspective" ? "透视" : "正面"}
                </button>
              ))}
            </div>
            <LightingSphereControl
              azimuth={azimuth}
              elevation={elevation}
              onAngleChange={(az, el) => {
                setAzimuth(az);
                setElevation(el);
              }}
              previewImageUrl={d?.imageUrl ? assetThumbUrl(d.imageUrl) : null}
              viewMode={viewMode}
            />
          </div>

          {/* 中：主光方位 + 亮度 + 轮廓光 + 色温 */}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-text-4">
                主光方位
              </p>
              <div className="flex flex-wrap gap-1">
                {LIGHT_POSITIONS.map((p) => {
                  const on = p.azimuth === azimuth && p.elevation === elevation;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                        on
                          ? "border-accent bg-accent-dim text-text"
                          : "border-hairline text-text-3 hover:text-text"
                      }`}
                      onClick={() => {
                        setAzimuth(p.azimuth);
                        setElevation(p.elevation);
                      }}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-wide text-text-4">
                  亮度
                </p>
                <p className="text-[10px] tabular-nums text-text-3">{brightness}%</p>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={brightness}
                className={rangeCls}
                onChange={(e) => setBrightness(Number(e.target.value))}
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-medium uppercase tracking-wide text-text-4">
                轮廓光
              </p>
              <button
                type="button"
                aria-label={rimLight ? "关闭轮廓光" : "开启轮廓光"}
                onClick={() => setRimLight((v) => !v)}
                className={`relative h-5 w-9 rounded-full border transition-colors ${
                  rimLight ? "border-accent bg-accent-dim" : "border-hairline bg-surface-2"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-[left,background-color] duration-150 ease-out ${
                    rimLight ? "left-[18px] bg-accent" : "left-0.5 bg-text-4"
                  }`}
                />
              </button>
            </div>

            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-text-4">
                色温
              </p>
              <div className="flex flex-wrap gap-1.5">
                {LIGHT_COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    data-tip={c.label} aria-label={`色温 ${c.label}`}
                    onClick={() => setColorId(c.id)}
                    className={`h-5 w-5 rounded-full border-2 transition-transform hover:scale-110 ${
                      colorId === c.id ? "border-accent" : "border-hairline"
                    }`}
                    style={{ backgroundColor: c.dot }}
                  />
                ))}
              </div>
            </div>

            <textarea
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="补充要求（可选）：如 只照亮脸部、保留窗外夜色…"
              rows={2}
              maxLength={300}
              className="w-full resize-none rounded-md border border-hairline bg-surface-2/60 px-2 py-1.5 text-xs text-text outline-none focus:border-accent placeholder:text-text-4"
            />
          </div>
        </div>

        {/* 预设卡（camera.py LIGHT_PRESETS，导演台布光区同源） */}
        {presets && presets.length > 0 ? (
          <div>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-text-4">
              光效预设（再点一次取消）
            </p>
            <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
              {presets.map((p) => {
                const on = presetId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    title={p.prompt}
                    className={`group flex h-14 flex-col items-center justify-end overflow-hidden rounded-md border p-1 transition-colors ${
                      on ? "border-accent" : "border-hairline hover:border-accent-soft"
                    }`}
                    style={{
                      backgroundImage: PRESET_GRADIENTS[p.id] ?? undefined,
                      backgroundColor: PRESET_GRADIENTS[p.id] ? undefined : "var(--color-surface-2)",
                    }}
                    onClick={() => setPresetId((cur) => (cur === p.id ? "" : p.id))}
                  >
                    <span
                      className={`w-full truncate rounded px-0.5 text-[10px] font-medium ${
                        PRESET_GRADIENTS[p.id] ? "text-white/90" : "text-text-2"
                      }`}
                      style={{ textShadow: PRESET_GRADIENTS[p.id] ? "0 1px 2px rgba(0,0,0,0.5)" : undefined }}
                    >
                      {p.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="flex shrink-0 items-center justify-between gap-2">
          <p className="text-[10px] text-text-4">
            生成新卡片并连线到本卡（画面内容不变，只替换光效）
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
              data-track="image.lighting"
              disabled={busy}
              onClick={confirm}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              生成打光卡
            </button>
          </div>
        </div>
      </div>
    </OverlayModal>
  );
}
