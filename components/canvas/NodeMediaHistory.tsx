"use client";

/**
 * 版本历史弹窗（master-detail，对标 novanova 详情弹窗左大图+右信息栏、
 * ai-moive 历史抽屉的列表密度）：
 *  - 左侧主预览：object-contain 跟比例（竖图撑满高度看细节），点击进灯箱
 *    看原尺寸；「与当前版本对比」在此区切换 A/B 滑杆（两层 contain 自动跟
 *    随比例，竖图对比无黑边）
 *  - 右侧版本列表：当前 + 历史存档（重生成/上传覆盖前自动入档），点行即
 *    预览；「设为当前」回滚（当前版入档 + genPrompt 回滚，与 Lightbox 的
 *    restoreVersion 同契约，两处改一起改）
 *  - 经 OverlayModal portal 到 body：画布节点树内 fixed 定位会被 viewport
 *    transform 劫持（宽度被钉死在卡宽、背板只盖卡片），必须 portal
 */

import { useEffect, useRef, useState } from "react";
import { Columns2, GitCompareArrows, X } from "lucide-react";
import type { WingNodeData } from "@/lib/canvas/store";
import { useCanvasStore } from "@/lib/canvas/store";
import OverlayModal from "./OverlayModal";
import { Lightbox } from "./Lightbox";
import { assetThumbUrl } from "@/lib/asset-thumb";

type Version = { url: string; at: string; prompt?: string };

function isVideoUrl(url: string) {
  return /\.(mp4|webm|mov)(\?|$)/i.test(url);
}

/** 主预览：图片点击进灯箱；视频带控制条（不进灯箱——灯箱只处理图片） */
function PreviewMedia({ url, onZoom }: { url: string; onZoom: () => void }) {
  if (isVideoUrl(url)) {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        className="max-h-full max-w-full rounded-lg object-contain"
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      onClick={onZoom}
      className="max-h-full max-w-full cursor-zoom-in rounded-lg object-contain shadow-2xl"
      draggable={false}
    />
  );
}

