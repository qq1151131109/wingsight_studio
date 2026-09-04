"use client";

/**
 * 光位球控（移植自 references/open-storyboard-canvas LightingSphereControl.tsx）：
 * Canvas 2D 暗球 + 光锥径向渐变 + 主体预览/人形剪影占位 + 光源点辉光。
 * 方位角 0=正面 90=右侧，俯仰 -90..90。适配：补上原版缺失的 DPR 适配。
 */

import { memo, useCallback, useRef, useEffect } from "react";

export interface LightAngles {
  azimuth: number;
  elevation: number;
}

function drawLightSphere(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  azimuth: number,
  elevation: number,
  previewImageUrl: string | null | undefined,
  viewMode: "perspective" | "front",
) {
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 4;

  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = "#14110d";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();

  const azRad = (azimuth * Math.PI) / 180;
  const elRad = (elevation * Math.PI) / 180;

  const lightX =
    viewMode === "front"
      ? cx + R * Math.sin(azRad) * 0.85
      : cx + R * Math.sin(azRad) * Math.cos(elRad);
  const lightY =
    viewMode === "front"
      ? cy - R * Math.sin(elRad) * 0.85
      : cy - R * Math.sin(elRad);

  // 光锥：以光源为圆心的暖色径向渐变
  const gradRadius = R * 1.4;
  const grad = ctx.createRadialGradient(lightX, lightY, 0, lightX, lightY, gradRadius);
  grad.addColorStop(0, "rgba(255,255,240,0.55)");
  grad.addColorStop(0.35, "rgba(255,230,180,0.18)");
  grad.addColorStop(0.7, "rgba(255,200,100,0.05)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  if (viewMode === "front") {
    for (let i = -2; i <= 2; i++) {
      const x = cx + i * (R / 3);
      ctx.beginPath();
      ctx.moveTo(x, cy - R);
      ctx.lineTo(x, cy + R);
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
    for (let i = -2; i <= 2; i++) {
      const y = cy + i * (R / 3);
      ctx.beginPath();
      ctx.moveTo(cx - R, y);
      ctx.lineTo(cx + R, y);
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
  } else {
    for (let lat = -75; lat <= 75; lat += 15) {
      const latRad = (lat * Math.PI) / 180;
      const r = R * Math.cos(latRad);
      const baseY = cy - R * Math.sin(latRad);
      ctx.beginPath();
      ctx.ellipse(cx, baseY, r, r * 0.22, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      ctx.beginPath();
      ctx.ellipse(cx, cy, R * Math.abs(Math.cos(angle)), R, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
  }

  if (previewImageUrl) {
    const img = new Image();
    img.onload = () => {
      const iw = R * 0.5;
      const ih = R * 0.75;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.8)";
      ctx.shadowBlur = 12;
      ctx.drawImage(img, cx - iw / 2, cy - ih / 2, iw, ih);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - iw / 2, cy - ih / 2, iw, ih);
      ctx.restore();
    };
    img.src = previewImageUrl;
  } else {
    // 人形剪影占位（头 + 身）
    const iw = R * 0.42;
    const ih = R * 0.65;
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.fillRect(cx - iw / 2, cy - ih / 2, iw, ih);
    ctx.strokeRect(cx - iw / 2, cy - ih / 2, iw, ih);
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    const headR = iw * 0.18;
    ctx.beginPath();
    ctx.arc(cx, cy - ih / 2 + headR + 4, headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - iw * 0.15, cy - ih / 2 + headR * 2 + 6, iw * 0.3, ih * 0.35);
  }

  ctx.restore();

  // 光源点：辉光 + 白点
  const glowGrad = ctx.createRadialGradient(lightX, lightY, 0, lightX, lightY, 14);
  glowGrad.addColorStop(0, "rgba(255,245,200,0.95)");
  glowGrad.addColorStop(0.4, "rgba(255,220,120,0.5)");
  glowGrad.addColorStop(1, "rgba(255,200,50,0)");
  ctx.beginPath();
  ctx.fillStyle = glowGrad;
  ctx.arc(lightX, lightY, 14, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(lightX, lightY, 5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fill();
}

interface LightingSphereControlProps {
  azimuth: number;
  elevation: number;
  onAngleChange: (azimuth: number, elevation: number) => void;
  previewImageUrl?: string | null;
  viewMode?: "perspective" | "front";
}

export const LightingSphereControl = memo(
  ({
    azimuth,
    elevation,
    onAngleChange,
    previewImageUrl,
    viewMode = "perspective",
  }: LightingSphereControlProps) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const isDraggingRef = useRef(false);
    const dragStartRef = useRef<{ x: number; y: number; az: number; el: number } | null>(null);

    const SIZE = 190;

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
      drawLightSphere(ctx, SIZE, SIZE, azimuth, elevation, previewImageUrl, viewMode);
    }, [azimuth, elevation, previewImageUrl, viewMode]);

    useEffect(() => {
      redraw();
    }, [redraw]);

    const handlePointerDown = useCallback(
      (e: React.PointerEvent) => {
        e.preventDefault();
        isDraggingRef.current = true;
        dragStartRef.current = { x: e.clientX, y: e.clientY, az: azimuth, el: elevation };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      },
      [azimuth, elevation],
    );

    const handlePointerMove = useCallback(
      (e: React.PointerEvent) => {
        if (!isDraggingRef.current || !dragStartRef.current) return;
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        let newAz = (dragStartRef.current.az + dx * 1.5) % 360;
        if (newAz < 0) newAz += 360;
        const newEl = Math.max(-90, Math.min(90, dragStartRef.current.el - dy));
        onAngleChange(Math.round(newAz), Math.round(newEl));
      },
      [onAngleChange],
    );

    const handlePointerUp = useCallback((e: React.PointerEvent) => {
      isDraggingRef.current = false;
      dragStartRef.current = null;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    }, []);

    return (
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
    );
  },
);

LightingSphereControl.displayName = "LightingSphereControl";
