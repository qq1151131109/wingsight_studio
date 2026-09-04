"use client";

/**
 * 相机球控（移植自 references/open-storyboard-canvas CameraSphereControl.tsx，
 * 2026-09-04 按体验最优拍板）：Canvas 2D 线框球（经纬线随角度旋转产生视差）
 * + CSS 3D 三相位相机模型（正面=背身带实时预览小屏 / 背面=镜头 / 侧面=薄身）
 * + 金色轨道线 + 四向微调钮。纯前端零 3D 依赖；输入=两角度+一张预览图。
 * 适配：配色走我们的暗视口隐喻（球控所在弹窗内自成一体的深色区）。
 */

import { memo, useState, useCallback, useRef, useEffect } from "react";
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

export interface CameraSphericalPosition {
  horizontal: number;
  vertical: number;
}

interface CameraSphereControlProps {
  horizontal: number;
  vertical: number;
  onPositionChange: (horizontal: number, vertical: number) => void;
  previewImageUrl?: string | null;
  /** 景别联动：球心主体图缩放（特写 1.5 → 远景 0.62），视觉反馈取景远近 */
  imageScale?: number;
}

function drawSphere(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  horizontal: number,
  vertical: number,
  previewImageUrl: string | null | undefined,
  imageScale: number,
) {
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 16;

  ctx.beginPath();
  ctx.roundRect(8, 8, w - 16, h - 16, 18);
  ctx.fillStyle = "#2e2a24"; // 米黄纸感项目的暗视口底（暖灰而非纯黑）
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.24)";
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();

  const hRad = (horizontal * Math.PI) / 180;
  const vRad = (vertical * Math.PI) / 180;

  // 纬线：垂直角让纬线上移/压扁，产生俯仰视差错觉（原实现核心手法）
  for (let lat = -75; lat <= 75; lat += 10) {
    const latRad = (lat * Math.PI) / 180;
    const r = R * Math.cos(latRad);
    const baseY = cy - R * Math.sin(latRad + vRad * 0.38);
    ctx.beginPath();
    ctx.ellipse(
      cx,
      baseY,
      r * Math.abs(Math.cos(vRad * 0.14)),
      Math.max(1, r * 0.22),
      0,
      0,
      Math.PI * 2,
    );
    ctx.strokeStyle = lat === 0 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.1)";
    ctx.lineWidth = lat === 0 ? 1.0 : 0.7;
    ctx.stroke();
  }

  // 经线：水平角旋转经线（14 条）
  const NUM_MERIDIANS = 14;
  for (let i = 0; i < NUM_MERIDIANS; i++) {
    const angle = (i * Math.PI) / (NUM_MERIDIANS / 2) + hRad;
    const a = R * Math.abs(Math.cos(angle));
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(1, a), R, 0, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }

  if (previewImageUrl) {
    const img = new Image();
    img.onload = () => {
      const maxW = R * 0.72 * imageScale;
      const maxH = R * 0.96 * imageScale;
      const aspect =
        img.naturalWidth > 0 && img.naturalHeight > 0
          ? img.naturalWidth / img.naturalHeight
          : 1;
      let drawW = maxW;
      let drawH = drawW / aspect;
      if (drawH > maxH) {
        drawH = maxH;
        drawW = drawH * aspect;
      }
      const drawX = cx - drawW / 2;
      const drawY = cy - drawH / 2;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.65)";
      ctx.shadowBlur = 8;
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,255,255,0.26)";
      ctx.lineWidth = 1;
      ctx.strokeRect(drawX, drawY, drawW, drawH);
      ctx.restore();
    };
    img.src = previewImageUrl;
  } else {
    const maxW = R * 0.62 * imageScale;
    const maxH = R * 0.9 * imageScale;
    const drawX = cx - maxW / 2;
    const drawY = cy - maxH / 2;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(drawX, drawY, maxW, maxH);
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 1;
    ctx.strokeRect(drawX, drawY, maxW, maxH);
  }

  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, 1.2, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.fill();
}