/** 版本列表行：小方缩略图（识别用，看细节在左侧大图）+ 标签 + 时间 */
function Row({
  v,
  label,
  active,
  onClick,
}: {
  v: Version;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg border p-1.5 text-left transition-colors ${
        active
          ? "border-accent bg-accent/5"
          : "border-transparent hover:border-hairline hover:bg-surface-2"
      }`}
    >
      {isVideoUrl(v.url) ? (
        <video
          src={v.url}
          muted
          preload="metadata"
          className="h-12 w-12 shrink-0 rounded-md bg-black object-cover"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={assetThumbUrl(v.url)}
          alt={label}
          className="h-12 w-12 shrink-0 rounded-md object-cover"
        />
      )}
      <span className="min-w-0">
        <span
          className={`block text-xs font-medium ${active ? "text-text" : "text-text-2"}`}
        >
          {label}
        </span>
        <span className="block truncate text-[10px] text-text-4">
          {v.at === "当前" ? "当前版本" : v.at}
        </span>
      </span>
    </button>
  );
}

/** A/B 滑杆对比（clipPath 裁上层图露下层图；两层 object-contain，滑杆跟随图片比例） */
function ABCompare({ a, b }: { a: string; b: string }) {
  const [split, setSplit] = useState(50);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const moveTo = (clientX: number) => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setSplit(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)));
  };
  return (
    <div
      ref={hostRef}
      className="relative h-full w-full cursor-ew-resize select-none overflow-hidden rounded-lg bg-black"
      onPointerDown={(e) => {
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        moveTo(e.clientX);
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) moveTo(e.clientX);
      }}
      onPointerUp={(e) => {
        draggingRef.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={b} alt="B" className="absolute inset-0 h-full w-full object-contain" draggable={false} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={a}
        alt="A"
        className="absolute inset-0 h-full w-full object-contain"
        draggable={false}
        style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
      />
      <div
        className="pointer-events-none absolute inset-y-0 w-px bg-white/90 shadow-[0_0_0_1px_rgba(0,0,0,.35)]"
        style={{ left: `${split}%` }}
      />
      <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">
        A
      </span>
      <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">
        B
      </span>
    </div>
  );
}

export default function VersionHistoryModal({
  nodeId,
  data,
  onClose,
}: {
  nodeId: string;
  data: WingNodeData;
  onClose: () => void;
}) {
  const primary = data.imageUrl ?? data.videoUrl ?? "";
  const versions = data.versions ?? [];
  const isVideo = Boolean(data.videoUrl);
  const [selected, setSelected] = useState<Version | null>(null);
  const [compare, setCompare] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const entries: Version[] = [
    ...versions,
    ...(primary ? [{ url: primary, at: "当前", prompt: data.genPrompt }] : []),
  ].reverse();
  const currentEntry = entries.find((v) => v.at === "当前") ?? null;
  // 提示词/操作针对选中的版本，未选中默认当前版
  const detail = selected ?? currentEntry;
  const labelOf = (v: Version) =>
    v.at === "当前" ? "当前" : `V${entries.length - entries.indexOf(v)}`;
  const canCompare =
    !!detail &&
    !!currentEntry &&
    detail !== currentEntry &&
    !isVideoUrl(detail.url) &&
    !isVideoUrl(primary);

  useEffect(() => {
    if (zoomed) return; // 灯箱开着时 Esc 归灯箱
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [zoomed, onClose]);

  const restore = (v: Version) => {
    const st = useCanvasStore.getState();
    st.commitHistory();
    const cur: Version = {
      url: primary,
      at: new Date().toISOString().slice(5, 16).replace("T", " "),
      prompt: data.genPrompt,
    };
    const rest = (data.versions ?? []).filter((x) => x.url !== v.url);
    st.updateNodeData(nodeId, {
      ...(isVideo ? { videoUrl: v.url } : { imageUrl: v.url }),
      // 回滚旧版 = 连它当时的提示词一起恢复（面板再生成不串词）
      genPrompt: v.prompt || data.genPrompt,
      versions: [...rest, cur],
    });
    onClose();
  };

  const previewLabel = compare && detail ? `A ${labelOf(detail)} / B 当前` : detail ? labelOf(detail) : "";

  return (
    <OverlayModal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex h-[min(82vh,760px)] w-full max-w-5xl flex-col gap-3 rounded-xl border border-hairline bg-surface-1 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
            <GitCompareArrows className="h-4 w-4" />
            版本历史 · {data.title || "未命名"}
          </h3>
          <button type="button" data-tip="关闭" aria-label="关闭" className="rounded p-0.5 text-text-4 hover:text-text" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 gap-3">
          {/* 左：主预览（对比模式换成 A/B 滑杆） */}
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-black">
            {detail ? (
              compare && canCompare ? (
                <ABCompare a={detail.url} b={primary} />
              ) : (
                <PreviewMedia url={detail.url} onZoom={() => setZoomed(true)} />
              )
            ) : null}
            {detail && !compare ? (
              <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">
                {previewLabel}
              </span>
            ) : null}
          </div>

          {/* 右：版本列表 + 提示词 + 操作 */}
          <div className="flex w-56 shrink-0 flex-col gap-2">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="flex flex-col gap-1">
                {entries.map((v, i) => (
                  <Row
                    key={`${v.url}_${i}`}
                    v={v}
                    label={labelOf(v)}
                    active={detail === v}
                    onClick={() => {
                      setSelected(v);
                      setCompare(false);
                    }}
                  />
                ))}
              </div>
            </div>
            {detail?.prompt ? (
              <div className="shrink-0 rounded-md border border-hairline-soft bg-surface-2 p-2">
                <p className="text-[10px] text-text-4">
                  {compare ? `${labelOf(detail)}（A）提示词` : `${labelOf(detail)}提示词`}
                </p>
                <p className="mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-text-2">
                  {detail.prompt}
                </p>
              </div>
            ) : null}
            <div className="flex shrink-0 flex-col gap-1.5">
              {canCompare ? (
                <button
                  type="button"
                  className={`flex items-center justify-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                    compare
                      ? "border-accent text-accent hover:bg-accent/5"
                      : "border-hairline text-text-2 hover:border-accent hover:text-text"
                  }`}
                  onClick={() => setCompare(!compare)}
                >
                  <Columns2 className="h-3.5 w-3.5" />
                  {compare ? "退出对比" : "与当前版本对比"}
                </button>
              ) : null}
              {detail && detail !== currentEntry ? (
                <button
                  type="button"
                  className="flex items-center justify-center rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-1 transition-opacity hover:opacity-90"
                  onClick={() => restore(detail)}
                >
                  设为当前版本
                </button>
              ) : (
                <button
                  type="button"
                  disabled
                  className="flex items-center justify-center rounded-md border border-hairline px-3 py-1.5 text-xs font-medium text-text-4"
                >
                  当前版本
                </button>
              )}
              <p className="text-center text-[10px] leading-relaxed text-text-4">
                重生成时旧图自动存档{isVideoUrl(detail?.url ?? "") ? "" : " · 点预览看原尺寸"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {zoomed && detail ? (
        <Lightbox
          images={[{ src: detail.url, title: `${data.title ?? ""} · ${labelOf(detail)}` }]}
          index={0}
          onIndex={() => undefined}
          onClose={() => setZoomed(false)}
        />
      ) : null}
    </OverlayModal>
  );
}
