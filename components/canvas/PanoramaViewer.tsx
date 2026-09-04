"use client";

/**
 * 全景环视查看器（doc/image-panorama-spec.md §2.5）：photo-sphere-viewer
 * 等距柱状球形查看（~106KB，竞品 open-storyboard 同款选型）。只经 Lightbox
 * 动态 import 懒加载，不进主 bundle。
 *
 * 载入前做竞品同款几何矫形（panoramaNormalize.ts 移植，§4 探针矩阵的分工
 * 结论——在售模型画不出严格等距柱状几何，prompt 只能防鱼眼圆框/单视角横幅，
 * 衔接观感由前端兜底）：① center-crop 到 2:1（生成端已显式请求 2:1，此步
 * 通常恒等，兜通道比例漂移）② 左右边缘 48px 线性羽化交叉淡化——环视 wrap
 * 359°→0° 处的接缝突变抹平。比例偏离 >8% 时仍亮横条明示（矫形是产品决策
 * 不是静默修正，异常照旧明报）。
 */
import { useEffect, useRef, useState } from "react";
import { Viewer } from "@photo-sphere-viewer/core";
import "@photo-sphere-viewer/core/index.css";

/** 竞品同款矫形：crop 2:1 + 右缘羽化混合左缘条带（镜像渐隐消接缝） */
async function normalizePanorama(src: string): Promise<string> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("全景图加载失败"));
    img.src = src;
  });
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  if (!srcW || !srcH) return src;
  // center-crop 到 2:1（宽了削两侧，窄了削上下）
  let cropW: number, cropH: number, cropX: number, cropY: number;
  if (srcW / srcH >= 2) {
    cropH = srcH;
    cropW = srcH * 2;
    cropX = Math.round((srcW - cropW) / 2);
    cropY = 0;
  } else {
    cropW = srcW;
    cropH = Math.round(srcW / 2);
    cropX = 0;
    cropY = Math.round((srcH - cropH) / 2);
  }
  const canvas = document.createElement("canvas");
  canvas.width = cropW;
  canvas.height = cropH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return src;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  // 羽化接缝：取左缘条带，在右缘上按 (1-t)^1.2 线性混入——wrap 处像素
  // 靠外侧几乎全取左缘样本，与 0° 处衔接；内侧渐回原样
  const feather = Math.min(48, Math.floor(cropW / 6));
  if (feather > 4) {
    const leftStrip = ctx.getImageData(0, 0, feather, cropH);
    const rightStrip = ctx.getImageData(cropW - feather, 0, feather, cropH);
    const out = ctx.createImageData(feather, cropH);
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < feather; x++) {
        const w = Math.pow(1 - x / feather, 1.2);
        const idx = (y * feather + x) * 4;
        for (let c = 0; c < 3; c++)
          out.data[idx + c] = Math.round(
            rightStrip.data[idx + c] * (1 - w) + leftStrip.data[idx + c] * w,
          );
        out.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(out, cropW - feather, 0);
  }
  // 全景是摄影内容，JPEG 0.92 观察 Web 端无损感（PNG data URL 2880 宽会上 10MB+）
  return canvas.toDataURL("image/jpeg", 0.92);
}

export default function PanoramaViewer({ src }: { src: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [warn, setWarn] = useState("");
  const [failed, setFailed] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let viewer: Viewer | null = null;
    let destroyed = false;
    // 环视手势（2026-09-04 控制手感反馈；Figma/Maps 业界标准）：
    // 裸滚轮/触摸板双指滑动 = 平移环视（yaw/pitch），捏合/Ctrl+滚轮 = 缩放
    // ——触摸板捏合在浏览器就是 ctrlKey wheel（系统级手势），鼠标滚轮做
    // 平移俯仰、Ctrl+滚缩放。PSV 内建 mousewheel（滚轮=缩放）关闭，触摸板
    // 双指滑曾疯狂误缩放
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const v = viewer;
      if (!v) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode ? 1.5 : 1;
      if (e.ctrlKey || e.metaKey) {
        // zoom(level) 是绝对档（0-100）：在当前档上做相对增量，钳 0-100
        const next = Math.max(
          0,
          Math.min(100, v.getZoomLevel() - e.deltaY * unit * 0.12),
        );
        v.zoom(next);
        return;
      }
      const pos = v.getPosition();
      // 内容跟手：向右滑（deltaX<0）= 把画面往右带 = 视角左转（yaw 减）；
      // 俯仰同向并钳在 ±85°，防过极点翻转
      const k = 0.0022 * unit;
      const yaw = pos.yaw + e.deltaX * k;
      const pitch = Math.max(
        -1.48,
        Math.min(1.48, pos.pitch + e.deltaY * k),
      );
      v.rotate({ yaw, pitch });
    };
    host.addEventListener("wheel", onWheel, { passive: false, capture: true });
    normalizePanorama(src)
      .then((panoUrl) => {
        if (destroyed) return;
        try {
          viewer = new Viewer({
            container: host,
            panorama: panoUrl,
            navbar: false,
            minFov: 30,
            maxFov: 90,
            mousewheel: false,
            // 拖拽惯性（v5 可传时长 ms；true=默认节奏）——false 时松手即停，
            // 拖起来像拖木头（2026-09-04 控制手感反馈）
            moveInertia: true,
            // 鼠标悬停不按压也转视角（易误触，保持关闭）
            mousemove: false,
            defaultZoomLvl: 50,
          });
        } catch (e) {
          // 同步 setState 会触发 React Compiler 的级联渲染规则——微任务里落
          const msg = e instanceof Error ? e.message : String(e);
          queueMicrotask(() => {
            if (!destroyed) setFailed(msg);
          });
        }
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (!destroyed) setFailed(msg);
      });
    // 比例校验：非 2:1 明示可看（生成端已显式请求 2:1，偏离属通道异常；
    // 矫形已 crop 兜底，横条让用户知情可选重新生成）
    const check = new Image();
    check.onload = () => {
      if (destroyed) return;
      const r = check.naturalWidth / check.naturalHeight;
      if (r > 0 && Math.abs(r - 2) / 2 > 0.08)
        queueMicrotask(() => {
          if (!destroyed)
            setWarn(
              `生成结果非 2:1（实际 ${r.toFixed(2)}:1），环视可能失真，建议重新生成`,
            );
        });
    };
    check.src = src;
    return () => {
      destroyed = true;
      host.removeEventListener("wheel", onWheel, { capture: true });
      viewer?.destroy();
    };
  }, [src]);

  if (failed)
    return (
      <div className="grid h-full w-full place-items-center text-sm text-white/70">
        全景查看器加载失败：{failed}
      </div>
    );
  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg">
      {warn ? (
        <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-amber-200 shadow">
          {warn}
        </div>
      ) : null}
      <div
        className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/45 px-3 py-1 text-[11px] text-white/75 backdrop-blur-sm"
      >
        拖拽 / 双指滑动 = 环视 · 捏合 / Ctrl+滚轮 = 缩放
      </div>
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
