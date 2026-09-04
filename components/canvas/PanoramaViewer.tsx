"use client";

/**
 * 全景环视查看器（doc/image-panorama-spec.md §2.5）：photo-sphere-viewer
 * 等距柱状球形查看（~106KB，竞品 open-storyboard 同款选型）。只经 Lightbox
 * 动态 import 懒加载，不进主 bundle。加载前校验 2:1（±8% 容差，竞品同款），
 * 偏离时顶部横条明示——不本地裁切掰比例（铁律：明报不静默修正）。
 */
import { useEffect, useRef, useState } from "react";
import { Viewer } from "@photo-sphere-viewer/core";
import "@photo-sphere-viewer/core/index.css";

export default function PanoramaViewer({ src }: { src: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [warn, setWarn] = useState("");
  const [failed, setFailed] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let viewer: Viewer | null = null;
    let destroyed = false;
    // 比例校验：非 2:1 明示可看（生成端已显式请求 2:1，偏离属通道异常）
    const check = new Image();
    check.onload = () => {
      if (destroyed) return;
      const r = check.naturalWidth / check.naturalHeight;
      if (r > 0 && Math.abs(r - 2) / 2 > 0.08)
        setWarn(
          `生成结果非 2:1（实际 ${r.toFixed(2)}:1），环视可能失真，建议重新生成`,
        );
    };
    check.src = src;
    try {
      viewer = new Viewer({
        container: host,
        panorama: src,
        navbar: false,
        minFov: 25,
        maxFov: 110,
        mousewheel: true,
        moveInertia: false,
        defaultZoomLvl: 50,
      });
    } catch (e) {
      // 同步 setState 会触发 React Compiler 的级联渲染规则——微任务里落
      const msg = e instanceof Error ? e.message : String(e);
      queueMicrotask(() => {
        if (!destroyed) setFailed(msg);
      });
    }
    return () => {
      destroyed = true;
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
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
