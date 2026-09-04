"use client";

/**
 * 导演台弹层（对标 libtv 导演台 / open-ai-canvas prompt 编译 / osc 虚拟摄影机）：
 *  - 景别 / 运镜 / 时长 + 机身 / 焦段 / 光圈 / 布光（语汇来自 agent camera.py）
 *  - 实时预览编译出的中文摄影语言
 *  - 应用：写入卡片 body 的【摄影】段 + 同步分镜卡的景别/运镜/时长字段
 */

import { useEffect, useMemo, useState } from "react";
import { Camera, Copy, X } from "lucide-react";
import { useCanvasStore, type WingNode } from "@/lib/canvas/store";
import {
  APERTURES,
  CAMERA_MOVES,
  SHOT_SIZES,
  applyCineToBody,
  compileCinePrompt,
  getCameraVocab,
  type CameraVocab,
  type CineSelection,
} from "@/lib/camera-vocab";

function Chip({
  active,
  disabled,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
        active
          ? "border-accent bg-accent-dim text-text"
          : "border-hairline bg-surface-2 text-text-2 hover:border-accent-soft hover:text-text"
      } disabled:cursor-not-allowed disabled:opacity-40`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-text-4">
        {label}
      </p>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

export default function DirectorPanel({
  node,
  onClose,
}: {
  node: WingNode;
  onClose: () => void;
}) {
  const d = node.data;
  const [vocab, setVocab] = useState<CameraVocab | null>(null);
  const [copied, setCopied] = useState(false);
  const [sel, setSel] = useState<CineSelection>({
    shotSize: SHOT_SIZES.includes(d.shotSize as (typeof SHOT_SIZES)[number])
      ? (d.shotSize as string)
      : "中景",
    moveId: CAMERA_MOVES.find((m) => m.label === d.cameraMove)?.id ?? "static",
    duration: d.duration || "3s",
    cameraId: "",
    focal: "",
    aperture: "f/2.8",
    lights: [],
  });

  useEffect(() => {
    let alive = true;
    void getCameraVocab().then((v) => {
      if (!alive) return;
      setVocab(v);
      // 默认选第一台机身与其默认焦段（已有选择则尊重）
      setSel((s) =>
        s.cameraId || v.cameras.length === 0
          ? s
          : {
              ...s,
              cameraId: v.cameras[0].id,
              focal: v.cameras[0].lenses[0] ?? "",
            },
      );
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const compiled = useMemo(
    () => compileCinePrompt(sel, vocab ?? { cameras: [], lensHints: {}, lightHints: [] }),
    [sel, vocab],
  );

  const apply = () => {
    const st = useCanvasStore.getState();
    st.commitHistory();
    const move = CAMERA_MOVES.find((m) => m.id === sel.moveId);
    st.updateNodeData(node.id, {
      body: applyCineToBody(d.body ?? "", compiled),
      ...(d.nodeType === "storyboard"
        ? { shotSize: sel.shotSize, cameraMove: move?.label ?? "固定", duration: sel.duration }
        : {}),
    });
    onClose();
  };

  const cam = vocab?.cameras.find((c) => c.id === sel.cameraId);

  return (
    <div
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="nowheel flex max-h-[82vh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 font-editorial text-sm font-semibold text-text">
            <Camera className="h-4 w-4" />
            导演台 · {d.title || "镜头"}
          </h3>
          <button
            type="button"
            data-tip="关闭（Esc）" aria-label="关闭（Esc）"
            className="rounded p-0.5 text-text-4 hover:text-text"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <Section label="景别">
          {SHOT_SIZES.map((s) => (
            <Chip key={s} active={sel.shotSize === s} onClick={() => setSel({ ...sel, shotSize: s })}>
              {s}
            </Chip>
          ))}
        </Section>

        <Section label="运镜">
          {CAMERA_MOVES.map((m) => (
            <Chip key={m.id} active={sel.moveId === m.id} onClick={() => setSel({ ...sel, moveId: m.id })}>
              {m.label}
            </Chip>
          ))}
        </Section>

        <Section label="时长">
          {["2s", "3s", "5s", "8s", "10s+"].map((t) => (
            <Chip key={t} active={sel.duration === t} onClick={() => setSel({ ...sel, duration: t })}>
              {t}
            </Chip>
          ))}
        </Section>

        {vocab && vocab.cameras.length > 0 ? (
          <>
            <Section label="机身">
              {vocab.cameras.map((c) => (
                <Chip
                  key={c.id}
                  active={sel.cameraId === c.id}
                  onClick={() =>
                    setSel({
                      ...sel,
                      cameraId: c.id,
                      focal: c.lenses.includes(sel.focal) ? sel.focal : (c.lenses[0] ?? ""),
                    })
                  }
                >
                  {c.id}
                </Chip>
              ))}
            </Section>

            <Section label={`焦段${cam ? `（${cam.id}）` : ""}`}>
              {(cam?.lenses ?? []).map((f) => (
                <Chip key={f} active={sel.focal === f} onClick={() => setSel({ ...sel, focal: f })}>
                  {f}
                </Chip>
              ))}
            </Section>
          </>
        ) : null}

        <Section label="光圈">
          {APERTURES.map((a) => (
            <Chip key={a} active={sel.aperture === a} onClick={() => setSel({ ...sel, aperture: a })}>
              {a}
            </Chip>
          ))}
        </Section>

        {vocab && vocab.lightHints.length > 0 ? (
          <Section label="布光（可多选）">
            {vocab.lightHints.map((l) => (
              <Chip
                key={l}
                active={sel.lights.includes(l)}
                onClick={() =>
                  setSel({
                    ...sel,
                    lights: sel.lights.includes(l)
                      ? sel.lights.filter((x) => x !== l)
                      : [...sel.lights, l],
                  })
                }
              >
                {l}
              </Chip>
            ))}
          </Section>
        ) : null}

        <div>
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-text-4">
            摄影语言预览
          </p>
          <p className="rounded-lg border border-hairline bg-surface-2 p-2.5 text-xs leading-relaxed text-text-2">
            {compiled}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-hairline px-3 py-1.5 text-xs text-text-2 transition-colors hover:bg-surface-2"
            onClick={() => {
              void navigator.clipboard?.writeText(compiled).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? "已复制" : "复制提示词"}
          </button>
          <button
            type="button"
            className="rounded-md border border-accent bg-accent-dim px-3 py-1.5 text-xs text-text transition-colors hover:bg-accent-soft"
            onClick={apply}
          >
            应用到卡片
          </button>
        </div>
      </div>
    </div>
  );
}