export const CameraSphereControl = memo(
  ({
    horizontal,
    vertical,
    onPositionChange,
    previewImageUrl,
    imageScale = 1,
  }: CameraSphereControlProps) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const dragStartRef = useRef<{ x: number; y: number; h: number; v: number } | null>(null);

    const SIZE = 280;

    const redraw = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(SIZE * dpr);
      canvas.height = Math.round(SIZE * dpr);
      canvas.style.width = `${SIZE}px`;
      canvas.style.height = `${SIZE}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      drawSphere(ctx, SIZE, SIZE, horizontal, vertical, previewImageUrl, imageScale);
    }, [horizontal, vertical, previewImageUrl, imageScale]);

    useEffect(() => {
      redraw();
    }, [redraw]);

    const handlePointerDown = useCallback(
      (e: React.PointerEvent) => {
        e.preventDefault();
        setIsDragging(true);
        dragStartRef.current = { x: e.clientX, y: e.clientY, h: horizontal, v: vertical };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      },
      [horizontal, vertical],
    );

    const handlePointerMove = useCallback(
      (e: React.PointerEvent) => {
        if (!isDragging || !dragStartRef.current) return;
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        let nextHorizontal = (dragStartRef.current.h + dx * 1.2) % 360;
        if (nextHorizontal < 0) nextHorizontal += 360;
        const nextVertical = Math.max(
          -90,
          Math.min(90, dragStartRef.current.v - dy * 0.8),
        );
        onPositionChange(Math.round(nextHorizontal), Math.round(nextVertical));
      },
      [isDragging, onPositionChange],
    );

    const handlePointerUp = useCallback((e: React.PointerEvent) => {
      setIsDragging(false);
      dragStartRef.current = null;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    }, []);

    const horizontalRad = (horizontal * Math.PI) / 180;
    const normalizedHorizontal = ((horizontal % 360) + 360) % 360;
    const depth = Math.cos(horizontalRad);
    const sideAmount = Math.abs(Math.sin(horizontalRad));
    const isRightHemisphere = normalizedHorizontal > 0 && normalizedHorizontal < 180;
    const orbitX = Math.sin(horizontalRad) * 88;
    // 0°/0° 时相机图钉正压主体图中心；垂直角单独控制高度偏移（原实现注释）
    const orbitY = (-vertical / 90) * 68;
    const cameraScale = 0.74 + ((depth + 1) / 2) * 0.24;
    const cameraOpacity = 0.65 + ((depth + 1) / 2) * 0.35;
    const shadowStrength = 0.18 + ((depth + 1) / 2) * 0.28;
    const isFrontPhase = normalizedHorizontal <= 90 || normalizedHorizontal >= 270;
    const isBackPhase = !isFrontPhase;
    const isProfile = sideAmount > 0.82;
    const rotateY = (normalizedHorizontal <= 180 ? -1 : 1) * sideAmount * 20;
    const rotateX = -vertical * 0.12;
    const bodyScaleX = Math.max(0.28, 1 - sideAmount * 0.62);
    const lensScaleX = Math.max(0.38, 1 - sideAmount * 0.48);
    const lineLength = Math.sqrt(orbitX * orbitX + orbitY * orbitY);
    const lineAngle = (Math.atan2(orbitY, orbitX) * 180) / Math.PI;

    return (
      <div className="relative select-none" style={{ width: SIZE, height: SIZE }}>
        <canvas
          ref={canvasRef}
          width={SIZE}
          height={SIZE}
          className="nowheel touch-none cursor-grab rounded-lg active:cursor-grabbing"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          style={{ display: "block" }}
        />

        {/* 轨道线：中心 → 相机 */}
        <div
          className="absolute left-1/2 top-1/2 origin-left"
          style={{
            width: `${lineLength}px`,
            height: "2px",
            transform: `translate(0, -50%) rotate(${lineAngle}deg)`,
            background:
              "linear-gradient(to right, rgba(207,176,84,0.55), rgba(207,176,84,0.08))",
            opacity: 0.5,
          }}
        />

        {/* 相机标记（CSS 3D 三相位） */}
        <div
          className="absolute"
          style={{
            left: `calc(50% + ${orbitX}px)`,
            top: `calc(50% + ${orbitY}px)`,
            transform: `translate(-50%, -50%) scale(${cameraScale})`,
            opacity: cameraOpacity,
          }}
        >
          <div
            className="absolute left-1/2 top-[30px] h-3 w-8 -translate-x-1/2 rounded-full bg-black/45 blur-[4px]"
            style={{ opacity: shadowStrength }}
          />
          <div
            className="relative h-9 w-12"
            style={{
              transform: `perspective(180px) rotateY(${rotateY}deg) rotateX(${rotateX}deg)`,
              transformStyle: "preserve-3d",
            }}
          >
            {/* 机身 */}
            <div
              className="absolute inset-0 rounded-[10px] border bg-[linear-gradient(180deg,#333_0%,#1a1a1a_100%)] shadow-[0_6px_16px_rgba(0,0,0,0.42)]"
              style={{
                borderColor: "rgba(255,255,255,0.12)",
                transform: `scaleX(${bodyScaleX})`,
                transformOrigin: "center center",
                filter: depth < 0 ? "brightness(0.82) saturate(0.82)" : "none",
              }}
            />
            {/* 侧厚度 */}
            {!isProfile ? (
              <>
                <div
                  className="absolute top-[6px] h-[32px] w-[10px] rounded-[4px] bg-[linear-gradient(180deg,#3f3f3f_0%,#191919_100%)]"
                  style={{
                    [isRightHemisphere ? "right" : "left"]: "-3px",
                    opacity: 0.34 + sideAmount * 0.42,
                  }}
                />
                <div
                  className="absolute left-1/2 top-[3px] h-[7px] w-[26px] -translate-x-1/2 rounded-[5px] bg-[linear-gradient(180deg,#4a4a4a_0%,#272727_100%)]"
                  style={{ opacity: 0.16 + (1 - sideAmount) * 0.18 }}
                />
              </>
            ) : null}
            {/* 顶块 */}
            <div
              className="absolute left-[8px] top-[5px] h-2 w-3.5 rounded-[4px] bg-white/8"
              style={{ opacity: isProfile ? 0.4 : 1 }}
            />
            {/* 背身相位：实时预览小屏 */}
            {isFrontPhase && !isProfile ? (
              <>
                <div
                  className="absolute left-1/2 top-[6px] h-[18px] w-[28px] -translate-x-1/2 rounded-[5px] border border-white/10 bg-[linear-gradient(180deg,#2a2a2a_0%,#0f0f0f_100%)] shadow-[inset_0_1px_1px_rgba(255,255,255,0.06)]"
                  style={{ transform: `translateX(-50%) scaleX(${Math.max(0.55, bodyScaleX)})` }}
                />
                <div
                  className="absolute left-1/2 top-[8px] h-[14px] w-[24px] -translate-x-1/2 overflow-hidden rounded-[4px] border border-white/10 bg-[#101010]"
                  style={{ transform: `translateX(-50%) scaleX(${Math.max(0.55, bodyScaleX)})` }}
                >
                  {previewImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={previewImageUrl}
                      alt="camera screen"
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : null}
                </div>
              </>
            ) : null}
            {/* 镜头相位 */}
            {isBackPhase && !isProfile ? (
              <div
                className="absolute left-1/2 top-[10px] flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full bg-[radial-gradient(circle_at_35%_35%,#5a5a5a_0%,#2d2d2d_48%,#0d0d0d_100%)] shadow-[inset_0_1px_2px_rgba(255,255,255,0.08)]"
                style={{ transform: `translateX(-50%) scaleX(${lensScaleX})` }}
              >
                <div className="h-3.5 w-3.5 rounded-full bg-black ring-[2px] ring-white/88 shadow-[inset_0_0_8px_rgba(255,255,255,0.08)]" />
                <div className="absolute right-[2px] top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-red-500/90" />
              </div>
            ) : null}
            {/* 侧面薄身相位 */}
            {isProfile ? (
              <>
                <div className="absolute left-1/2 top-[6px] h-8 w-4 -translate-x-1/2 rounded-[6px] border border-white/10 bg-[linear-gradient(180deg,#2f2f2f_0%,#151515_100%)]" />
                <div className="absolute left-1/2 top-[14px] h-4 w-2.5 -translate-x-1/2 rounded-full bg-[linear-gradient(180deg,#4a4a4a_0%,#0f0f0f_100%)] ring-1 ring-white/10" />
              </>
            ) : null}
          </div>
        </div>

        {/* 四向微调（每次 ±12°） */}
        <button
          type="button"
          aria-label="俯仰上调"
          className="absolute left-1/2 top-5 flex h-5 w-5 -translate-x-1/2 items-center justify-center text-white/45 transition-colors hover:text-white/80"
          onClick={(e) => {
            e.stopPropagation();
            onPositionChange(horizontal, Math.min(90, vertical + 12));
          }}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="俯仰下调"
          className="absolute bottom-5 left-1/2 flex h-5 w-5 -translate-x-1/2 items-center justify-center text-white/45 transition-colors hover:text-white/80"
          onClick={(e) => {
            e.stopPropagation();
            onPositionChange(horizontal, Math.max(-90, vertical - 12));
          }}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="环绕向左"
          className="absolute left-5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-white/45 transition-colors hover:text-white/80"
          onClick={(e) => {
            e.stopPropagation();
            onPositionChange((horizontal - 12 + 360) % 360, vertical);
          }}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="环绕向右"
          className="absolute right-5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-white/45 transition-colors hover:text-white/80"
          onClick={(e) => {
            e.stopPropagation();
            onPositionChange((horizontal + 12) % 360, vertical);
          }}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  },
);

CameraSphereControl.displayName = "CameraSphereControl";
